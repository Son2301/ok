import { promises as dns } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { AppError } from '@ok/shared';

/**
 * SSRF-safe outbound HTTP for tools whose target URL is influenced by the
 * model or by customer config (`http_request`, `send_webhook`).
 *
 * - only http/https, optional per-agent host allowlist;
 * - every resolved address must be public (no loopback, RFC1918, link-local,
 *   CGNAT, multicast, reserved, unique-local, IPv4-mapped/NAT64/6to4 private…);
 * - the socket connects to the address that was validated (custom `lookup`),
 *   so DNS rebinding between check and connect is impossible;
 * - redirects are followed manually and every hop is re-validated;
 * - hard time and response-size limits.
 */

export type LookupFn = (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;

export const systemLookup: LookupFn = async (hostname) =>
  (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family === 6 ? 6 : 4,
  }));

const v4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  v4.addSubnet(net, prefix, 'ipv4');
}
v4.addAddress('255.255.255.255', 'ipv4');

const v6 = new BlockList();
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['100::', 64],
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['2001:10::', 28], // ORCHID
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link local
  ['fec0::', 10], // site local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  v6.addSubnet(net, prefix, 'ipv6');
}

/** Expand an IPv6 address into 8 16-bit groups (handles `::` and a dotted IPv4 tail). */
function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!;
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const parts = dotted[1]!.split('.').map(Number);
    if (parts.some((p) => p > 255)) return null;
    s = `${s.slice(0, -dotted[1]!.length)}${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(fill).fill('0'), ...t].map((g) => Number.parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

const v4FromGroups = (a: number, b: number) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;

/** IPv4 address embedded in an IPv6 one (mapped, compatible, NAT64 or 6to4), if any. */
export function embeddedIpv4(ip: string): string | null {
  const g = expandIpv6(ip);
  if (!g) return null;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && (g[5] === 0xffff || g[5] === 0)) return v4FromGroups(g[6]!, g[7]!); // ::ffff:a.b.c.d / ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4FromGroups(g[6]!, g[7]!); // NAT64
  if (g[0] === 0x2002) return v4FromGroups(g[1]!, g[2]!); // 6to4
  return null;
}

/** True if `ip` must never be contacted by tools (private, loopback, link-local, reserved, …) or is not an IP. */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return v4.check(ip, 'ipv4');
  if (family === 6) {
    const embedded = embeddedIpv4(ip);
    if (embedded && (v4.check(embedded, 'ipv4') || embedded === '0.0.0.0')) return true;
    const g = expandIpv6(ip);
    if (!g) return true;
    return v6.check(ip.split('%')[0]!, 'ipv6');
  }
  return true;
}

/** Host allowlist match: `example.com` (exact), `*.example.com` (subdomains only), `*` (any public host). */
export function hostAllowed(hostname: string, allowlist: readonly string[] | null | undefined): boolean {
  if (allowlist === null || allowlist === undefined) return true;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return allowlist.some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/\.$/, '');
    if (!entry) return false;
    if (entry === '*') return true;
    if (entry.startsWith('*.')) return host.endsWith(entry.slice(1)) && host.length > entry.length - 1;
    return host === entry;
  });
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** `null`/`undefined` = any public host. An empty array blocks everything. */
  allowedHosts?: readonly string[] | null;
  lookup?: LookupFn;
  /** IP policy; defaults to {@link isBlockedIp}. Overridable only for tests. */
  isBlocked?: (ip: string) => boolean;
  signal?: AbortSignal;
}

export interface SafeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  truncated: boolean;
  url: string;
  redirects: number;
}

const STRIP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'te',
  'trailer',
  'keep-alive',
]);

/** Resolve and validate a hostname, returning the address to connect to. */
export async function resolvePublicAddress(
  hostname: string,
  lookup: LookupFn = systemLookup,
  isBlocked: (ip: string) => boolean = isBlockedIp,
): Promise<{ address: string; family: 4 | 6 }> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(bare);
  if (literal) {
    if (isBlocked(bare)) throw new AppError('forbidden', `Blocked request to non-public address ${bare}`);
    return { address: bare, family: literal === 6 ? 6 : 4 };
  }
  if (
    /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(
      bare.replace(/\.$/, ''),
    )
  ) {
    throw new AppError('forbidden', `Blocked request to internal hostname ${bare}`);
  }
  let addrs: { address: string; family: 4 | 6 }[];
  try {
    addrs = await lookup(bare);
  } catch {
    throw new AppError('bad_request', `Could not resolve host ${bare}`);
  }
  if (!addrs.length) throw new AppError('bad_request', `Could not resolve host ${bare}`);
  const bad = addrs.find((a) => isBlocked(a.address));
  if (bad)
    throw new AppError('forbidden', `Blocked request: ${bare} resolves to non-public address ${bad.address}`);
  return addrs[0]!;
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const maxRedirects = opts.maxRedirects ?? 3;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('bad_request', 'Invalid URL');
  }
  let method = (opts.method ?? 'GET').toUpperCase();
  let body = opts.body;
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);

  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new AppError('bad_request', `Unsupported URL scheme ${url.protocol}`);
    if (!url.hostname) throw new AppError('bad_request', 'URL has no host');
    if (!hostAllowed(url.hostname.replace(/^\[|\]$/g, ''), opts.allowedHosts)) {
      throw new AppError('forbidden', `Host ${url.hostname} is not in this agent's allowlist`);
    }
    const target = await resolvePublicAddress(url.hostname, opts.lookup, opts.isBlocked);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AppError('timeout', 'Request timed out');
    const res = await requestOnce(url, target, { ...opts, method, body, timeoutMs: remaining });
    const location = res.headers.location;
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      if (hop >= maxRedirects) throw new AppError('bad_request', `Too many redirects (max ${maxRedirects})`);
      url = new URL(location, url);
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    return { ...res, url: url.toString(), redirects: hop };
  }
}

function requestOnce(
  url: URL,
  target: { address: string; family: 4 | 6 },
  opts: SafeFetchOptions & { method: string; timeoutMs: number },
): Promise<Omit<SafeResponse, 'url' | 'redirects'>> {
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.headers ?? {}))
    if (!STRIP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent'))
    headers['user-agent'] = 'ok-agents/1.0';
  if (opts.body !== undefined) headers['content-length'] = String(Buffer.byteLength(opts.body));

  // Pin the connection to the validated address (handles Node's `all: true` lookups too).
  const pinnedLookup = (
    _host: string,
    options: { all?: boolean } | number,
    cb: (...args: unknown[]) => void,
  ) => {
    if (typeof options === 'object' && options?.all)
      cb(null, [{ address: target.address, family: target.family }]);
    else cb(null, target.address, target.family);
  };

  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      { method: opts.method, headers, lookup: pinnedLookup as never, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (chunk: Buffer) => {
          if (truncated) return;
          if (size + chunk.length > maxBytes) {
            chunks.push(chunk.subarray(0, maxBytes - size));
            size = maxBytes;
            truncated = true;
            finish();
            res.destroy();
            return;
          }
          chunks.push(chunk);
          size += chunk.length;
        });
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const outHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers))
            if (v !== undefined) outHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
          resolve({
            status: res.statusCode ?? 0,
            headers: outHeaders,
            body: Buffer.concat(chunks),
            truncated,
          });
        };
        res.on('end', finish);
        res.on('error', (err) => (done ? undefined : reject(err)));
      },
    );
    const timer = setTimeout(
      () => req.destroy(new AppError('timeout', `Request to ${url.host} timed out`)),
      opts.timeoutMs,
    );
    const onAbort = () => req.destroy(new AppError('timeout', 'Request aborted'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(
        err instanceof AppError
          ? err
          : new AppError('upstream_error', `Request to ${url.host} failed: ${err.message}`),
      );
    });
    req.on('close', () => opts.signal?.removeEventListener('abort', onAbort));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
