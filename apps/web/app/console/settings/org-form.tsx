'use client';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/client';
import { useI18n } from '@/components/i18n-provider';
import { Field } from '@/components/ui';
import { type OrgState, renameOrgAction } from './actions';

export function OrgForm({ name }: { name: string }) {
  const { t } = useI18n();
  const [state, action] = useActionState<OrgState, FormData>(renameOrgAction, {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <Field
        label={t.settings.orgName}
        htmlFor="org-name"
        error={state.error}
        className="min-w-0 flex-1 basis-64"
      >
        <input id="org-name" name="name" defaultValue={name} required maxLength={120} className="input" />
      </Field>
      <SubmitButton pendingLabel={t.common.saving}>{t.common.save}</SubmitButton>
      {state.ok && (
        <span role="status" className="w-full text-sm text-ok">
          {t.settings.orgSaved}
        </span>
      )}
    </form>
  );
}
