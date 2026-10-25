/**
 * HTTP client for the platform services (gateway, agents, safe, review).
 *
 * The console authenticates as a trusted platform service:
 *   Authorization: Bearer $INTERNAL_TOKEN   +   X-Org-Id: <the signed-in org>
 * so the token must never reach the browser. This module is pure (config and
 * fetch are injected) so it can be unit-tested; `lib/services.ts` binds it to
 * the server environment.
 */

export type ServiceName = 'gateway' | 'agents' | 'safe' | 'review';

export interface ServiceErrorInfo {
  service: ServiceName;
  /** `down` = connection refused / DNS / reset; `timeout`; `http` = the service answered with an error. */
  kind: 'down' | 'timeout' | 'http';
  /** HTTP status, 0 when the service could not be reached. */
  status: number;
  /** Platform error code (`payment_required`, `not_found`, …) or `unreachable` / `timeout`. */
  code: string;
  message: string;
  details?: unknown;
}

export class ServiceError extends Error {
  constructor(readonly info: ServiceErrorInfo) {
    super(`${info.service}: ${info.message}`);
    this.name = 'ServiceError';
  }
  get status() {
    return this.info.status;
  }
  get code() {
    return this.info.code;
  }
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: ServiceErrorInfo };

export interface ClientConfig {
  bases: Record<ServiceName, string>;
  internalToken: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export type Query = Record<string, string | number | boolean | null | undefined>;

export interface CallOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Org the call acts for. Required unless `auth: false`. */
  orgId?: string | null;
  /** Send the internal token (default true). Public endpoints (model catalog, public scam check) set false. */
  auth?: boolean;
  query?: Query;
  /** JSON body. */
  body?: unknown;
  /** Multipart body (file uploads). */
  form?: FormData;
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function buildUrl(base: string, path: string, query?: Query): string {
  const url = new URL(path.startsWith('/') ? path : `/${path}`, `${base.replace(/\/+$/, '')}/`);
  // `new URL('/v1/x', 'http://h/prefix/')` drops `/prefix`; keep any path prefix on the base.
  const prefix = new URL(`${base.replace(/\/+$/, '')}/`).pathname.replace(/\/$/, '');
  if (prefix && !url.pathname.startsWith(`${prefix}/`)) url.pathname = `${prefix}${url.pathname}`;
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Parse the platform error envelope `{ error: { code, message, details } }` (or anything else). */
export function parseErrorBody(
  status: number,
  text: string,
): Pick<ServiceErrorInfo, 'code' | 'message' | 'details'> {
  try {
    const json = JSON.parse(text) as { error?: { code?: string; message?: string; details?: unknown } };
    if (json?.error && typeof json.error === 'object') {
      return {
        code: json.error.code ?? `http_${status}`,
        message: json.error.message ?? `HTTP ${status}`,
        details: json.error.details,
      };
    }
  } catch {}
  return { code: `http_${status}`, message: text.trim().slice(0, 300) || `HTTP ${status}` };
}

function isTimeout(err: unknown): boolean {
  const e = err as { name?: string; cause?: { name?: string } };
  return e?.name === 'TimeoutError' || e?.cause?.name === 'TimeoutError';
}

export function createServiceClient(cfg: ClientConfig) {
  const doFetch = cfg.fetch ?? fetch;

  function headersFor(opts: CallOptions): Headers {
    const h = new Headers(opts.headers);
    h.set('accept', h.get('accept') ?? 'application/json');
    if (opts.auth !== false) {
      if (!opts.orgId) throw new Error('orgId is required for authenticated service calls');
      h.set('authorization', `Bearer ${cfg.internalToken}`);
      h.set('x-org-id', opts.orgId);
    }
    if (opts.body !== undefined && !opts.form) h.set('content-type', 'application/json');
    return h;
  }

  /**
   * Low-level call. Resolves with the Response for any HTTP status; throws
   * ServiceError only when the service could not be reached or timed out.
   */
  async function raw(service: ServiceName, path: string, opts: CallOptions = {}): Promise<Response> {
    const url = buildUrl(cfg.bases[service], path, opts.query);
    // Built before the try: a missing org is a programming error, not an outage.
    const headers = headersFor(opts);
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? cfg.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    try {
      return await doFetch(url, {
        method: opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET'),
        headers,
        body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
        signal,
        cache: 'no-store',
      });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (timeout.aborted || isTimeout(err)) {
        throw new ServiceError({
          service,
          kind: 'timeout',
          status: 0,
          code: 'timeout',
          message: `${service} did not answer in time`,
        });
      }
      throw new ServiceError({
        service,
        kind: 'down',
        status: 0,
        code: 'unreachable',
        message: `${service} is unreachable`,
        details:
          err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err),
      });
    }
  }

  /** JSON call that throws ServiceError for non-2xx responses. */
  async function json<T>(service: ServiceName, path: string, opts: CallOptions = {}): Promise<T> {
    const res = await raw(service, path, opts);
    const text = await res.text();
    if (!res.ok) {
      throw new ServiceError({
        service,
        kind: 'http',
        status: res.status,
        ...parseErrorBody(res.status, text),
      });
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ServiceError({
        service,
        kind: 'http',
        status: res.status,
        code: 'bad_response',
        message: `${service} returned invalid JSON`,
      });
    }
  }

  /** Like `json` but never throws for service problems: pages render an error state instead of crashing. */
  async function attempt<T>(service: ServiceName, path: string, opts: CallOptions = {}): Promise<Result<T>> {
    try {
      return { ok: true, data: await json<T>(service, path, opts) };
    } catch (err) {
      if (err instanceof ServiceError) return { ok: false, error: err.info };
      throw err;
    }
  }

  return {
    raw,
    json,
    attempt,
    buildUrl: (s: ServiceName, p: string, q?: Query) => buildUrl(cfg.bases[s], p, q),
  };
}

export type ServiceClient = ReturnType<typeof createServiceClient>;

/** Turn a thrown error into a Result error (for server actions). */
export function toErrorInfo(err: unknown, service: ServiceName): ServiceErrorInfo {
  if (err instanceof ServiceError) return err.info;
  return {
    service,
    kind: 'http',
    status: 500,
    code: 'internal',
    message: err instanceof Error ? err.message : String(err),
  };
}
