import 'server-only';
import type { Org, User } from '@ok/core';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { env } from './env';
import { platform } from './platform';
import { safeNext } from './safe-next';

export const SESSION_COOKIE = 'ok_session';
const SESSION_MAX_AGE_S = 30 * 24 * 3600; // matches the core session TTL

export interface SessionInfo {
  user: User;
  org: Org;
  role: string;
}

/** The signed-in user and org, or null. Memoised per request. */
export const getSession = cache(async (): Promise<SessionInfo | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { core } = await platform();
    return await core.getSession(token);
  } catch (err) {
    console.error('[web] session lookup failed', err);
    return null;
  }
});

/** For signed-in pages: redirects to /login?next=<current path> when there is no valid session. */
export async function requireSession(): Promise<SessionInfo> {
  const session = await getSession();
  if (!session) {
    const h = await headers();
    redirect(`/login?next=${encodeURIComponent(safeNext(h.get('x-pathname')))}`);
  }
  return session;
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env().cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_S,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function sessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}
