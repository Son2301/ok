'use client';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/client';
import { useI18n } from '@/components/i18n-provider';
import { Notice } from '@/components/ui';
import { type LinkState, linkInstallationAction } from './actions';

export function LinkForm({
  installationId,
  state,
  code,
}: {
  installationId: string;
  state?: string;
  code?: string;
}) {
  const { t } = useI18n();
  const [res, action] = useActionState<LinkState, FormData>(linkInstallationAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="installationId" value={installationId} />
      {state && <input type="hidden" name="state" value={state} />}
      {code && <input type="hidden" name="code" value={code} />}
      {res.error && (
        <Notice tone="danger" title={res.error}>
          {t.review.linkWindowHint}
        </Notice>
      )}
      <SubmitButton pendingLabel={t.common.loading}>{t.review.linkButton}</SubmitButton>
    </form>
  );
}
