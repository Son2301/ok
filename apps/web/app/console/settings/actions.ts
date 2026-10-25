'use server';

import { revalidatePath } from 'next/cache';
import { getI18n } from '@/lib/i18n/server';
import { renameOrg } from '@/lib/org';
import { requireSession } from '@/lib/session';

export interface OrgState {
  ok?: boolean;
  error?: string;
}

export async function renameOrgAction(_prev: OrgState, form: FormData): Promise<OrgState> {
  const session = await requireSession();
  const { t } = await getI18n();
  if (session.role !== 'owner' && session.role !== 'admin')
    return { error: t.errors.generic.replace('{message}', 'forbidden') };
  const name = String(form.get('name') ?? '')
    .trim()
    .slice(0, 120);
  if (!name) return { error: t.settings.orgNameRequired };
  try {
    await renameOrg(session.org.id, name);
  } catch (err) {
    console.error('[web] rename org failed', err);
    return { error: t.auth.unavailable };
  }
  revalidatePath('/console', 'layout');
  return { ok: true };
}
