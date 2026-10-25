'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { isLocale, LOCALE_COOKIE } from '@/lib/i18n';
import { platform } from '@/lib/platform';
import { clearSessionCookie, sessionToken } from '@/lib/session';

/** Language preference (VI default). Setting a cookie in an action re-renders the current page. */
export async function setLocaleAction(locale: string) {
  if (!isLocale(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
}

export async function logoutAction() {
  const token = await sessionToken();
  if (token) {
    try {
      const { core } = await platform();
      await core.logout(token);
    } catch (err) {
      console.error('[web] logout failed', err);
    }
  }
  await clearSessionCookie();
  redirect('/');
}
