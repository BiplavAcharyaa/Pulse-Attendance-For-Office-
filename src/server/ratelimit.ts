/** Sliding-window counter keyed by string. Used for failed-auth and registration throttling. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    public max: number,
    public windowMs: number,
  ) {}

  private prune(key: string, now: number): number[] {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length) this.hits.set(key, arr);
    else this.hits.delete(key);
    if (this.hits.size > 5000) {
      for (const k of this.hits.keys()) {
        const a = this.hits.get(k)!;
        if (!a.length || now - a[a.length - 1] >= this.windowMs) this.hits.delete(k);
      }
    }
    return arr;
  }

  /** Records a hit; returns whether the caller is still within the limit. */
  hit(key: string, now: number): { allowed: boolean; retryAfterMs: number } {
    const arr = this.prune(key, now);
    if (arr.length >= this.max) return { allowed: false, retryAfterMs: Math.max(0, this.windowMs - (now - arr[0])) };
    arr.push(now);
    this.hits.set(key, arr);
    return { allowed: true, retryAfterMs: 0 };
  }

  blocked(key: string, now: number): { blocked: boolean; retryAfterMs: number } {
    const arr = this.prune(key, now);
    if (arr.length >= this.max) return { blocked: true, retryAfterMs: Math.max(0, this.windowMs - (now - arr[0])) };
    return { blocked: false, retryAfterMs: 0 };
  }

  record(key: string, now: number): void {
    const arr = this.prune(key, now);
    arr.push(now);
    this.hits.set(key, arr);
  }

  clear(key: string): void {
    this.hits.delete(key);
  }
}
