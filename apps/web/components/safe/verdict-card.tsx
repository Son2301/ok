'use client';

import { CircleAlert, MessageCircle, Phone, ShieldAlert, Siren, Target } from 'lucide-react';
import { useState } from 'react';
import { CopyButton } from '@/components/client';
import { useI18n } from '@/components/i18n-provider';
import { Badge, Button, type Tone } from '@/components/ui';
import { cx } from '@/lib/cx';
import { formatDateTime } from '@/lib/format';
import { fmt } from '@/lib/i18n';
import { riskTone } from '@/lib/status';
import { MEDIA_KINDS, type Verdict } from '@/lib/types/safe';

const BAND: Record<Tone, string> = {
  danger: 'bg-danger-soft text-danger-ink border-danger/30',
  orange: 'bg-orange-soft text-orange-ink border-orange/30',
  warn: 'bg-warn-soft text-warn-ink border-warn/30',
  info: 'bg-info-soft text-info-ink border-info/25',
  neutral: 'bg-surface-2 text-fg border-line',
  ok: 'bg-ok-soft text-ok-ink border-ok/30',
  accent: 'bg-accent-soft text-accent-ink border-accent/30',
};
const METER: Record<Tone, string> = {
  danger: 'bg-danger',
  orange: 'bg-orange',
  warn: 'bg-warn',
  info: 'bg-info',
  neutral: 'bg-faint',
  ok: 'bg-ok',
  accent: 'bg-accent',
};

/**
 * One verdict, rendered with the API's own wording. We never print "an toàn"
 * / "safe": low results read "Chưa phát hiện dấu hiệu lừa đảo" and media
 * results talk about warning signs, never real vs fake.
 */
export function VerdictCard({ verdict: v, onReset }: { verdict: Verdict; onReset?: () => void }) {
  const { t, locale } = useI18n();
  const S = t.safe;
  const tone = riskTone(v.level);
  const media = MEDIA_KINDS.includes(v.kind) || v.kind === 'ai_text';
  const headline = (media ? S.headlineMedia : S.headline)[v.level];
  const risks = v.signals.filter((s) => s.weight > 0);
  const trusts = v.signals.filter((s) => s.weight < 0);
  const info = v.signals.filter((s) => s.weight === 0);
  const goal = v.details?.scammerGoal;
  const warned = Array.isArray(v.details?.policeWarnedScripts) ? v.details.policeWarnedScripts : [];
  const share = v.shareText[locale] || v.shareText.vi;
  const recs = v.recommendations[locale]?.length ? v.recommendations[locale] : v.recommendations.vi;
  const paid = v.ifAlreadyPaid
    ? v.ifAlreadyPaid[locale]?.length
      ? v.ifAlreadyPaid[locale]
      : v.ifAlreadyPaid.vi
    : [];
  const disclaimer =
    typeof v.details?.disclaimer === 'string' ? v.details.disclaimer : v.details?.disclaimer?.[locale];

  return (
    <article
      className="animate-pop overflow-hidden rounded-2xl border border-line bg-surface shadow-pop"
      aria-labelledby={`v-${v.id}`}
    >
      <header className={cx('border-b px-5 py-4 sm:px-6', BAND[tone])}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            {tone === 'danger' || tone === 'orange' ? (
              <ShieldAlert className="size-6" aria-hidden />
            ) : (
              <CircleAlert className="size-6" aria-hidden />
            )}
            <h2 id={`v-${v.id}`} className="text-xl font-semibold tracking-tight">
              {headline}
            </h2>
          </div>
          <div className="text-sm font-medium tabular-nums">{fmt(S.score, { score: v.score })}</div>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/10" aria-hidden>
          <div
            className={cx('h-full rounded-full', METER[tone])}
            style={{ width: `${Math.max(3, v.score)}%` }}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 text-xs opacity-90">
          <span>{S.kind[v.kind]}</span>
          <span aria-hidden>·</span>
          <span className="max-w-full truncate font-mono">{v.input}</span>
        </div>
      </header>

      <div className="space-y-6 px-5 py-5 sm:px-6">
        <p className="text-[1.0625rem] leading-relaxed">{v.summary[locale] || v.summary.vi}</p>

        {goal && (
          <div className="flex gap-3 rounded-xl bg-surface-2 p-4">
            <Target className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden />
            <div>
              <h3 className="text-sm font-semibold">{S.scammerGoal}</h3>
              <p className="mt-1 text-sm">{goal[locale] || goal.vi}</p>
            </div>
          </div>
        )}

        {warned.length > 0 && (
          <div className="flex gap-3 rounded-xl border border-warn/30 bg-warn-soft p-4 text-warn-ink">
            <Siren className="mt-0.5 size-5 shrink-0" aria-hidden />
            <div>
              <h3 className="text-sm font-semibold">{S.policeWarned}</h3>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm">
                {warned.map((w) => (
                  <li key={w.vi}>{w[locale] || w.vi}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {risks.length > 0 && (
          <section>
            <h3 className="text-sm font-semibold">{S.redFlags}</h3>
            <ul className="mt-2 space-y-2">
              {risks.map((s) => (
                <li key={s.id} className="flex gap-2.5 text-sm">
                  <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-danger" />
                  <div className="min-w-0">
                    <div>{s.label[locale] || s.label.vi}</div>
                    {s.evidence && (
                      <div className="mt-0.5 font-mono text-xs break-all text-muted">{s.evidence}</div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {trusts.length > 0 && (
          <section>
            <h3 className="text-sm font-semibold">{S.trustSignals}</h3>
            <ul className="mt-2 space-y-2">
              {trusts.map((s) => (
                <li key={s.id} className="flex gap-2.5 text-sm">
                  <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-info" />
                  <div className="min-w-0">
                    <div>{s.label[locale] || s.label.vi}</div>
                    {s.evidence && (
                      <div className="mt-0.5 font-mono text-xs break-all text-muted">{s.evidence}</div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {recs.length > 0 && (
          <section>
            <h3 className="text-sm font-semibold">{S.todo}</h3>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm marker:text-muted">
              {recs.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ol>
          </section>
        )}

        {paid.length > 0 && (
          <section className="rounded-xl border-2 border-danger/40 bg-danger-soft p-4 text-danger-ink">
            <h3 className="flex items-center gap-2 font-semibold">
              <Phone className="size-4" aria-hidden />
              {S.alreadyPaidTitle}
            </h3>
            <p className="mt-1 text-sm">{S.alreadyPaidBody}</p>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm">
              {paid.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ol>
          </section>
        )}

        {disclaimer && <p className="text-xs text-muted">{disclaimer}</p>}

        <ShareRow text={share} />

        <details className="group rounded-xl border border-line">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
            <span className="inline-block transition-transform group-open:rotate-90" aria-hidden>
              ›
            </span>{' '}
            {S.howTitle}
          </summary>
          <div className="space-y-4 border-t border-line px-4 py-3">
            <p className="text-xs text-muted">{S.howBody}</p>
            <ul className="space-y-1.5">
              {v.sources.map((s) => (
                <li key={s.name} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="font-mono text-xs">{s.name}</span>
                  <span className="flex items-center gap-2">
                    {s.detail && (
                      <span className="max-w-64 truncate text-xs text-muted" title={s.detail}>
                        {s.detail}
                      </span>
                    )}
                    <Badge tone={s.status === 'ok' ? 'ok' : s.status === 'error' ? 'danger' : 'neutral'}>
                      {S.sourceStatus[s.status]}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
            {info.length > 0 && (
              <div>
                <h4 className="text-xs font-medium text-muted">{S.otherSignals}</h4>
                <ul className="mt-1 space-y-1 text-sm">
                  {info.map((s) => (
                    <li key={s.id}>
                      {s.label[locale] || s.label.vi}
                      {s.evidence && <span className="ml-1 font-mono text-xs text-muted">{s.evidence}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-muted">
              <dt>{S.checkId}</dt>
              <dd className="font-mono">{v.id}</dd>
              <dt>{t.receipt.when}</dt>
              <dd>
                {formatDateTime(v.checkedAt, locale)}
                {v.cached ? ` · ${S.cached}` : ''}
              </dd>
            </dl>
            <p className="text-xs text-muted">{S.limits}</p>
          </div>
        </details>

        {onReset && (
          <Button variant="secondary" onClick={onReset}>
            {S.checkAnother}
          </Button>
        )}
      </div>
    </article>
  );
}

function ShareRow({ text }: { text: string }) {
  const { t } = useI18n();
  const S = t.safe;
  const [note, setNote] = useState<string | null>(null);

  async function zalo() {
    // Phones: the native share sheet lists Zalo. Desktop: copy, then open Zalo Web to paste.
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await navigator.share({ text });
        return;
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
    window.open('https://chat.zalo.me/', '_blank', 'noopener,noreferrer');
    setNote(S.shareZaloCopied);
  }

  return (
    <section className="rounded-xl bg-surface-2 p-4">
      <h3 className="text-sm font-semibold">{S.shareTitle}</h3>
      <p className="mt-0.5 text-sm text-muted">{S.shareBody}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={zalo}>
          <MessageCircle className="size-4" aria-hidden />
          {S.shareZalo}
        </Button>
        <CopyButton value={text} label={S.shareCopy} size="md" />
      </div>
      {note && (
        <p role="status" className="mt-2 text-sm text-muted">
          {note}
        </p>
      )}
    </section>
  );
}
