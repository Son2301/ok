/**
 * IP address classification for the SSRF guard. Everything that is not plain public unicast is
 * blocked: private, loopback, link-local (incl. cloud metadata 169.254.169.254 / fd00:ec2::254),
 * CGNAT, documentation, benchmarking, multicast, reserved, and IPv6 transition ranges whose
 * embedded IPv4 address points somewhere internal (IPv4-mapped, NAT64, 6to4) or that tunnel
 * (Teredo).
 */

export interface IpVerdict {
  blocked: boolean;
  reason?: string;
  family?: 4 | 6;
}

export function parseIPv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Parse an IPv6 literal (with optional brackets, zone id, embedded IPv4) into 8 hextets. */
export function parseIPv6(input: string): number[] | null {
  let s = input.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;

  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return null;
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    s = `${s.slice(0, lastColon + 1)}`;
    if (s.endsWith('::')) {
      // keep as-is
    } else if (s.endsWith(':')) {
      s = s.slice(0, -1);
    }
  }

  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(dbl[0]!);
  const rest = dbl.length === 2 ? parse(dbl[1]!) : [];
  const hex = (h: string) => (/^[0-9a-fA-F]{1,4}$/.test(h) ? Number.parseInt(h, 16) : Number.NaN);
  const headNums = head.map(hex);
  const restNums = rest.map(hex);
  if ([...headNums, ...restNums].some(Number.isNaN)) return null;

  const total = headNums.length + restNums.length + tail.length;
  if (dbl.length === 1) {
    if (total !== 8) return null;
    return [...headNums, ...tail];
  }
  if (total > 7) return null;
  return [...headNums, ...new Array(8 - total).fill(0), ...restNums, ...tail];
}

type V4Range = [number[], number, string];
const V4_BLOCKED: V4Range[] = [
  [[0, 0, 0, 0], 8, 'this-network'],
  [[10, 0, 0, 0], 8, 'private'],
  [[100, 64, 0, 0], 10, 'cgnat'],
  [[127, 0, 0, 0], 8, 'loopback'],
  [[169, 254, 0, 0], 16, 'link-local/metadata'],
  [[172, 16, 0, 0], 12, 'private'],
  [[192, 0, 0, 0], 24, 'ietf-protocol'],
  [[192, 0, 2, 0], 24, 'documentation'],
  [[192, 88, 99, 0], 24, '6to4-relay'],
  [[192, 168, 0, 0], 16, 'private'],
  [[198, 18, 0, 0], 15, 'benchmarking'],
  [[198, 51, 100, 0], 24, 'documentation'],
  [[203, 0, 113, 0], 24, 'documentation'],
  [[224, 0, 0, 0], 4, 'multicast'],
  [[240, 0, 0, 0], 4, 'reserved'],
];

function v4ToInt(o: number[]): number {
  return ((o[0]! << 24) >>> 0) + (o[1]! << 16) + (o[2]! << 8) + o[3]!;
}

export function classifyIPv4(octets: number[]): IpVerdict {
  const ip = v4ToInt(octets);
  for (const [base, bits, reason] of V4_BLOCKED) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((ip & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0) return { blocked: true, reason, family: 4 };
  }
  return { blocked: false, family: 4 };
}

function inPrefix(words: number[], prefix: number[], bits: number): boolean {
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if ((words[i]! & mask) !== ((prefix[i] ?? 0) & mask)) return false;
    remaining -= take;
  }
  return true;
}

const embeddedV4 = (hi: number, lo: number) => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

export function classifyIPv6(w: number[]): IpVerdict {
  const v6 = (reason: string): IpVerdict => ({ blocked: true, reason, family: 6 });
  if (w.every((x) => x === 0)) return v6('unspecified');
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return v6('loopback');
  // IPv4-mapped ::ffff:a.b.c.d → judge the IPv4 address.
  if (inPrefix(w, [0, 0, 0, 0, 0, 0xffff], 96)) {
    const inner = classifyIPv4(embeddedV4(w[6]!, w[7]!));
    return inner.blocked ? v6(`ipv4-mapped ${inner.reason}`) : { blocked: false, family: 6 };
  }
  // IPv4-compatible ::a.b.c.d (deprecated) and the rest of ::/96.
  if (inPrefix(w, [0, 0, 0, 0, 0, 0], 96)) return v6('ipv4-compatible');
  // NAT64 well-known prefix 64:ff9b::/96 → judge the IPv4 address.
  if (inPrefix(w, [0x64, 0xff9b, 0, 0, 0, 0], 96)) {
    const inner = classifyIPv4(embeddedV4(w[6]!, w[7]!));
    return inner.blocked ? v6(`nat64 ${inner.reason}`) : { blocked: false, family: 6 };
  }
  if (inPrefix(w, [0x64, 0xff9b, 1], 48)) return v6('nat64-local');
  if (inPrefix(w, [0x100], 64)) return v6('discard');
  if (inPrefix(w, [0x2001, 0xdb8], 32)) return v6('documentation');
  if (inPrefix(w, [0x2001], 23)) return v6('ietf-protocol/teredo');
  // 6to4 2002:AABB:CCDD::/48 embeds IPv4 AA.BB.CC.DD.
  if (inPrefix(w, [0x2002], 16)) {
    const inner = classifyIPv4(embeddedV4(w[1]!, w[2]!));
    return inner.blocked ? v6(`6to4 ${inner.reason}`) : { blocked: false, family: 6 };
  }
  if (inPrefix(w, [0x3fff], 20)) return v6('documentation');
  if (inPrefix(w, [0x5f00], 16)) return v6('srv6');
  if (inPrefix(w, [0xfc00], 7)) return v6('unique-local');
  if (inPrefix(w, [0xfe80], 10)) return v6('link-local');
  if (inPrefix(w, [0xfec0], 10)) return v6('site-local');
  if (inPrefix(w, [0xff00], 8)) return v6('multicast');
  // Only global unicast 2000::/3 is reachable on the public internet.
  if (!inPrefix(w, [0x2000], 3)) return v6('not-global-unicast');
  return { blocked: false, family: 6 };
}

/** Classify any IP literal. Unparseable input is blocked. */
export function classifyIp(ip: string): IpVerdict {
  const v4 = parseIPv4(ip);
  if (v4) return classifyIPv4(v4);
  const v6 = parseIPv6(ip);
  if (v6) return classifyIPv6(v6);
  return { blocked: true, reason: 'unparseable' };
}

export const isBlockedIp = (ip: string) => classifyIp(ip).blocked;

/** Is this hostname an IP literal (v4 dotted-quad or bracketed/bare v6)? */
export function ipLiteralFamily(host: string): 4 | 6 | null {
  if (parseIPv4(host)) return 4;
  if (parseIPv6(host)) return 6;
  return null;
}
