import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PulseError, StorageError } from '../src/server/errors';
import { JsonStore } from '../src/server/storage/jsonStore';
import { JsonlLog } from '../src/server/storage/jsonl';
import { faults } from '../src/server/storage/faults';
import { SecretStore, filePermissionProtector } from '../src/server/storage/secrets';
import { Mutex } from '../src/server/storage/mutex';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-st-'));
});
afterEach(async () => {
  faults.failNext = null;
  faults.failOps = null;
  await fs.rm(dir, { recursive: true, force: true });
});

interface Doc {
  schemaVersion: number;
  items: string[];
}
const mk = (file = path.join(dir, 'doc.json')) =>
  new JsonStore<Doc>({
    file,
    currentVersion: 1,
    defaults: () => ({ schemaVersion: 1, items: [] }),
    validate: (raw) => {
      const r = raw as Doc;
      if (!Array.isArray(r.items)) throw new Error('items missing');
      return r;
    },
  });

describe('JsonStore', () => {
  it('creates defaults, persists updates atomically and reloads', async () => {
    const s = mk();
    await s.load();
    await s.update((d) => void d.items.push('a'));
    await s.update((d) => void d.items.push('b'));
    const s2 = mk();
    await s2.load();
    expect(s2.data.items).toEqual(['a', 'b']);
    await expect(fs.access(path.join(dir, 'doc.json.tmp'))).rejects.toThrow();
  });

  it('serializes concurrent updates without losing writes', async () => {
    const s = mk();
    await s.load();
    await Promise.all(Array.from({ length: 50 }, (_, i) => s.update((d) => void d.items.push(String(i)))));
    expect(s.data.items).toHaveLength(50);
    const s2 = mk();
    await s2.load();
    expect(s2.data.items).toHaveLength(50);
  });

  it('falls back to the backup when the main file is corrupt and preserves the damaged copy', async () => {
    const s = mk();
    await s.load();
    await s.update((d) => void d.items.push('one'));
    await s.update((d) => void d.items.push('two')); // .bak now holds ['one']
    await fs.writeFile(path.join(dir, 'doc.json'), '{ not json');
    const s2 = mk();
    await s2.load();
    expect(s2.data.items).toEqual(['one']);
    expect(s2.notes.some((n) => /restored/.test(n.message))).toBe(true);
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.startsWith('doc.json.corrupt-'))).toBe(true);
  });

  it('flags a critical note when both main and backup are unreadable', async () => {
    const s = mk();
    await s.load();
    await s.update((d) => void d.items.push('x'));
    await fs.writeFile(path.join(dir, 'doc.json'), 'garbage');
    await fs.writeFile(path.join(dir, 'doc.json.bak'), 'garbage');
    const s2 = mk();
    await s2.load();
    expect(s2.notes.some((n) => n.level === 'critical')).toBe(true);
    expect(s2.data.items).toEqual([]);
  });

  it('refuses a file written by a newer schema instead of quarantining it', async () => {
    await fs.writeFile(path.join(dir, 'doc.json'), JSON.stringify({ schemaVersion: 9, items: [] }));
    await expect(mk().load()).rejects.toMatchObject({ code: 'SCHEMA_TOO_NEW' });
    expect((await fs.readdir(dir)).some((f) => f.includes('corrupt'))).toBe(false);
  });

  it('keeps in-memory data unchanged when the disk is full', async () => {
    const s = mk();
    await s.load();
    await s.update((d) => void d.items.push('kept'));
    faults.failNext = Object.assign(new Error('no space'), { code: 'ENOSPC' });
    await expect(s.update((d) => void d.items.push('lost'))).rejects.toMatchObject({ code: 'STORAGE_FULL' });
    expect(s.data.items).toEqual(['kept']);
    const s2 = mk();
    await s2.load();
    expect(s2.data.items).toEqual(['kept']);
  });

  it('removes stale temp files from an interrupted write on startup', async () => {
    const s = mk();
    await s.load();
    await fs.writeFile(path.join(dir, 'doc.json.tmp'), 'half written');
    await mk().load();
    await expect(fs.access(path.join(dir, 'doc.json.tmp'))).rejects.toThrow();
  });
});

describe('JsonlLog', () => {
  const key = randomBytes(32);
  const file = () => path.join(dir, 'log.jsonl');
  type B = { id: string; v: number; msg: string };

  it('appends durable, chained records and reloads them', async () => {
    const log = new JsonlLog<B>(file(), key);
    await log.load();
    for (let i = 0; i < 5; i++) await log.append({ id: `e${i}`, v: 1, msg: `m${i}` });
    await log.close();
    const again = new JsonlLog<B>(file(), key);
    await again.load();
    expect(again.count).toBe(5);
    expect(again.records.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(again.loadProblems).toEqual([]);
    expect((await again.verifyFromDisk()).ok).toBe(true);
    await again.close();
  });

  it('assigns unique, gap-free sequence numbers under concurrent appends', async () => {
    const log = new JsonlLog<B>(file(), key);
    await log.load();
    await Promise.all(Array.from({ length: 100 }, (_, i) => log.append({ id: `c${i}`, v: 1, msg: 'x' })));
    expect(new Set(log.records.map((r) => r.seq)).size).toBe(100);
    expect((await log.verifyFromDisk()).ok).toBe(true);
    await log.close();
  });

  it('recovers from an interrupted write (torn final line) without losing acknowledged records', async () => {
    const log = new JsonlLog<B>(file(), key);
    await log.load();
    await log.append({ id: 'a', v: 1, msg: 'ok' });
    await log.append({ id: 'b', v: 1, msg: 'ok' });
    await log.close();
    await fs.appendFile(file(), '{"id":"c","v":1,"msg":"tor'); // crash mid-write, no newline
    const rec = new JsonlLog<B>(file(), key);
    await rec.load();
    expect(rec.count).toBe(2);
    expect(rec.recoveryNotes.join(' ')).toMatch(/interrupted write/);
    expect((await fs.readdir(dir)).some((f) => f.startsWith('log.jsonl.torn-'))).toBe(true);
    await rec.append({ id: 'd', v: 1, msg: 'after recovery' });
    expect((await rec.verifyFromDisk()).ok).toBe(true);
    await rec.close();
  });

  it('detects modified, deleted and corrupted records', async () => {
    const log = new JsonlLog<B>(file(), key);
    await log.load();
    for (let i = 0; i < 4; i++) await log.append({ id: `t${i}`, v: 1, msg: `m${i}` });
    await log.close();
    const lines = (await fs.readFile(file(), 'utf8')).trim().split('\n');

    // modify content of record 2
    const edited = [...lines];
    edited[1] = edited[1].replace('m1', 'EDIT');
    await fs.writeFile(file(), edited.join('\n') + '\n');
    let l = new JsonlLog<B>(file(), key);
    await l.load();
    expect(l.loadProblems.join(' ')).toMatch(/modified after writing/);
    await l.close();

    // delete record 2
    await fs.writeFile(file(), [lines[0], lines[2], lines[3]].join('\n') + '\n');
    l = new JsonlLog<B>(file(), key);
    await l.load();
    expect(l.loadProblems.join(' ')).toMatch(/sequence gap|chain break/);
    await l.close();

    // corrupt JSON
    await fs.writeFile(file(), [lines[0], '{{{{', lines[2]].join('\n') + '\n');
    l = new JsonlLog<B>(file(), key);
    await l.load();
    expect(l.loadProblems.join(' ')).toMatch(/unreadable/);
    await l.close();
  });

  it('a different key cannot produce a valid chain (edits without the key are detectable)', async () => {
    const log = new JsonlLog<B>(file(), key);
    await log.load();
    await log.append({ id: 'a', v: 1, msg: 'x' });
    await log.close();
    const other = new JsonlLog<B>(file(), randomBytes(32));
    await other.load();
    expect(other.loadProblems.length).toBeGreaterThan(0);
    await other.close();
  });

  it('disk-full during append: throws STORAGE_FULL, leaves the file clean, and recovers afterwards', async () => {
    const log = new JsonlLog<B>(file(), key);
    await log.load();
    await log.append({ id: 'a', v: 1, msg: 'ok' });
    const before = await fs.readFile(file(), 'utf8');
    faults.failNext = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    await expect(log.append({ id: 'b', v: 1, msg: 'x' })).rejects.toBeInstanceOf(StorageError);
    expect(await fs.readFile(file(), 'utf8')).toBe(before);
    expect(log.count).toBe(1);
    await log.append({ id: 'c', v: 1, msg: 'after' });
    expect(log.count).toBe(2);
    expect((await log.verifyFromDisk()).ok).toBe(true);
    await log.close();
  });
});

describe('SecretStore & Mutex', () => {
  it('generates keys once and reloads them', async () => {
    const f = path.join(dir, 'sec', 'host-secrets.json');
    const a = new SecretStore(f, filePermissionProtector);
    await a.load();
    const b = new SecretStore(f, filePermissionProtector);
    await b.load();
    expect(b.data.hmacKey).toBe(a.data.hmacKey);
    expect(b.data.integrityKey).not.toBe(b.data.hmacKey);
  });

  it('refuses to open a file written with different protection', async () => {
    const f = path.join(dir, 'host-secrets.json');
    await new SecretStore(f, filePermissionProtector).load();
    const dpapi = { name: 'os-protected' as const, encrypt: (b: Buffer) => b, decrypt: (b: Buffer) => b };
    await expect(new SecretStore(f, dpapi).load()).rejects.toThrow(/protection/);
  });

  it('Mutex runs critical sections one at a time in order', async () => {
    const m = new Mutex();
    const order: number[] = [];
    await Promise.all([0, 1, 2, 3].map((i) => m.run(async () => { await new Promise((r) => setTimeout(r, 10 - i * 2)); order.push(i); })));
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('PulseError carries code and status', () => {
    const e = new PulseError('X', 'msg', 418);
    expect([e.code, e.status]).toEqual(['X', 418]);
  });
});
