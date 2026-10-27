import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Authentication of control-plane → runtime requests.
 *
 * The container knows its plaintext runtime token; the control plane stores
 * only sha256(token). Requests to the runtime are signed with
 * HMAC-SHA256(key = sha256(token), "<timestamp>.<body>"). The runtime derives
 * the same key from its token. A leaked database therefore cannot be used to
 * call the tool proxy (that needs the plaintext token), and runtimes reject
 * requests that are unsigned, stale (> 5 min) or tampered with.
 */
export const SIGNATURE_HEADER = 'x-minh-signature';
export const TIMESTAMP_HEADER = 'x-minh-timestamp';
export const MAX_SKEW_MS = 5 * 60_000;

export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export function signRequest(hash: string, timestamp: number, body: string): string {
  return `v1=${createHmac('sha256', hash).update(`${timestamp}.${body}`).digest('hex')}`;
}

export function verifyRequest(input: {
  token: string;
  timestamp: string | undefined;
  signature: string | undefined;
  body: string;
  now?: number;
}): boolean {
  if (!input.timestamp || !input.signature) return false;
  const ts = Number(input.timestamp);
  if (!Number.isFinite(ts) || Math.abs((input.now ?? Date.now()) - ts) > MAX_SKEW_MS) return false;
  const expected = Buffer.from(signRequest(tokenHash(input.token), ts, input.body));
  const got = Buffer.from(input.signature);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
