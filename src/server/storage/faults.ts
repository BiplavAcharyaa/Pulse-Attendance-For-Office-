// Test-only fault injection hook for the storage layer. Production code never sets it.
export const faults: { failNext: NodeJS.ErrnoException | null; failOps: Set<string> | null } = {
  failNext: null,
  failOps: null,
};

export function maybeFail(op: string): void {
  if (faults.failNext && (!faults.failOps || faults.failOps.has(op))) {
    const e = faults.failNext;
    faults.failNext = null;
    throw e;
  }
}
