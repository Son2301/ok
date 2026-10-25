'use server';

import { headers } from 'next/headers';
import { parseVndInput } from '@/lib/format';
import { forwardedFor } from '@/lib/http';
import { getI18n } from '@/lib/i18n/server';
import { type SafeCaller, safeApi } from '@/lib/services';
import { getSession } from '@/lib/session';
import { REPORT_CATEGORIES, REPORT_TYPES, type ReportType } from '@/lib/types/safe';

export interface ReportState {
  ok?: boolean;
  message?: string;
  error?: string;
}

export async function reportScamAction(_prev: ReportState, form: FormData): Promise<ReportState> {
  const { t, locale } = await getI18n();
  const type = String(form.get('type') ?? '') as ReportType;
  const value = String(form.get('value') ?? '').trim();
  const category = String(form.get('category') ?? '');
  if (!REPORT_TYPES.includes(type) || !(category in REPORT_CATEGORIES))
    return { error: t.safe.reportValueRequired };
  if (!value) return { error: t.safe.reportValueRequired };

  const description = String(form.get('description') ?? '')
    .trim()
    .slice(0, 2000);
  const amount = parseVndInput(String(form.get('amount') ?? ''));
  const bankName = String(form.get('bankName') ?? '')
    .trim()
    .slice(0, 80);

  const session = await getSession();
  const caller: SafeCaller = session
    ? { orgId: session.org.id, userId: session.user.id }
    : { anonymous: true, forwardedFor: forwardedFor(await headers()) };

  const res = await safeApi.report(caller, {
    type,
    value: value.slice(0, 2048),
    category,
    ...(description ? { description } : {}),
    ...(amount && amount > 0 ? { amountLostVnd: amount } : {}),
    ...(type === 'bank_account' && bankName ? { bankName } : {}),
  });
  if (!res.ok) {
    const vi = (res.error.details as { vi?: string } | undefined)?.vi;
    if (res.error.kind !== 'http') return { error: t.safe.serviceDown };
    return { error: locale === 'vi' && vi ? vi : res.error.message };
  }
  return { ok: true, message: res.data.message[locale] || res.data.message.vi };
}
