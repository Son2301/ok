import { AppError } from '@minh/shared';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface JsonRequestInit extends Omit<RequestInit, 'body'> {
  /** Serialised as JSON unless it is already a string/URLSearchParams. */
  body?: unknown;
  timeoutMs?: number;
  /** Label used in error messages, e.g. `KiotViet`. */
  service: string;
}

export class UpstreamError extends AppError {
  constructor(
    readonly service: string,
    readonly httpStatus: number,
    message: string,
    readonly body?: unknown,
  ) {
    super('upstream_error', message, undefined, 502);
  }
}

/** Fetch JSON from a third-party API with a timeout and readable errors (no credentials in messages). */
export async function requestJson<T = unknown>(
  fetchFn: FetchLike,
  url: string,
  init: JsonRequestInit,
): Promise<T> {
  const { body, timeoutMs = 20_000, service, signal, headers, ...rest } = init;
  const h = new Headers(headers);
  let payload: BodyInit | undefined;
  if (body instanceof URLSearchParams) {
    payload = body;
    if (!h.has('content-type')) h.set('content-type', 'application/x-www-form-urlencoded');
  } else if (typeof body === 'string') {
    payload = body;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    if (!h.has('content-type')) h.set('content-type', 'application/json');
  }
  if (!h.has('accept')) h.set('accept', 'application/json');
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetchFn(url, { ...rest, headers: h, body: payload, signal: combined });
  } catch (err) {
    if (timeout.aborted) throw new AppError('timeout', `${service} did not respond within ${timeoutMs}ms`);
    throw new AppError('upstream_error', `${service} request failed: ${(err as Error).message}`);
  }
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {}
  } else parsed = null;
  if (!res.ok) {
    const detail = extractErrorMessage(parsed) ?? text.slice(0, 300);
    throw new UpstreamError(
      service,
      res.status,
      `${service} API error ${res.status}${detail ? `: ${detail}` : ''}`,
      parsed,
    );
  }
  return parsed as T;
}

function extractErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const candidates = [
    b.message,
    b.error_description,
    b.description,
    b.errors,
    b.error,
    (b.responseStatus as Record<string, unknown> | undefined)?.message,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c.slice(0, 300);
    if (c && typeof c === 'object') {
      const m = (c as Record<string, unknown>).message;
      if (typeof m === 'string') return m.slice(0, 300);
      return JSON.stringify(c).slice(0, 300);
    }
  }
  return null;
}

/** Drop undefined/empty values and build a query string. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}
