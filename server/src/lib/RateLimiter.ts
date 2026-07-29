/** Simple per-key sliding-window rate limiter (in-memory). */

export class SlidingWindowRateLimiter {
  private timestamps = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the key is within the limit, false if rate-limited. */
  check(key: string): boolean {
    const now = Date.now();
    const recent = (this.timestamps.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.timestamps.set(key, recent);
      return false;
    }
    recent.push(now);
    this.timestamps.set(key, recent);
    return true;
  }
}
