import { PulseError } from '../errors';

export interface ProtectedCollection<T> {
  label: string;
  key: string;
  select: (doc: T) => ReadonlyArray<object>;
}

export function protectRecords<T>(collections: Array<ProtectedCollection<T>>): (before: T, after: T) => void {
  return (before, after) => {
    for (const c of collections) {
      const kept = new Set(c.select(after).map((r) => String((r as Record<string, unknown>)[c.key])));
      for (const r of c.select(before)) {
        const id = String((r as Record<string, unknown>)[c.key]);
        if (!kept.has(id)) {
          throw new PulseError('DATA_PROTECTED', `${c.label} records are never permanently deleted. Archive "${id}" instead.`, 409);
        }
      }
    }
  };
}
