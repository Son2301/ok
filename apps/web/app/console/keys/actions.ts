'use server';

import { PRODUCT_IDS, type ProductId } from '@ok/shared';
import { revalidatePath } from 'next/cache';
import { env } from '@/lib/env';
import { appErrorCode } from '@/lib/errors';
import { parseVndInput, vndToMicros } from '@/lib/format';
import { getI18n } from '@/lib/i18n/server';
import { setKeySpendLimit } from '@/lib/keys';
import { platform } from '@/lib/platform';
import { gatewayApi } from '@/lib/services';
import { requireSession } from '@/lib/session';

export interface CreateKeyState {
  error?: string;
  field?: 'name' | 'cap';
  created?: { key: string; name: string; prefix: string };
}

/** Wallet rate (gateway is authoritative; env fallback keeps keys usable when it is down). */
async function walletRate(orgId: string) {
  const res = await gatewayApi.wallet(orgId);
  return res.ok ? res.data.vndPerUsd : env().vndPerUsd;
}

export async function createKeyAction(_prev: CreateKeyState, form: FormData): Promise<CreateKeyState> {
  const session = await requireSession();
  const { t } = await getI18n();
  const name = String(form.get('name') ?? '')
    .trim()
    .slice(0, 80);
  if (!name) return { error: t.keys.nameRequired, field: 'name' };

  const all = form.get('scope_all') === 'on';
  const picked = form
    .getAll('scopes')
    .filter((s): s is ProductId => (PRODUCT_IDS as string[]).includes(String(s)));
  const scopes: (ProductId | '*')[] = all || picked.length === 0 ? ['*'] : picked;

  let spendLimitMicros: number | null = null;
  if (form.get('cap_on') === 'on') {
    const vnd = parseVndInput(String(form.get('cap') ?? ''));
    if (!vnd || vnd <= 0) return { error: t.keys.capInvalid, field: 'cap' };
    spendLimitMicros = vndToMicros(vnd, await walletRate(session.org.id));
  }

  try {
    const { core } = await platform();
    const { key, record } = await core.createApiKey(session.org.id, { name, scopes, spendLimitMicros });
    revalidatePath('/console/keys');
    return { created: { key, name: record.name, prefix: record.prefix } };
  } catch (err) {
    console.error('[web] create key failed', appErrorCode(err), err);
    return { error: t.auth.unavailable };
  }
}

export async function revokeKeyAction(keyId: string): Promise<{ ok: boolean }> {
  const session = await requireSession();
  try {
    const { core } = await platform();
    await core.revokeApiKey(session.org.id, keyId);
  } catch (err) {
    if (appErrorCode(err) !== 'not_found') console.error('[web] revoke key failed', err);
    return { ok: false };
  }
  revalidatePath('/console/keys');
  return { ok: true };
}

export async function updateCapAction(
  keyId: string,
  capVnd: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const session = await requireSession();
  const { t } = await getI18n();
  let micros: number | null = null;
  if (capVnd !== null) {
    const vnd = parseVndInput(capVnd);
    if (!vnd || vnd <= 0) return { ok: false, error: t.keys.capInvalid };
    micros = vndToMicros(vnd, await walletRate(session.org.id));
  }
  const ok = await setKeySpendLimit(session.org.id, keyId, micros).catch(() => false);
  revalidatePath('/console/keys');
  return { ok };
}
