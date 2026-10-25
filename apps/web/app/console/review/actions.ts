'use server';

import { revalidatePath } from 'next/cache';
import { getI18n } from '@/lib/i18n/server';
import { reviewApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import type { RepoSettingsOverride, Severity } from '@/lib/types/review';

export async function unlinkInstallationAction(id: number): Promise<{ ok: boolean; error?: string }> {
  const session = await requireSession();
  const res = await reviewApi.unlink(session.org.id, id);
  revalidatePath('/console/review');
  return res.ok ? { ok: true } : { ok: false, error: res.error.message };
}

export async function rerunReviewAction(
  target: string,
  full: boolean,
): Promise<{ ok: boolean; message: string }> {
  const session = await requireSession();
  const { t } = await getI18n();
  if (!/^[\w.-]+\/[\w.-]+#\d+$/.test(target)) return { ok: false, message: 'Invalid target' };
  const res = await reviewApi.run(session.org.id, target, full);
  return res.ok ? { ok: true, message: t.review.rerunQueued } : { ok: false, message: res.error.message };
}

export interface SettingsState {
  ok?: boolean;
  error?: string;
}

const SEVERITIES: Severity[] = ['low', 'medium', 'high', 'critical'];

/** Build a partial `.okreview.yml` override: empty fields mean "use the file / default". */
export async function saveRepoSettingsAction(_prev: SettingsState, form: FormData): Promise<SettingsState> {
  const session = await requireSession();
  const { t } = await getI18n();
  const repo = String(form.get('repo') ?? '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { error: 'Invalid repository' };

  const s: RepoSettingsOverride = {};
  const pick = (name: string) => {
    const v = String(form.get(name) ?? '');
    return v === '' ? undefined : v;
  };
  const lang = pick('language');
  if (lang === 'en' || lang === 'vi') s.language = lang;
  const threshold = pick('severityThreshold');
  if (threshold && SEVERITIES.includes(threshold as Severity)) s.severityThreshold = threshold as Severity;
  const failOn = pick('failOn');
  if (failOn === 'none' || (failOn && SEVERITIES.includes(failOn as Severity)))
    s.failOn = failOn as Severity | 'none';
  const max = pick('maxComments');
  if (max !== undefined) {
    const n = Number(max);
    if (!Number.isInteger(n) || n < 0 || n > 50) return { error: `${t.review.fieldMaxComments}: 0–50` };
    s.maxComments = n;
  }
  for (const key of ['reviewDrafts', 'keepPlausible', 'incremental'] as const) {
    const v = pick(key);
    if (v === 'true' || v === 'false') s[key] = v === 'true';
  }
  const exclude = String(form.get('exclude') ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (exclude.length) s.paths = { exclude };
  const instructions = String(form.get('instructions') ?? '').trim();
  if (instructions) s.instructions = instructions.slice(0, 4000);

  const res = await reviewApi.saveRepoSettings(session.org.id, repo, s);
  if (!res.ok) return { error: res.error.message };
  revalidatePath(`/console/review/repos/${repo}`);
  return { ok: true };
}
