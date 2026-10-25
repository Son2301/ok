import 'server-only';

/**
 * CSRF guard for mutating route handlers (server actions have their own).
 * The session cookie is SameSite=Lax, which already blocks cross-site POSTs in
 * modern browsers; this is defence in depth.
 */
export function isSameOrigin(req: Request): boolean {
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** The visitor's IP chain as seen by this server, to forward to services that rate-limit per IP. */
export function forwardedFor(headers: Headers): string | null {
  return headers.get('x-forwarded-for') ?? headers.get('x-real-ip');
}

export function jsonError(status: number, code: string, message: string, details?: unknown) {
  return Response.json({ error: { code, message, ...(details ? { details } : {}) } }, { status });
}
