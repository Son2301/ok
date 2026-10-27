'use server';

import { isAppError } from '@minh/shared';
import { redirect } from 'next/navigation';
import { getI18n } from '@/lib/i18n/server';
import { platform } from '@/lib/platform';
import { safeNext } from '@/lib/safe-next';
import { setSessionCookie } from '@/lib/session';

export interface AuthState {
  error?: string;
  field?: 'email' | 'password';
  values?: { email?: string; name?: string; orgName?: string };
}

const str = (v: FormDataEntryValue | null, max = 200) =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

export async function loginAction(_prev: AuthState, form: FormData): Promise<AuthState> {
  const { t } = await getI18n();
  const email = str(form.get('email'), 320);
  const password = typeof form.get('password') === 'string' ? (form.get('password') as string) : '';
  const next = safeNext(str(form.get('next'), 2000));
  if (!email || !password) return { error: t.auth.wrongCredentials, values: { email } };
  try {
    const { core } = await platform();
    const { token } = await core.login(email, password);
    await setSessionCookie(token);
  } catch (err) {
    if (isAppError(err) && (err.code === 'unauthorized' || err.code === 'forbidden')) {
      return { error: t.auth.wrongCredentials, values: { email } };
    }
    console.error('[web] login failed', err);
    return { error: t.auth.unavailable, values: { email } };
  }
  redirect(next);
}

export async function signupAction(_prev: AuthState, form: FormData): Promise<AuthState> {
  const { t } = await getI18n();
  const email = str(form.get('email'), 320);
  const password = typeof form.get('password') === 'string' ? (form.get('password') as string) : '';
  const name = str(form.get('name'), 120);
  const orgName = str(form.get('orgName'), 120);
  const next = safeNext(str(form.get('next'), 2000));
  const values = { email, name, orgName };

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return { error: t.auth.invalidEmail, field: 'email', values };
  if (password.length < 8) return { error: t.auth.shortPassword, field: 'password', values };

  try {
    const { core } = await platform();
    await core.signUp({ email, password, name: name || undefined, orgName: orgName || undefined });
    const { token } = await core.login(email, password);
    await setSessionCookie(token);
  } catch (err) {
    if (isAppError(err)) {
      if (err.code === 'conflict') return { error: t.auth.emailTaken, field: 'email', values };
      if (err.code === 'bad_request') {
        return /password/i.test(err.message)
          ? { error: t.auth.shortPassword, field: 'password', values }
          : { error: t.auth.invalidEmail, field: 'email', values };
      }
    }
    console.error('[web] signup failed', err);
    return { error: t.auth.unavailable, values };
  }
  redirect(next);
}
