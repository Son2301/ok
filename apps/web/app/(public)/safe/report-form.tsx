'use client';

import { useActionState, useState } from 'react';
import { SubmitButton } from '@/components/client';
import { useI18n } from '@/components/i18n-provider';
import { Field, Notice } from '@/components/ui';
import { REPORT_CATEGORIES, REPORT_TYPES, type ReportType } from '@/lib/types/safe';
import { type ReportState, reportScamAction } from './actions';

export function ReportForm() {
  const { t, locale } = useI18n();
  const S = t.safe;
  const [state, action] = useActionState<ReportState, FormData>(reportScamAction, {});
  const [type, setType] = useState<ReportType>('phone');

  if (state.ok) {
    return (
      <Notice tone="ok" title={state.message}>
        {S.reportBody}
      </Notice>
    );
  }

  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      {state.error && (
        <Notice tone="danger" className="sm:col-span-2">
          {state.error}
        </Notice>
      )}
      <Field label={S.reportType} htmlFor="r-type">
        <select
          id="r-type"
          name="type"
          value={type}
          onChange={(e) => setType(e.target.value as ReportType)}
          className="input"
        >
          {REPORT_TYPES.map((rt) => (
            <option key={rt} value={rt}>
              {S.reportTypes[rt]}
            </option>
          ))}
        </select>
      </Field>
      <Field label={S.reportCategory} htmlFor="r-category">
        <select id="r-category" name="category" defaultValue="impersonation_authority" className="input">
          {Object.entries(REPORT_CATEGORIES).map(([id, label]) => (
            <option key={id} value={id}>
              {label[locale]}
            </option>
          ))}
        </select>
      </Field>
      <Field label={S.reportValue} htmlFor="r-value" className="sm:col-span-2">
        <input
          id="r-value"
          name="value"
          required
          maxLength={2048}
          autoComplete="off"
          className="input font-mono"
        />
      </Field>
      {type === 'bank_account' && (
        <Field label={S.reportBank} htmlFor="r-bank" optionalLabel={t.common.optional}>
          <input id="r-bank" name="bankName" maxLength={80} className="input" />
        </Field>
      )}
      <Field label={S.reportAmount} htmlFor="r-amount" optionalLabel={t.common.optional}>
        <input id="r-amount" name="amount" inputMode="decimal" placeholder="5tr" className="input" />
      </Field>
      <Field
        label={S.reportDescription}
        htmlFor="r-desc"
        className="sm:col-span-2"
        optionalLabel={t.common.optional}
      >
        <textarea
          id="r-desc"
          name="description"
          maxLength={2000}
          rows={3}
          placeholder={S.reportDescriptionPlaceholder}
          className="input"
        />
      </Field>
      <div className="sm:col-span-2">
        <SubmitButton variant="secondary" pendingLabel={S.reportSending}>
          {S.reportSubmit}
        </SubmitButton>
      </div>
    </form>
  );
}
