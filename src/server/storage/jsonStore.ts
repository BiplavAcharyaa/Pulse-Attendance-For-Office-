import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StorageError, toStorageError } from '../errors';
import { exists, writeFileAtomic } from './atomic';
import { Mutex } from './mutex';

export class SchemaTooNewError extends StorageError {
  constructor(file: string, found: number, supported: number) {
    super('SCHEMA_TOO_NEW', `${path.basename(file)} uses schema v${found}, but this build only supports v${supported}. Update PULSE.`);
  }
}

export interface JsonStoreOptions<T extends { schemaVersion: number }> {
  file: string;
  currentVersion: number;
  defaults: () => T;
  /** Validates (and normalizes) a parsed document of the current version. Throws on invalid data. */
  validate: (raw: unknown) => T;
  /** Optional step migrations keyed by the version they upgrade FROM. */
  migrations?: Record<number, (raw: any) => any>;
  /** Optional invariant checked against every update before it is persisted; throws to reject the change. */
  guard?: (before: T, after: T) => void;
}

export interface RecoveryNote {
  level: 'info' | 'warning' | 'critical';
  message: string;
}

/**
 * Single-document JSON store with serialized, crash-safe writes, one backup generation,
 * schema versioning and corruption quarantine.
 */
export class JsonStore<T extends { schemaVersion: number }> {
  private current!: T;
  private readonly mutex = new Mutex();
  readonly notes: RecoveryNote[] = [];

  constructor(private readonly opts: JsonStoreOptions<T>) {}

  get file(): string {
    return this.opts.file;
  }

  get data(): Readonly<T> {
    return this.current;
  }

  private parse(text: string): T {
    let raw: any = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null || typeof raw.schemaVersion !== 'number') {
      throw new Error('missing schemaVersion');
    }
    if (raw.schemaVersion > this.opts.currentVersion) {
      throw new SchemaTooNewError(this.opts.file, raw.schemaVersion, this.opts.currentVersion);
    }
    while (raw.schemaVersion < this.opts.currentVersion) {
      const step = this.opts.migrations?.[raw.schemaVersion];
      if (!step) throw new Error(`no migration from schema v${raw.schemaVersion}`);
      raw = step(raw);
    }
    return this.opts.validate(raw);
  }

  async load(): Promise<void> {
    const { file } = this.opts;
    const base = path.basename(file);
    await fs.rm(`${file}.tmp`, { force: true }).catch(() => undefined);

    const tryRead = async (p: string): Promise<T | 'missing' | Error> => {
      if (!(await exists(p))) return 'missing';
      try {
        return this.parse(await fs.readFile(p, 'utf8'));
      } catch (e) {
        if (e instanceof SchemaTooNewError) throw e;
        return e as Error;
      }
    };

    const main = await tryRead(file);
    if (main !== 'missing' && !(main instanceof Error)) {
      this.current = main;
      return;
    }

    const bak = await tryRead(`${file}.bak`);

    if (main instanceof Error) {
      const quarantine = `${file}.corrupt-${Date.now()}`;
      await fs.rename(file, quarantine).catch(() => undefined);
      this.notes.push({
        level: 'warning',
        message: `${base} was unreadable (${main.message}); the damaged file was preserved as ${path.basename(quarantine)}.`,
      });
    }

    if (bak !== 'missing' && !(bak instanceof Error)) {
      this.current = bak;
      this.notes.push({
        level: 'warning',
        message: `${base} was restored from its last good backup copy. The most recent change may need to be re-entered.`,
      });
      await writeFileAtomic(file, JSON.stringify(bak, null, 2), { keepBackup: false });
      return;
    }

    if (main === 'missing' && bak === 'missing') {
      this.current = this.opts.defaults();
      await writeFileAtomic(file, JSON.stringify(this.current, null, 2));
      return;
    }

    // Damaged and no usable backup: start from defaults but make the situation very visible.
    this.current = this.opts.defaults();
    this.notes.push({
      level: 'critical',
      message: `${base} and its backup could not be read. PULSE started with an empty ${base}. Restore from a backup copy of the data folder.`,
    });
    await writeFileAtomic(file, JSON.stringify(this.current, null, 2));
  }

  /**
   * Applies `mutator` to a private copy, validates, persists atomically, and only then publishes it.
   * If persistence fails the in-memory data stays unchanged.
   */
  async update<R>(mutator: (draft: T) => R | Promise<R>): Promise<R> {
    return this.mutex.run(async () => {
      const draft = structuredClone(this.current);
      const result = await mutator(draft);
      const validated = this.opts.validate(draft);
      this.opts.guard?.(this.current, validated);
      try {
        await writeFileAtomic(this.opts.file, JSON.stringify(validated, null, 2), { keepBackup: true });
      } catch (e) {
        throw toStorageError(e, `saving ${path.basename(this.opts.file)}`);
      }
      this.current = validated;
      return result;
    });
  }

  /** Re-reads the file from disk and reports whether it is still a valid document. */
  async verifyOnDisk(): Promise<{ ok: boolean; problem?: string }> {
    try {
      this.parse(await fs.readFile(this.opts.file, 'utf8'));
      return { ok: true };
    } catch (e) {
      return { ok: false, problem: (e as Error).message };
    }
  }
}
