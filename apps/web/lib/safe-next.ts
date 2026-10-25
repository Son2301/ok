/**
 * Sanitise a post-login redirect target: only same-site relative paths, so
 * `/login?next=https://evil.example` can't bounce a user off-site.
 */
export function safeNext(next: string | null | undefined, fallback = '/console'): string {
  if (!next || typeof next !== 'string') return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (/[\r\n\t]/.test(next)) return fallback;
  if (next.startsWith('/login') || next.startsWith('/signup')) return fallback;
  return next;
}
