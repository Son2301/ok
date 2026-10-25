import { promises as dns } from 'node:dns';
import { AppError } from '@ok/shared';
import { classifyIp, ipLiteralFamily } from './ip';

/**
 * SSRF-safe HTTP fetcher used to expand short links, read landing pages and download media by URL.
 *
 * For every hop (initial request, each redirect, each meta-refresh):
 *  1. only http/https, only allowed ports, no credentials, no internal-looking hostnames;
 *  2. resolve DNS ourselves and reject if ANY returned address is non-public;
 *  3. connect to the exact address we validated (the transport pins it), so a DNS answer that
 *     changes between our check and the connect (DNS rebinding) cannot redirect the socket;
 *  4. redirects are re-validated from step 1, including a fresh DNS resolution.
 * One deadline covers the whole chain; bodies are capped; cookies are never sent or stored.
 */

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface Resolver {
  lookup(hostname: string): Promise<ResolvedAddress[]>;
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
}

export const systemResolver: Resolver = {
  async lookup(hostname) {
    const res = await dns.lookup(hostname, { all: true, verbatim: true });
    return res.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
  },
  resolveMx: (domain) => dns.resolveMx(domain),
};

export interface TlsInfo {
  issuer?: string;
  subject?: string;
  validFrom?: string;
  validTo?: string;
}

export interface HopRequest {
  url: URL;
  /** The validated IP the transport MUST connect to. */
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  signal: AbortSignal;
  maxBytes: number;
}

export interface HopResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  truncated: boolean;
  tls?: TlsInfo;
}

export type Transport = (req: HopRequest) => Promise<HopResponse>;

export type SafeFetchErrorCode =
  | 'invalid_url'
  | 'blocked_scheme'
  | 'blocked_port'
  | 'blocked_host'
  | 'blocked_ip'
  | 'dns_error'
  | 'too_many_redirects'
  | 'timeout'
  | 'tls_error'
  | 'network_error';

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    readonly url?: string,
  ) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface Hop {
  url: string;
  status?: number;
  address?: string;
  /** How we got to the next hop. */
  next?: 'redirect' | 'meta-refresh';
}

export interface SafeFetchResult {
  ok: boolean;
  requestedUrl: string;
  finalUrl: string;
  chain: Hop[];
  status?: number;
  headers?: Record<string, string>;
  contentType?: string;
  body?: Uint8Array;
  truncated: boolean;
  tls?: TlsInfo;
  error?: { code: SafeFetchErrorCode; message: string; url?: string };
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  allowedPorts?: number[];
  followMetaRefresh?: boolean;
  accept?: string;
  /** Override the address policy (tests only). Default: block everything non-public. */
  isAllowedAddress?: (ip: string) => boolean;
}

export const DEFAULT_ALLOWED_PORTS = [80, 443, 8080, 8443];
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36 SafeLinkChecker/1.0';

const INTERNAL_HOST =
  /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa|in-addr\.arpa|ip6\.arpa)$/i;

export class SafeFetcher {
  constructor(
    private readonly transport: Transport,
    private readonly resolver: Resolver = systemResolver,
    private readonly defaults: SafeFetchOptions = {},
  ) {}

  /** Validate a URL for one hop (scheme, port, host) without touching the network. */
  validateUrl(raw: string | URL, opts: SafeFetchOptions = {}): URL {
    let url: URL;
    try {
      url = new URL(raw.toString());
    } catch {
      throw new SafeFetchError('invalid_url', 'Invalid URL', String(raw));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new SafeFetchError('blocked_scheme', `Scheme ${url.protocol} is not allowed`, url.href);
    }
    url.username = '';
    url.password = '';
    url.hash = '';
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    const allowedPorts = opts.allowedPorts ?? this.defaults.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
    if (!allowedPorts.includes(port))
      throw new SafeFetchError('blocked_port', `Port ${port} is not allowed`, url.href);
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host) throw new SafeFetchError('blocked_host', 'Missing host', url.href);
    if (!ipLiteralFamily(host)) {
      if (!host.includes('.') || INTERNAL_HOST.test(host)) {
        throw new SafeFetchError('blocked_host', `Host ${host} looks internal`, url.href);
      }
    }
    return url;
  }

  /** Resolve and validate every address; returns the one to pin. */
  async resolveSafe(url: URL, opts: SafeFetchOptions = {}): Promise<ResolvedAddress> {
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    const allowed =
      opts.isAllowedAddress ?? this.defaults.isAllowedAddress ?? ((ip: string) => !classifyIp(ip).blocked);
    const literal = ipLiteralFamily(host);
    if (literal) {
      if (!allowed(host)) {
        throw new SafeFetchError(
          'blocked_ip',
          `Address ${host} is not public (${classifyIp(host).reason})`,
          url.href,
        );
      }
      return { address: host, family: literal };
    }
    let addrs: ResolvedAddress[];
    try {
      addrs = await this.resolver.lookup(host);
    } catch (err) {
      throw new SafeFetchError(
        'dns_error',
        `DNS lookup failed for ${host}: ${(err as Error).message}`,
        url.href,
      );
    }
    if (!addrs.length) throw new SafeFetchError('dns_error', `No addresses for ${host}`, url.href);
    // If ANY answer is internal, refuse: attackers mix public + private records to win races.
    for (const a of addrs) {
      if (!allowed(a.address)) {
        throw new SafeFetchError(
          'blocked_ip',
          `${host} resolves to a non-public address (${a.address}: ${classifyIp(a.address).reason})`,
          url.href,
        );
      }
    }
    return addrs.find((a) => a.family === 4) ?? addrs[0]!;
  }

  async fetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
    const opts = { ...this.defaults, ...options };
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const maxBytes = opts.maxBytes ?? 512 * 1024;
    const maxRedirects = opts.maxRedirects ?? 5;
    const ctrl = new AbortController();
    const timer = setTimeout(
      () => ctrl.abort(new SafeFetchError('timeout', `Timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const chain: Hop[] = [];
    const result: SafeFetchResult = {
      ok: false,
      requestedUrl: rawUrl,
      finalUrl: rawUrl,
      chain,
      truncated: false,
    };
    let current = rawUrl;
    try {
      for (let hops = 0; ; hops++) {
        const url = this.validateUrl(current, opts);
        result.finalUrl = url.href;
        const hop: Hop = { url: url.href };
        chain.push(hop);
        const pinned = await raceAbort(this.resolveSafe(url, opts), ctrl.signal);
        hop.address = pinned.address;
        const res = await raceAbort(
          this.transport({
            url,
            address: pinned.address,
            family: pinned.family,
            headers: {
              'user-agent': USER_AGENT,
              accept: opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'accept-language': 'vi-VN,vi;q=0.9,en;q=0.8',
              'accept-encoding': 'identity',
            },
            signal: ctrl.signal,
            maxBytes,
          }),
          ctrl.signal,
        );
        hop.status = res.status;
        let next: string | null = null;
        if (res.status >= 300 && res.status < 400 && res.headers.location) {
          next = new URL(res.headers.location, url).href;
          hop.next = 'redirect';
        } else if (
          opts.followMetaRefresh !== false &&
          res.status === 200 &&
          isHtml(res.headers['content-type'])
        ) {
          const target = metaRefreshTarget(res.body);
          if (target) {
            try {
              next = new URL(target, url).href;
              hop.next = 'meta-refresh';
            } catch {
              next = null;
            }
          }
        }
        if (next) {
          if (hops + 1 > maxRedirects) {
            throw new SafeFetchError('too_many_redirects', `More than ${maxRedirects} redirects`, next);
          }
          current = next;
          continue;
        }
        const body = res.body.byteLength > maxBytes ? res.body.subarray(0, maxBytes) : res.body;
        result.ok = true;
        result.status = res.status;
        result.headers = res.headers;
        result.contentType = res.headers['content-type'];
        result.body = body;
        result.truncated = res.truncated || res.body.byteLength > maxBytes;
        result.tls = res.tls;
        return result;
      }
    } catch (err) {
      const e = toSafeFetchError(err, ctrl.signal);
      result.error = { code: e.code, message: e.message, url: e.url ?? current };
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fetch a binary resource (media by URL). Throws AppError on any failure. */
  async fetchBinary(
    rawUrl: string,
    maxBytes: number,
    timeoutMs = 15_000,
  ): Promise<{ bytes: Uint8Array; contentType?: string; finalUrl: string }> {
    const res = await this.fetch(rawUrl, {
      maxBytes: maxBytes + 1,
      timeoutMs,
      followMetaRefresh: false,
      accept: '*/*',
    });
    if (!res.ok || !res.body) {
      const code = res.error?.code;
      if (
        code === 'blocked_ip' ||
        code === 'blocked_host' ||
        code === 'blocked_port' ||
        code === 'blocked_scheme'
      ) {
        throw new AppError('bad_request', `URL not allowed: ${res.error?.message}`);
      }
      if (code === 'timeout') throw new AppError('timeout', 'Downloading the media timed out');
      throw new AppError(
        'upstream_error',
        `Could not download media: ${res.error?.message ?? `HTTP ${res.status}`}`,
      );
    }
    if ((res.status ?? 0) >= 400)
      throw new AppError('upstream_error', `Could not download media: HTTP ${res.status}`);
    if (res.truncated || res.body.byteLength > maxBytes) {
      throw new AppError('bad_request', `Media is larger than ${Math.round(maxBytes / 1024 / 1024)}MB`);
    }
    return { bytes: res.body, contentType: res.contentType, finalUrl: res.finalUrl };
  }
}

function toSafeFetchError(err: unknown, signal: AbortSignal): SafeFetchError {
  if (err instanceof SafeFetchError) return err;
  if (signal.aborted) {
    const reason = signal.reason;
    return reason instanceof SafeFetchError ? reason : new SafeFetchError('timeout', 'Request aborted');
  }
  const code = (err as { code?: string }).code ?? '';
  const msg = (err as Error)?.message ?? String(err);
  if (/CERT|SSL|TLS|ERR_TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/i.test(code) || /certificate/i.test(msg)) {
    return new SafeFetchError('tls_error', `TLS error: ${code || msg}`);
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return new SafeFetchError('timeout', msg);
  return new SafeFetchError('network_error', code ? `${code}: ${msg}` : msg);
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

const isHtml = (ct?: string) => !ct || /html|xhtml/i.test(ct);

/** `<meta http-equiv="refresh" content="0; url=https://…">` with a short delay → target URL. */
export function metaRefreshTarget(body: Uint8Array): string | null {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(body.subarray(0, 16_384));
  const tags = head.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!/http-equiv\s*=\s*["']?refresh/i.test(tag)) continue;
    const content =
      tag.match(/content\s*=\s*(["'])(.*?)\1/i)?.[2] ?? tag.match(/content\s*=\s*([^\s>]+)/i)?.[1];
    if (!content) continue;
    const m = content.match(
      /^\s*(\d+(?:\.\d+)?)\s*(?:[;,]\s*(?:url\s*=\s*)?|\s+url\s*=\s*)['"]?([^'"]+)['"]?\s*$/i,
    );
    if (!m) continue;
    const delay = Number(m[1]);
    if (delay <= 10 && m[2]) return m[2].trim();
  }
  return null;
}
