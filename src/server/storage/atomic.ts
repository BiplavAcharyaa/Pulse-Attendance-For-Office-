import * as fs from 'node:fs/promises';
import { constants as fsc } from 'node:fs';
import * as path from 'node:path';
import { toStorageError } from '../errors';
import { maybeFail } from './faults';

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p, fsc.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return; // directories cannot be opened for fsync on Windows
  try {
    const h = await fs.open(dir, 'r');
    try {
      await h.sync();
    } finally {
      await h.close();
    }
  } catch {
    /* best effort */
  }
}

/**
 * Crash-safe replace: write temp file → fsync → keep previous generation as .bak → atomic rename.
 * A reader always sees either the complete old file or the complete new file.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Buffer,
  opts: { mode?: number; keepBackup?: boolean } = {},
): Promise<void> {
  const tmp = `${file}.tmp`;
  try {
    maybeFail('atomic-write');
    const fh = await fs.open(tmp, 'w', opts.mode ?? 0o600);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (opts.keepBackup && (await exists(file))) {
      await fs.copyFile(file, `${file}.bak`);
    }
    await fs.rename(tmp, file);
    await fsyncDir(path.dirname(file));
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw toStorageError(err, `writing ${path.basename(file)}`);
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}
