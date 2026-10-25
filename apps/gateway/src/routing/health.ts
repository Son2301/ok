import type { ErrorKind } from '../providers/errors';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface HealthOptions {
  /** Injectable clock (tests). */
  now?: () => number;
  /** Rolling window for statistics. Default 5 minutes. */
  windowMs?: number;
  /** Hard cap on retained samples per endpoint. */
  maxSamples?: number;
  /** Consecutive endpoint failures that open the circuit. Default 5. */
  failureThreshold?: number;
  /** How long an open circuit rejects traffic before a half-open probe. Default 30s. */
  cooldownMs?: number;
  /** Cap on how long a 429 `Retry-After` may block an endpoint. Default 60s. */
  maxRetryAfterMs?: number;
  /** Success rate below which an endpoint is "degraded" (tried after healthy ones). Default 0.8. */
  degradedSuccessRate?: number;
  /** Samples required before the success rate is trusted. Default 5. */
  minSamples?: number;
}

interface Sample {
  t: number;
  ok: boolean;
  latencyMs?: number;
  ttftMs?: number;
  tps?: number;
}

interface State {
  samples: Sample[];
  consecutiveFailures: number;
  circuit: CircuitState;
  openedAt?: number;
  probeInFlight: boolean;
  blockedUntil?: number;
  lastError?: { at: number; kind: ErrorKind; message?: string };
  lastSuccessAt?: number;
}

export interface SuccessOutcome {
  latencyMs: number;
  ttftMs?: number;
  outputTokens?: number;
}

export interface FailureOutcome {
  kind: ErrorKind;
  message?: string;
  retryAfterMs?: number;
  latencyMs?: number;
}

export interface EndpointHealth {
  endpoint: string;
  requests: number;
  successes: number;
  failures: number;
  successRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  p50TtftMs: number | null;
  p95TtftMs: number | null;
  tokensPerSec: number | null;
  circuit: CircuitState;
  consecutiveFailures: number;
  available: boolean;
  degraded: boolean;
  openedAt: string | null;
  blockedUntil: string | null;
  lastError: { at: string; kind: ErrorKind; message?: string } | null;
  lastSuccessAt: string | null;
}

/** Nearest-rank percentile of an unsorted list. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

/**
 * In-memory rolling-window health per endpoint plus a circuit breaker:
 *   closed ──N consecutive failures──▶ open ──cooldown──▶ half_open (one probe)
 *   half_open ──success──▶ closed      half_open ──failure──▶ open
 * Per-process state; with several replicas each tracks its own view (see README).
 */
export class HealthTracker {
  private readonly states = new Map<string, State>();
  private readonly now: () => number;
  private readonly o: Required<Omit<HealthOptions, 'now'>>;

  constructor(opts: HealthOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.o = {
      windowMs: opts.windowMs ?? 5 * 60_000,
      maxSamples: opts.maxSamples ?? 500,
      failureThreshold: opts.failureThreshold ?? 5,
      cooldownMs: opts.cooldownMs ?? 30_000,
      maxRetryAfterMs: opts.maxRetryAfterMs ?? 60_000,
      degradedSuccessRate: opts.degradedSuccessRate ?? 0.8,
      minSamples: opts.minSamples ?? 5,
    };
  }

  private state(id: string): State {
    let s = this.states.get(id);
    if (!s) {
      s = { samples: [], consecutiveFailures: 0, circuit: 'closed', probeInFlight: false };
      this.states.set(id, s);
    }
    return s;
  }

  private prune(s: State) {
    const cutoff = this.now() - this.o.windowMs;
    let drop = 0;
    while (drop < s.samples.length && s.samples[drop]!.t < cutoff) drop++;
    if (s.samples.length - drop > this.o.maxSamples) drop = s.samples.length - this.o.maxSamples;
    if (drop) s.samples.splice(0, drop);
  }

  /** Side-effect-free: may this endpoint receive traffic right now? */
  isAvailable(id: string): boolean {
    const s = this.states.get(id);
    if (!s) return true;
    const now = this.now();
    if (s.blockedUntil && s.blockedUntil > now) return false;
    if (s.circuit === 'closed') return true;
    if (s.circuit === 'open') return now - (s.openedAt ?? 0) >= this.o.cooldownMs;
    return !s.probeInFlight;
  }

  /** Claim the right to send a request; moves an open circuit past its cooldown into half-open. */
  tryAcquire(id: string): boolean {
    if (!this.isAvailable(id)) return false;
    const s = this.state(id);
    if (s.circuit === 'open') s.circuit = 'half_open';
    if (s.circuit === 'half_open') s.probeInFlight = true;
    return true;
  }

  recordSuccess(id: string, o: SuccessOutcome): void {
    const s = this.state(id);
    const generationMs = o.ttftMs !== undefined ? o.latencyMs - o.ttftMs : o.latencyMs;
    const tps = o.outputTokens && generationMs > 0 ? (o.outputTokens / generationMs) * 1000 : undefined;
    s.samples.push({ t: this.now(), ok: true, latencyMs: o.latencyMs, ttftMs: o.ttftMs, tps });
    s.consecutiveFailures = 0;
    s.circuit = 'closed';
    s.openedAt = undefined;
    s.probeInFlight = false;
    s.lastSuccessAt = this.now();
    this.prune(s);
  }

  recordFailure(id: string, o: FailureOutcome): void {
    const s = this.state(id);
    const now = this.now();
    s.samples.push({ t: now, ok: false, latencyMs: o.latencyMs });
    s.consecutiveFailures++;
    s.lastError = { at: now, kind: o.kind, message: o.message?.slice(0, 200) };
    if (o.retryAfterMs && o.retryAfterMs > 0)
      s.blockedUntil = now + Math.min(o.retryAfterMs, this.o.maxRetryAfterMs);
    if (s.circuit === 'half_open' || s.consecutiveFailures >= this.o.failureThreshold) {
      s.circuit = 'open';
      s.openedAt = now;
    }
    s.probeInFlight = false;
    this.prune(s);
  }

  /**
   * The attempt ended without telling us about endpoint health: a client error
   * (`responded: true` — the endpoint is up) or a client abort (`responded: false`).
   */
  recordNeutral(id: string, { responded }: { responded: boolean }): void {
    const s = this.states.get(id);
    if (!s) return;
    s.probeInFlight = false;
    if (responded) {
      s.consecutiveFailures = 0;
      if (s.circuit === 'half_open') {
        s.circuit = 'closed';
        s.openedAt = undefined;
      }
    }
  }

  isDegraded(id: string): boolean {
    const s = this.states.get(id);
    if (!s) return false;
    this.prune(s);
    if (s.consecutiveFailures >= 2) return true;
    if (s.samples.length < this.o.minSamples) return false;
    const ok = s.samples.filter((x) => x.ok).length;
    return ok / s.samples.length < this.o.degradedSuccessRate;
  }

  stats(id: string): EndpointHealth {
    const s = this.states.get(id);
    if (s) this.prune(s);
    const samples = s?.samples ?? [];
    const okSamples = samples.filter((x) => x.ok);
    const lat = okSamples.map((x) => x.latencyMs).filter((v): v is number => v !== undefined);
    const ttft = okSamples.map((x) => x.ttftMs).filter((v): v is number => v !== undefined);
    const tps = okSamples.map((x) => x.tps).filter((v): v is number => v !== undefined);
    const iso = (t?: number) => (t ? new Date(t).toISOString() : null);
    const p50tps = percentile(tps, 50);
    return {
      endpoint: id,
      requests: samples.length,
      successes: okSamples.length,
      failures: samples.length - okSamples.length,
      successRate: samples.length ? okSamples.length / samples.length : null,
      p50LatencyMs: percentile(lat, 50),
      p95LatencyMs: percentile(lat, 95),
      p50TtftMs: percentile(ttft, 50),
      p95TtftMs: percentile(ttft, 95),
      tokensPerSec: p50tps === null ? null : Math.round(p50tps * 10) / 10,
      circuit: s?.circuit ?? 'closed',
      consecutiveFailures: s?.consecutiveFailures ?? 0,
      available: this.isAvailable(id),
      degraded: this.isDegraded(id),
      openedAt: iso(s?.openedAt),
      blockedUntil: s?.blockedUntil && s.blockedUntil > this.now() ? iso(s.blockedUntil) : null,
      lastError: s?.lastError
        ? { at: iso(s.lastError.at)!, kind: s.lastError.kind, message: s.lastError.message }
        : null,
      lastSuccessAt: iso(s?.lastSuccessAt),
    };
  }
}
