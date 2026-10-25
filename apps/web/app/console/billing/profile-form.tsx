'use client';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/client';
import { useI18n } from '@/components/i18n-provider';
import { Field, Notice } from '@/components/ui';
import type { BillingProfile } from '@/lib/types/gateway';
import { type ProfileState, saveProfileAction } from './actions';

export function ProfileForm({ profile }: { profile: BillingProfile | null }) {
  const { t } = useI18n();
  const B = t.billing;
  const [state, action] = useActionState<ProfileState, FormData>(saveProfileAction, {});
  const err = (f: ProfileState['field']) => (state.field === f ? state.error : undefined);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2" noValidate>
      <Field
        label={B.taxCode}
        htmlFor="taxCode"
        hint={B.taxCodeHint}
        error={err('taxCode')}
        optionalLabel={t.common.optional}
      >
        <input
          id="taxCode"
          name="taxCode"
          inputMode="numeric"
          defaultValue={profile?.taxCode ?? ''}
          placeholder="0101234567"
          aria-invalid={Boolean(err('taxCode'))}
          className="input font-mono"
        />
      </Field>
      <Field
        label={B.invoiceEmail}
        htmlFor="invoiceEmail"
        error={err('invoiceEmail')}
        optionalLabel={t.common.optional}
      >
        <input
          id="invoiceEmail"
          name="invoiceEmail"
          type="email"
          autoComplete="email"
          defaultValue={profile?.invoiceEmail ?? ''}
          aria-invalid={Boolean(err('invoiceEmail'))}
          className="input"
        />
      </Field>
      <Field
        label={B.companyName}
        htmlFor="companyName"
        className="sm:col-span-2"
        optionalLabel={t.common.optional}
      >
        <input
          id="companyName"
          name="companyName"
          autoComplete="organization"
          defaultValue={profile?.companyName ?? ''}
          className="input"
        />
      </Field>
      <Field label={B.address} htmlFor="address" className="sm:col-span-2" optionalLabel={t.common.optional}>
        <input
          id="address"
          name="address"
          autoComplete="street-address"
          defaultValue={profile?.address ?? ''}
          className="input"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <SubmitButton pendingLabel={t.common.saving}>{t.common.save}</SubmitButton>
        {state.ok && (
          <span role="status" className="text-sm text-ok">
            {B.profileSaved}
          </span>
        )}
        {state.error && !state.field && <Notice tone="danger">{state.error}</Notice>}
      </div>
    </form>
  );
}
