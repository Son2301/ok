'use server';

import { redirect } from 'next/navigation';
import { fmt } from '@/lib/i18n';
import { getI18n } from '@/lib/i18n/server';
import { reviewApi } from '@/lib/services';
import { requireSession } from '@/lib/session';

export interface LinkState {
  error?: string;
}

/**
 * Link a GitHub App installation to the signed-in org. Uses the state token
 * from the URL when present (setup redirect), otherwise asks the review
 * service for a fresh one bound to this org.
 */
export async function linkInstallationAction(_prev: LinkState, form: FormData): Promise<LinkState> {
  const session = await requireSession();
  const { t } = await getI18n();
  const installationId = Number(form.get('installationId'));
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return { error: t.review.linkMissing };
  let state = typeof form.get('state') === 'string' ? (form.get('state') as string) : '';
  const code =
    typeof form.get('code') === 'string' && form.get('code') ? (form.get('code') as string) : undefined;

  if (!state) {
    const issued = await reviewApi.installUrl(session.org.id);
    if (!issued.ok) return { error: fmt(t.review.linkFailed, { message: issued.error.message }) };
    state = issued.data.state;
  }
  const res = await reviewApi.link(session.org.id, { installationId, state, code });
  if (!res.ok) return { error: fmt(t.review.linkFailed, { message: res.error.message }) };
  redirect(`/console/review?linked=${installationId}`);
}
