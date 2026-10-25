/**
 * In-process sliding-window limiter. Good enough for a single replica; swap for
 * Redis when running multiple replicas behind a load balancer.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly windowMs = 60_000) {}

  take(key: string, limit: number, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 50_000) this.sweep(cutoff);
    return true;
  }

  private sweep(cutoff: number) {
    for (const [k, arr] of this.hits) if (!arr.some((t) => t > cutoff)) this.hits.delete(k);
  }
}
