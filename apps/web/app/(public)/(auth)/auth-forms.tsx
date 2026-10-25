'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { SubmitButton } from '@/components/client';
import { useI18n } from '@/components/i18n-provider';
import { Field, Notice } from '@/components/ui';
import { type AuthState, loginAction, signupAction } from './actions';

export function LoginForm({ next }: { next: string }) {
  const { t } = useI18n();
  const [state, action] = useActionState<AuthState, FormData>(loginAction, {});
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="next" value={next} />
      {state.error && <Notice tone="danger">{state.error}</Notice>}
      <Field label={t.auth.email} htmlFor="email">
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={state.values?.email}
          className="input"
        />
      </Field>
      <Field label={t.auth.password} htmlFor="password">
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="input"
        />
      </Field>
      <SubmitButton className="w-full" pendingLabel={t.common.loading}>
        {t.auth.submitLogin}
      </SubmitButton>
      <p className="text-center text-sm text-muted">
        {t.auth.noAccount}{' '}
        <Link
          href={`/signup${next !== '/console' ? `?next=${encodeURIComponent(next)}` : ''}`}
          className="font-medium text-accent hover:underline"
        >
          {t.common.signUp}
        </Link>
      </p>
    </form>
  );
}

export function SignupForm({ next }: { next: string }) {
  const { t } = useI18n();
  const [state, action] = useActionState<AuthState, FormData>(signupAction, {});
  const err = (f: 'email' | 'password') => (state.field === f ? state.error : undefined);
  return (
    <form action={action} className="space-y-4" noValidate>
      <input type="hidden" name="next" value={next} />
      {state.error && !state.field && <Notice tone="danger">{state.error}</Notice>}
      <Field label={t.auth.name} htmlFor="name" optionalLabel={t.common.optional}>
        <input
          id="name"
          name="name"
          autoComplete="name"
          defaultValue={state.values?.name}
          className="input"
        />
      </Field>
      <Field label={t.auth.email} htmlFor="email" error={err('email')}>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={state.values?.email}
          aria-invalid={Boolean(err('email'))}
          aria-describedby={err('email') ? 'email-error' : undefined}
          className="input"
        />
      </Field>
      <Field label={t.auth.password} htmlFor="password" hint={t.auth.passwordHint} error={err('password')}>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          aria-invalid={Boolean(err('password'))}
          aria-describedby={err('password') ? 'password-error' : 'password-hint'}
          className="input"
        />
      </Field>
      <Field
        label={t.auth.orgName}
        htmlFor="orgName"
        hint={t.auth.orgNameHint}
        optionalLabel={t.common.optional}
      >
        <input
          id="orgName"
          name="orgName"
          autoComplete="organization"
          defaultValue={state.values?.orgName}
          className="input"
        />
      </Field>
      <SubmitButton className="w-full" pendingLabel={t.common.loading}>
        {t.auth.submitSignup}
      </SubmitButton>
      <p className="text-center text-xs text-muted">{t.auth.reassurance}</p>
      <p className="text-center text-sm text-muted">
        {t.auth.haveAccount}{' '}
        <Link
          href={`/login${next !== '/console' ? `?next=${encodeURIComponent(next)}` : ''}`}
          className="font-medium text-accent hover:underline"
        >
          {t.common.signIn}
        </Link>
      </p>
    </form>
  );
}
