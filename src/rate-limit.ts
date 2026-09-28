/**
 * Per-session event limit over a sliding window. Per session so that one very
 * busy session does not starve the others; with a key cap to bound memory.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit = 1000,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 4096,
  ) {}

  /** true if the event is accepted. */
  allow(key: string, now: number): boolean {
    const cutoff = now - this.windowMs;
    let times = this.hits.get(key);
    if (!times) {
      if (this.hits.size >= this.maxKeys) this.prune(cutoff);
      if (this.hits.size >= this.maxKeys) {
        const first = this.hits.keys().next().value;
        if (first !== undefined) this.hits.delete(first);
      }
      times = [];
      this.hits.set(key, times);
    }
    while (times.length > 0 && (times[0] ?? 0) <= cutoff) times.shift();
    if (times.length >= this.limit) return false;
    times.push(now);
    return true;
  }

  private prune(cutoff: number): void {
    for (const [key, times] of this.hits) {
      if (times.length === 0 || (times[times.length - 1] ?? 0) <= cutoff) this.hits.delete(key);
    }
  }
}
