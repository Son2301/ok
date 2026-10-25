import { domainToUnicode } from 'node:url';
import { AppError } from '@ok/shared';
import { parse as parseDomain } from 'tldts';
import { ipLiteralFamily } from '../net/ip';

export interface NormalizedUrl {
  url: URL;
  /** Canonical string: lowercase scheme/host, punycode host, no fragment, no credentials. */
  href: string;
  /** ASCII (punycode) hostname without brackets or trailing dot. */
  host: string;
  /** Unicode form of the host (differs from `host` for IDNs). */
  unicodeHost: string;
  /** Registrable domain using ICANN suffixes only (e.g. `vietcombank.com.vn`, `google.com`). */
  domain: string | null;
  /** Registrable domain including private suffixes (e.g. `foo.blogspot.com`, `abc.github.io`). */
  siteDomain: string | null;
  /** Registrable label without suffix (e.g. `vietcombank`). */
  domainName: string | null;
  publicSuffix: string | null;
  subdomain: string;
  isIp: boolean;
  /** The input contained `user:pass@` (a classic trick: `https://vietcombank.com.vn@evil.top`). */
  hadCredentials: string | null;
  /** The input was defanged (`hxxp`, `[.]`) and we refanged it. */
  refanged: boolean;
}

/** Undo common defanging: `hxxps://evil[.]com` → `https://evil.com`. */
export function refang(raw: string): string {
  return raw
    .trim()
    .replace(/^[<"'`(]+|[>"'`)]+$/g, '')
    .replace(/^h[xX]{2}p(s?)/i, 'http$1')
    .replace(/\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\)/gi, '.')
    .replace(/\[:\]/g, ':')
    .replace(/\[\/\]/g, '/');
}

const MAX_URL_LENGTH = 4096;

export function normalizeUrl(rawInput: string): NormalizedUrl {
  const original = rawInput.trim();
  if (!original) throw new AppError('bad_request', 'URL is empty');
  if (original.length > MAX_URL_LENGTH)
    throw new AppError('bad_request', `URL is longer than ${MAX_URL_LENGTH} characters`);
  const refangedStr = refang(original);
  const refanged = refangedStr !== original.replace(/^[<"'`(]+|[>"'`)]+$/g, '');
  let candidate = refangedStr;
  if (!/^https?:\/\//i.test(candidate)) {
    if (
      /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ||
      /^(javascript|data|file|vbscript|blob|about|mailto|tel|intent):/i.test(candidate)
    ) {
      throw new AppError('bad_request', 'Only http and https links can be checked');
    }
    candidate = `http://${candidate.replace(/^\/+/, '')}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new AppError('bad_request', 'This does not look like a valid link');
  }
  const hadCredentials = url.username || url.password ? decodeURIComponent(url.username) : null;
  url.username = '';
  url.password = '';
  url.hash = '';
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (!host) throw new AppError('bad_request', 'This link has no host name');
  const isIp = ipLiteralFamily(host) !== null;
  if (!isIp && !host.includes('.')) throw new AppError('bad_request', 'This link has no valid domain');

  const icann = parseDomain(host);
  const priv = parseDomain(host, { allowPrivateDomains: true });
  return {
    url,
    href: url.href,
    host,
    unicodeHost: isIp ? host : domainToUnicode(host) || host,
    domain: isIp ? null : icann.domain,
    siteDomain: isIp ? null : priv.domain,
    domainName: isIp ? null : icann.domainWithoutSuffix,
    publicSuffix: isIp ? null : icann.publicSuffix,
    subdomain: isIp ? '' : (icann.subdomain ?? ''),
    isIp,
    hadCredentials,
    refanged,
  };
}

/** Host without a leading `www.`, used as the lookup key for URL reports and feeds. */
export function hostKey(host: string): string {
  return host
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^www\./, '');
}

/** True if `host` equals `domain` or is a subdomain of it. */
export function isOnDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}
