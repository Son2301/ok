'use server';

import { revalidatePath } from 'next/cache';
import { appErrorCode } from '@/lib/errors';
import { getI18n } from '@/lib/i18n/server';
import { platform } from '@/lib/platform';
import type { ServiceErrorInfo } from '@/lib/service-client';
import { gatewayApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import type { Topup } from '@/lib/types/gateway';

export type TopupResult = { ok: true; topup: Topup } | { ok: false; unavailable: boolean; message: string };

export async function createTopupAction(amountVnd: number): Promise<TopupResult> {
  const session = await requireSession();
  const { t } = await getI18n();
  if (!Number.isInteger(amountVnd) || amountVnd <= 0)
    return { ok: false, unavailable: false, message: t.billing.invalidAmount };
  const res = await gatewayApi.createTopup(session.org.id, amountVnd);
  if (res.ok) return { ok: true, topup: res.data };
  return { ok: false, unavailable: isUnavailable(res.error), message: res.error.message };
}

function isUnavailable(e: ServiceErrorInfo) {
  // 503 `unavailable` = no bank account configured on the gateway. A down gateway is "try later", not "coming soon".
  return e.kind === 'http' && e.code === 'unavailable';
}

export interface ProfileState {
  ok?: boolean;
  error?: string;
  field?: 'taxCode' | 'invoiceEmail';
}

const clean = (v: FormDataEntryValue | null, max: number) => {
  const s = typeof v === 'string' ? v.trim().slice(0, max) : '';
  return s === '' ? null : s;
};

export async function saveProfileAction(_prev: ProfileState, form: FormData): Promise<ProfileState> {
  const session = await requireSession();
  const { t } = await getI18n();
  const taxCode = clean(form.get('taxCode'), 20);
  const invoiceEmail = clean(form.get('invoiceEmail'), 320);
  if (taxCode && !/^\d{10}(-\d{3})?$/.test(taxCode))
    return { error: t.billing.taxCodeInvalid, field: 'taxCode' };
  if (invoiceEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(invoiceEmail)) {
    return { error: t.billing.invoiceEmailInvalid, field: 'invoiceEmail' };
  }
  try {
    const { billing } = await platform();
    await billing.setProfile(session.org.id, {
      taxCode,
      invoiceEmail,
      companyName: clean(form.get('companyName'), 300),
      address: clean(form.get('address'), 500),
    });
  } catch (err) {
    if (appErrorCode(err) === 'bad_request') return { error: t.billing.taxCodeInvalid, field: 'taxCode' };
    console.error('[web] save billing profile failed', err);
    return { error: t.auth.unavailable };
  }
  revalidatePath('/console/billing');
  return { ok: true };
}
