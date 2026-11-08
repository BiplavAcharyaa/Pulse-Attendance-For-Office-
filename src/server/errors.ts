export class PulseError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'PulseError';
  }
}

export type StorageCode = 'STORAGE_FULL' | 'STORAGE_ERROR' | 'STORAGE_CORRUPT' | 'SCHEMA_TOO_NEW';

export class StorageError extends PulseError {
  constructor(code: StorageCode, message: string, public readonly origin?: unknown) {
    super(code, message, code === 'STORAGE_FULL' ? 507 : 500);
    this.name = 'StorageError';
  }
}

/** Maps a low-level fs error to a StorageError (disk-full is called out explicitly). */
export function toStorageError(err: unknown, what: string): StorageError {
  if (err instanceof StorageError) return err;
  const e = err as NodeJS.ErrnoException;
  if (e && (e.code === 'ENOSPC' || e.code === 'EDQUOT' || e.code === 'EFBIG')) {
    return new StorageError('STORAGE_FULL', `Disk is full while ${what}`, err);
  }
  return new StorageError('STORAGE_ERROR', `Storage error while ${what}: ${e?.message ?? String(err)}`, err);
}

export function isPulseError(e: unknown): e is PulseError {
  return e instanceof PulseError;
}
