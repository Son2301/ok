import { describe, expect, it } from 'vitest';
import { HealthTracker, percentile } from './health';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('percentile', () => {
  it('uses nearest rank', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([10, 1, 9, 2, 8, 3, 7, 4, 6, 5], 95)).toBe(10);
  });
});

describe('HealthTracker', () => {
  it('computes success rate, latency/ttft percentiles and throughput over the window', () => {
    const c = clock();
    const h = new HealthTracker({ now: c.now });
    for (let i = 1; i <= 10; i++)
      h.recordSuccess('e', { latencyMs: i * 100, ttftMs: i * 10, outputTokens: 100 });
    h.recordFailure('e', { kind: 'server', message: 'boom' });
    const s = h.stats('e');
    expect(s.requests).toBe(11);
    expect(s.successRate).toBeCloseTo(10 / 11);
    expect(s.p50LatencyMs).toBe(500);
    expect(s.p95LatencyMs).toBe(1000);
    expect(s.p50TtftMs).toBe(50);
    expect(s.tokensPerSec).toBeGreaterThan(0);
    expect(s.lastError).toMatchObject({ kind: 'server', message: 'boom' });
  });

  it('forgets samples older than the rolling window', () => {
    const c = clock();
    const h = new HealthTracker({ now: c.now, windowMs: 60_000 });
    h.recordFailure('e', { kind: 'server' });
    c.advance(30_000);
    h.recordSuccess('e', { latencyMs: 100 });
    expect(h.stats('e').requests).toBe(2);
    c.advance(45_000);
    expect(h.stats('e')).toMatchObject({ requests: 1, successRate: 1 });
  });

  it('opens the circuit after N consecutive failures, probes once after cooldown, closes on success', () => {
    const c = clock();
    const h = new HealthTracker({ now: c.now, failureThreshold: 3, cooldownMs: 10_000 });
    for (let i = 0; i < 2; i++) h.recordFailure('e', { kind: 'server' });
    expect(h.stats('e').circuit).toBe('closed');
    h.recordSuccess('e', { latencyMs: 50 }); // resets the streak
    for (let i = 0; i < 3; i++) h.recordFailure('e', { kind: 'timeout' });
    expect(h.stats('e').circuit).toBe('open');
    expect(h.isAvailable('e')).toBe(false);
    expect(h.tryAcquire('e')).toBe(false);

    c.advance(10_000);
    expect(h.isAvailable('e')).toBe(true); // cooldown elapsed: probe allowed
    expect(h.tryAcquire('e')).toBe(true);
    expect(h.stats('e').circuit).toBe('half_open');
    expect(h.tryAcquire('e')).toBe(false); // only one probe in flight
    h.recordSuccess('e', { latencyMs: 80 });
    expect(h.stats('e').circuit).toBe('closed');
    expect(h.tryAcquire('e')).toBe(true);
  });

  it('re-opens when the half-open probe fails', () => {
    const c = clock();
    const h = new HealthTracker({ now: c.now, failureThreshold: 1, cooldownMs: 5_000 });
    h.recordFailure('e', { kind: 'server' });
    c.advance(5_000);
    expect(h.tryAcquire('e')).toBe(true);
    h.recordFailure('e', { kind: 'server' });
    expect(h.stats('e').circuit).toBe('open');
    expect(h.isAvailable('e')).toBe(false);
    c.advance(4_999);
    expect(h.isAvailable('e')).toBe(false);
    c.advance(1);
    expect(h.isAvailable('e')).toBe(true);
  });

  it('a client error during a probe proves liveness and closes the circuit; an abort just releases the probe', () => {
    const c = clock();
    const h = new HealthTracker({ now: c.now, failureThreshold: 1, cooldownMs: 1_000 });
    h.recordFailure('e', { kind: 'server' });
    c.advance(1_000);
    h.tryAcquire('e');
    h.recordNeutral('e', { responded: false });
    expect(h.stats('e').circuit).toBe('half_open');
    expect(h.tryAcquire('e')).toBe(true);
    h.recordNeutral('e', { responded: true });
    expect(h.stats('e').circuit).toBe('closed');
  });

  it('blocks an endpoint for Retry-After (capped) after a 429', () => {
    const c = clock();
    const h = new HealthTracker({ now: c.now, maxRetryAfterMs: 20_000 });
    h.recordFailure('e', { kind: 'rate_limit', retryAfterMs: 120_000 });
    expect(h.isAvailable('e')).toBe(false);
    expect(h.stats('e').blockedUntil).not.toBeNull();
    c.advance(20_000);
    expect(h.isAvailable('e')).toBe(true);
  });

  it('flags degraded endpoints (low success rate or a failure streak)', () => {
    const h = new HealthTracker({ minSamples: 5 });
    for (let i = 0; i < 3; i++) h.recordSuccess('a', { latencyMs: 10 });
    h.recordFailure('a', { kind: 'server' });
    expect(h.isDegraded('a')).toBe(false);
    h.recordFailure('a', { kind: 'server' });
    expect(h.isDegraded('a')).toBe(true); // streak of 2
    h.recordSuccess('a', { latencyMs: 10 });
    expect(h.isDegraded('a')).toBe(true); // 4/6 < 0.8
    expect(h.isDegraded('unknown')).toBe(false);
  });
});
