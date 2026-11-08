import { createHmac, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ChainFields } from '../../shared/types';
import { toStorageError } from '../errors';
import { canonicalJson } from './canonical';
import { maybeFail } from './faults';
import { Mutex } from './mutex';

export const GENESIS_HASH = '0'.repeat(64);

type Rec<B> = B & ChainFields;

export interface ParseResult<B> {
  records: Array<Rec<B>>;
  problems: string[];
  lastHash: string;
  lastSeq: number;
  /** byte offset of the end of the last complete line */
  completeBytes: number;
  tornBytes: number;
}

function computeHash(key: Buffer, body: object): string {
  return createHmac('sha256', key).update(canonicalJson(body)).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Pure parse + chain verification of a JSONL buffer. */
export function parseChain<B extends object>(buf: Buffer, key: Buffer): ParseResult<B> {
  const records: Array<Rec<B>> = [];
  const problems: string[] = [];
  let lastHash = GENESIS_HASH;
  let lastSeq = 0;

  const lastNl = buf.lastIndexOf(0x0a);
  const completeBytes = lastNl + 1;
  const tornBytes = buf.length - completeBytes;
  const text = buf.subarray(0, completeBytes).toString('utf8');
  const lines = text.length ? text.split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    if (line.trim() === '') {
      problems.push(`line ${lineNo}: blank line`);
      return;
    }
    let rec: Rec<B>;
    try {
      rec = JSON.parse(line) as Rec<B>;
      if (typeof rec !== 'object' || rec === null) throw new Error('not an object');
    } catch {
      problems.push(`line ${lineNo}: unreadable record (corrupted JSON) — record skipped`);
      return;
    }
    if (typeof rec.seq !== 'number' || typeof rec.hash !== 'string' || typeof rec.prevHash !== 'string') {
      problems.push(`line ${lineNo}: record is missing chain fields`);
      return;
    }
    if (rec.seq !== lastSeq + 1) problems.push(`line ${lineNo}: sequence gap (expected ${lastSeq + 1}, found ${rec.seq})`);
    if (rec.prevHash !== lastHash) problems.push(`line ${lineNo}: chain break (previous record missing or altered)`);
    const { hash, ...rest } = rec as ChainFields & Record<string, unknown>;
    if (!safeEqualHex(computeHash(key, rest), hash)) {
      problems.push(`line ${lineNo}: record content does not match its integrity hash (modified after writing)`);
    }
    records.push(rec);
    lastHash = rec.hash;
    lastSeq = rec.seq;
  });

  return { records, problems, lastHash, lastSeq, completeBytes, tornBytes };
}

/**
 * Append-only, hash-chained JSON Lines log. Every append is fsynced before it resolves, so a caller that
 * has been told "saved" can rely on the record being on disk.
 *
 * The chain is an HMAC over each record plus the previous hash. It DETECTS accidental corruption and
 * edits made without the host's integrity key; it cannot PREVENT someone with full access to the host
 * (and its key store) from rewriting the file.
 */
export class JsonlLog<B extends { id: string }> {
  private readonly mutex = new Mutex();
  private handle: fs.FileHandle | null = null;
  private size = 0;
  private lastHash = GENESIS_HASH;
  private lastSeq = 0;
  readonly records: Array<Rec<B>> = [];
  readonly loadProblems: string[] = [];
  readonly recoveryNotes: string[] = [];

  constructor(
    readonly file: string,
    private readonly key: Buffer,
  ) {}

  get count(): number {
    return this.records.length;
  }

  async load(): Promise<void> {
    let buf: Buffer;
    try {
      buf = await fs.readFile(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw toStorageError(e, `reading ${path.basename(this.file)}`);
      buf = Buffer.alloc(0);
    }

    const parsed = parseChain<B>(buf, this.key);
    if (parsed.tornBytes > 0) {
      // A write was interrupted before its newline. The record was never acknowledged, so it is
      // preserved for inspection and removed from the live log.
      const tornFile = `${this.file}.torn-${Date.now()}`;
      await fs.writeFile(tornFile, buf.subarray(parsed.completeBytes), { mode: 0o600 });
      await fs.truncate(this.file, parsed.completeBytes);
      this.recoveryNotes.push(
        `${path.basename(this.file)}: recovered from an interrupted write; ${parsed.tornBytes} unacknowledged bytes were preserved in ${path.basename(tornFile)}.`,
      );
    }

    this.records.length = 0;
    this.records.push(...parsed.records);
    this.loadProblems.length = 0;
    this.loadProblems.push(...parsed.problems);
    this.lastHash = parsed.lastHash;
    this.lastSeq = parsed.lastSeq;

    this.handle = await fs.open(this.file, 'a', 0o600);
    this.size = (await this.handle.stat()).size;
  }

  async append(body: B): Promise<Rec<B>> {
    return this.mutex.run(async () => {
      if (!this.handle) throw new Error('log not loaded');
      const seq = this.lastSeq + 1;
      const chainInput = { ...body, seq, prevHash: this.lastHash };
      const rec = { ...chainInput, hash: computeHash(this.key, chainInput) } as unknown as Rec<B>;
      const line = Buffer.from(JSON.stringify(rec) + '\n', 'utf8');
      try {
        maybeFail('append');
        const { bytesWritten } = await this.handle.write(line, 0, line.length, null);
        if (bytesWritten !== line.length) throw Object.assign(new Error('short write'), { code: 'ENOSPC' });
        await this.handle.sync();
      } catch (err) {
        // Roll back any partial bytes so the file never contains an unterminated record.
        await this.handle.truncate(this.size).catch(() => undefined);
        throw toStorageError(err, `appending to ${path.basename(this.file)}`);
      }
      this.size += line.length;
      this.lastHash = rec.hash;
      this.lastSeq = seq;
      this.records.push(rec);
      return rec;
    });
  }

  /** Re-reads the file from disk and verifies the whole chain (detects edits made since startup). */
  async verifyFromDisk(): Promise<{ records: number; ok: boolean; problems: string[] }> {
    let buf: Buffer;
    try {
      buf = await fs.readFile(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { records: 0, ok: false, problems: ['file is missing'] };
      throw toStorageError(e, `reading ${path.basename(this.file)}`);
    }
    const parsed = parseChain<B>(buf, this.key);
    const problems = [...parsed.problems];
    if (parsed.tornBytes > 0) problems.push(`${parsed.tornBytes} bytes of an unterminated record at the end of the file`);
    return { records: parsed.records.length, ok: problems.length === 0, problems };
  }

  async close(): Promise<void> {
    await this.mutex.run(async () => {
      if (this.handle) {
        await this.handle.close().catch(() => undefined);
        this.handle = null;
      }
    });
  }
}
