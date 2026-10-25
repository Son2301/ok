'use client';

import { useActionState } from 'react';
import { SubmitButton } from '@/components/client';
import { useI18n } from '@/components/i18n-provider';
import { Field, Notice } from '@/components/ui';
import { fmt } from '@/lib/i18n';
import type { RepoConfig, RepoSettingsOverride } from '@/lib/types/review';
import { type SettingsState, saveRepoSettingsAction } from '../../../actions';

const SEVS = ['low', 'medium', 'high', 'critical'] as const;

export function RepoSettingsForm({
  repo,
  settings,
  defaults,
}: {
  repo: string;
  settings: RepoSettingsOverride;
  defaults: RepoConfig;
}) {
  const { t } = useI18n();
  const R = t.review;
  const [state, action] = useActionState<SettingsState, FormData>(saveRepoSettingsAction, {});
  const def = (v: string | number | boolean) => fmt(R.useDefault, { value: String(v) });
  const bool = (v: boolean) => (v ? t.common.yes : t.common.no);
  const sevLabel = (s: string) => (R.severity as Record<string, string>)[s] ?? s;

  return (
    <form action={action} className="grid gap-5 sm:grid-cols-2">
      <input type="hidden" name="repo" value={repo} />
      <Field label={R.fieldLanguage} htmlFor="language">
        <select id="language" name="language" defaultValue={settings.language ?? ''} className="input">
          <option value="">{def(defaults.language)}</option>
          <option value="vi">Tiếng Việt</option>
          <option value="en">English</option>
        </select>
      </Field>
      <Field label={R.fieldThreshold} htmlFor="severityThreshold">
        <select
          id="severityThreshold"
          name="severityThreshold"
          defaultValue={settings.severityThreshold ?? ''}
          className="input"
        >
          <option value="">{def(sevLabel(defaults.severityThreshold))}</option>
          {SEVS.map((s) => (
            <option key={s} value={s}>
              {sevLabel(s)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={R.fieldMaxComments} htmlFor="maxComments">
        <input
          id="maxComments"
          name="maxComments"
          type="number"
          min={0}
          max={50}
          defaultValue={settings.maxComments ?? ''}
          placeholder={String(defaults.maxComments)}
          className="input"
        />
      </Field>
      <Field label={R.fieldFailOn} htmlFor="failOn">
        <select id="failOn" name="failOn" defaultValue={settings.failOn ?? ''} className="input">
          <option value="">
            {def(defaults.failOn === 'none' ? R.failOnNone : sevLabel(defaults.failOn))}
          </option>
          <option value="none">{R.failOnNone}</option>
          {SEVS.map((s) => (
            <option key={s} value={s}>
              {sevLabel(s)}
            </option>
          ))}
        </select>
      </Field>
      {(
        [
          ['reviewDrafts', R.fieldDrafts],
          ['keepPlausible', R.fieldPlausible],
          ['incremental', R.fieldIncremental],
        ] as const
      ).map(([key, label]) => (
        <Field key={key} label={label} htmlFor={key}>
          <select
            id={key}
            name={key}
            defaultValue={settings[key] === undefined ? '' : String(settings[key])}
            className="input"
          >
            <option value="">{def(bool(defaults[key]))}</option>
            <option value="true">{t.common.yes}</option>
            <option value="false">{t.common.no}</option>
          </select>
        </Field>
      ))}
      <Field label={R.fieldExclude} htmlFor="exclude" className="sm:col-span-2">
        <textarea
          id="exclude"
          name="exclude"
          rows={3}
          defaultValue={(settings.paths?.exclude ?? []).join('\n')}
          placeholder={'docs/**\n*.snap'}
          className="input font-mono text-sm"
        />
      </Field>
      <Field label={R.fieldInstructions} htmlFor="instructions" className="sm:col-span-2">
        <textarea
          id="instructions"
          name="instructions"
          rows={4}
          maxLength={4000}
          defaultValue={settings.instructions ?? ''}
          className="input"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <SubmitButton pendingLabel={t.common.saving}>{t.common.save}</SubmitButton>
        {state.ok && (
          <span role="status" className="text-sm text-ok">
            {R.settingsSaved}
          </span>
        )}
      </div>
      {state.error && (
        <Notice tone="danger" className="sm:col-span-2">
          {state.error}
        </Notice>
      )}
    </form>
  );
}
