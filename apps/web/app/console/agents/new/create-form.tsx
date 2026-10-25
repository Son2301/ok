'use client';

import { useActionState, useState } from 'react';
import { SubmitButton } from '@/components/client';
import { useI18n } from '@/components/i18n-provider';
import { Field, Notice } from '@/components/ui';
import { cx } from '@/lib/cx';
import { formatMicrosVnd, formatNumber, formatTokens } from '@/lib/format';
import { fmt } from '@/lib/i18n';
import type { Plan } from '@/lib/types/agents';
import { createAgentAction, type FormState } from '../actions';

const TEMPLATE_IDS = ['cs', 'orders', 'debt', 'blank'] as const;
type TemplateId = (typeof TEMPLATE_IDS)[number];
const DEFAULT_BUDGET_VND = 200_000;

export function CreateAgentForm({
  plans,
  agents,
  models,
  rate,
}: {
  plans: Plan[];
  agents: { id: string; name: string }[];
  models: string[];
  rate: number;
}) {
  const { t, locale } = useI18n();
  const A = t.agents;
  const [state, action] = useActionState<FormState, FormData>(createAgentAction, {});
  const [tpl, setTpl] = useState<TemplateId>('cs');
  const [budgetOn, setBudgetOn] = useState(true);
  const template = A.templates[tpl];

  return (
    <form action={action} className="space-y-6">
      {state.error && <Notice tone="danger">{state.error}</Notice>}

      <fieldset>
        <legend className="text-sm font-medium">{A.templatesTitle}</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {TEMPLATE_IDS.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={tpl === id}
              onClick={() => setTpl(id)}
              className={cx(
                'rounded-xl border p-3 text-left transition-colors',
                tpl === id
                  ? 'border-accent bg-accent-soft ring-1 ring-accent'
                  : 'border-line bg-surface hover:bg-surface-2',
              )}
            >
              <div className="text-sm font-medium">{A.templates[id].label}</div>
              <div className="mt-0.5 text-xs text-muted">{A.templates[id].hint}</div>
            </button>
          ))}
        </div>
      </fieldset>

      {/* key={tpl} resets the uncontrolled fields when another template is picked */}
      <div key={tpl} className="grid gap-4 sm:grid-cols-2">
        <Field label={A.fieldName} htmlFor="a-name" hint={A.fieldNameHint}>
          <input
            id="a-name"
            name="name"
            required
            maxLength={80}
            defaultValue={template.name}
            className="input"
          />
        </Field>
        <Field label={A.fieldRole} htmlFor="a-role">
          <input id="a-role" name="role" maxLength={120} defaultValue={template.role} className="input" />
        </Field>
        <Field label={A.fieldJd} htmlFor="a-jd" hint={A.fieldJdHint} className="sm:col-span-2">
          <textarea
            id="a-jd"
            name="jobDescription"
            rows={10}
            maxLength={20_000}
            defaultValue={template.jd}
            className="input text-sm leading-relaxed"
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={A.fieldModel} htmlFor="a-model" hint={A.fieldModelHint}>
          <select id="a-model" name="model" defaultValue="auto" className="input">
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label={A.fieldReportsTo} htmlFor="a-reports">
          <select id="a-reports" name="reportsTo" defaultValue="" className="input">
            <option value="">{A.reportsToOwner}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {plans.length > 0 && (
        <fieldset>
          <legend className="text-sm font-medium">{A.fieldPlan}</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {plans.map((p, i) => (
              <label
                key={p.id}
                className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
              >
                <input
                  type="radio"
                  name="plan"
                  value={p.id}
                  defaultChecked={i === 0}
                  className="mt-1 accent-[var(--accent)]"
                />
                <span className="text-sm">
                  {fmt(A.planLine, {
                    name: p.name,
                    month: formatMicrosVnd(p.monthlyPriceMicros, rate, locale),
                    tokens: formatTokens(p.includedTokensPerMonth, locale),
                  })}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="rounded-xl border border-line p-4">
        <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium">
          <input
            type="checkbox"
            name="budget_on"
            checked={budgetOn}
            onChange={(e) => setBudgetOn(e.target.checked)}
            className="size-4 accent-[var(--accent)]"
          />
          {A.fieldBudget}
        </label>
        {budgetOn ? (
          <div className="mt-3 max-w-xs">
            <input
              name="budget"
              inputMode="decimal"
              aria-label={A.fieldBudget}
              defaultValue={formatNumber(DEFAULT_BUDGET_VND, locale)}
              className="input"
            />
            <p className="mt-2 text-xs text-muted">{A.fieldBudgetHint}</p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-warn">{A.budgetOff}</p>
        )}
      </div>

      <input type="hidden" name="language" value={locale} />
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel={t.common.loading}>{A.createSubmit}</SubmitButton>
        <p className="text-sm text-muted">{A.createNote}</p>
      </div>
    </form>
  );
}
