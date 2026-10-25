/**
 * Normalized upstream failure classes.
 *
 * Retryable (try the next endpoint/model): rate limits, timeouts, 5xx, connection
 * errors, and endpoint-specific misconfiguration (upstream 401/403/404 mean *our*
 * credential or model slug is wrong for that provider — another provider may well
 * serve the request). Client errors (400/413/422…) are never retried: the same
 * request would fail everywhere.
 */
export type ErrorKind =
  | 'bad_request'
  | 'auth'
  | 'not_found'
  | 'rate_limit'
  | 'timeout'
  | 'server'
  | 'network'
  | 'circuit_open'
  | 'aborted';

const RETRYABLE: ReadonlySet<ErrorKind> = new Set([
  'auth',
  'not_found',
  'rate_limit',
  'timeout',
  'server',
  'network',
  'circuit_open',
]);

/** Kinds that count against an endpoint's health (client errors and aborts do not). */
const ENDPOINT_FAULT: ReadonlySet<ErrorKind> = new Set([
  'auth',
  'not_found',
  'rate_limit',
  'timeout',
  'server',
  'network',
]);

export class ProviderError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly code?: string;

  constructor(
    readonly provider: string,
    readonly kind: ErrorKind,
    message: string,
    opts: { status?: number; retryAfterMs?: number; code?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ProviderError';
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.code = opts.code;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }

  get endpointFault(): boolean {
    return ENDPOINT_FAULT.has(this.kind);
  }
}

export function kindForStatus(status: number): ErrorKind {
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server'; // includes Anthropic's 529 "overloaded"
  return 'bad_request';
}

/** Parse a `Retry-After` header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Best-effort extraction of a human message from an upstream error body. */
export function extractErrorMessage(text: string): { message: string; code?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { message: '' };
  try {
    const j = JSON.parse(trimmed) as Record<string, unknown>;
    const errField = Array.isArray(j) ? (j[0] as Record<string, unknown>)?.error : j.error;
    if (errField && typeof errField === 'object') {
      const e = errField as Record<string, unknown>;
      const message = typeof e.message === 'string' ? e.message : JSON.stringify(e).slice(0, 300);
      const code =
        typeof e.code === 'string'
          ? e.code
          : typeof e.type === 'string'
            ? e.type
            : typeof e.status === 'string'
              ? e.status
              : undefined;
      return { message, code };
    }
    if (typeof errField === 'string') return { message: errField };
    if (typeof j.message === 'string') return { message: j.message };
    if (typeof j.detail === 'string') return { message: j.detail };
  } catch {}
  return { message: trimmed.slice(0, 300) };
}

/** Convert anything thrown by fetch/stream reading into a ProviderError. */
export function toProviderError(provider: string, err: unknown, signal?: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof ProviderError) return reason;
    return new ProviderError(provider, 'aborted', 'Request aborted', { cause: err });
  }
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
    return new ProviderError(provider, 'timeout', `Upstream ${provider} timed out`, { cause: err });
  }
  const detail = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
  return new ProviderError(provider, 'network', `Connection to ${provider} failed: ${detail}`, {
    cause: err,
  });
}
