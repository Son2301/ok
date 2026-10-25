import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Money, Receipt, ServiceProblem } from '@/components/console';
import { Badge, Card, CardBody, CardHeader, Notice, PageHeader } from '@/components/ui';
import type { Locale } from '@/lib/format';
import { formatDateTime, formatDuration, formatPercent } from '@/lib/format';
import { type Dict, fmt, getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { reviewApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import { reviewStatusTone, severityTone } from '@/lib/status';
import type { ReviewFinding } from '@/lib/types/review';
import { getWallet } from '@/lib/wallet';
import { RerunButtons } from '../review-client';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).review.title };
}

const SHOWN = new Set(['posted', 'general', 'digest']);

export default async function ReviewDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { t, locale } = await getI18n();
  const { id } = await params;
  const R = t.review;
  const [res, wallet] = await Promise.all([reviewApi.review(session.org.id, id), getWallet(session.org.id)]);
  const rate = wallet.summary.vndPerUsd;

  const back = (
    <Link
      href="/console/review"
      className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {R.reviewsTitle}
    </Link>
  );
  if (!res.ok) {
    return (
      <>
        {back}
        <ServiceProblem error={res.error} t={t} />
      </>
    );
  }

  const { review: r, findings } = res.data;
  const posted = findings.filter((f) => SHOWN.has(f.status));
  const rejected = findings.filter(
    (f) => !SHOWN.has(f.status) && (f.verdict === 'rejected' || f.status === 'rejected'),
  );
  const other = findings.filter(
    (f) => !SHOWN.has(f.status) && f.verdict !== 'rejected' && f.status !== 'rejected',
  );
  const s = r.stats;

  return (
    <>
      {back}
      <PageHeader
        eyebrow={<span className="font-mono">{r.repo}</span>}
        title={r.prTitle ? `${r.prTitle}` : fmt(R.detailTitle, { n: r.prNumber })}
        description={fmt(R.detailTitle, { n: r.prNumber })}
        action={
          <Badge tone={reviewStatusTone(r.status)} dot>
            {(R.status as Record<string, string>)[r.status] ?? r.status}
          </Badge>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          {s && (
            <Card>
              <CardBody>
                <p className="text-sm">
                  {fmt(R.statsLine, {
                    candidates: s.candidates,
                    confirmed: s.confirmed,
                    plausible: s.plausible,
                    rejected: s.rejected,
                  })}
                </p>
                <p className="mt-1 text-xs text-muted">{fmt(R.filesReviewed, { n: s.filesReviewed })}</p>
              </CardBody>
            </Card>
          )}
          {r.error && (
            <Notice tone="danger" title={R.error}>
              {r.error}
            </Notice>
          )}
          {r.configError && (
            <Notice tone="warn" title={R.configError}>
              {r.configError}
            </Notice>
          )}
          {r.statusReason && r.status !== 'completed' && <Notice tone="neutral">{r.statusReason}</Notice>}

          <FindingGroup
            title={R.postedTitle}
            body={R.postedBody}
            empty={R.postedEmpty}
            findings={posted}
            t={t}
            locale={locale}
          />
          <FindingGroup
            title={R.rejectedTitle}
            body={R.rejectedBody}
            empty={R.rejectedEmpty}
            findings={rejected}
            t={t}
            locale={locale}
            showCritic
          />
          {other.length > 0 && (
            <FindingGroup
              title={R.otherTitle}
              body={R.otherBody}
              empty=""
              findings={other}
              t={t}
              locale={locale}
              showCritic
            />
          )}

          {s && (s.skipped.length > 0 || s.warnings.length > 0) && (
            <Card>
              <CardBody className="space-y-4 text-sm">
                {s.skipped.length > 0 && (
                  <div>
                    <h3 className="font-medium">{R.skippedFiles}</h3>
                    <ul className="mt-1.5 space-y-1">
                      {s.skipped.map((f) => (
                        <li key={f.path} className="flex flex-wrap justify-between gap-2">
                          <span className="font-mono text-xs">{f.path}</span>
                          <span className="text-xs text-muted">{f.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {s.warnings.length > 0 && (
                  <div>
                    <h3 className="font-medium">{R.warnings}</h3>
                    <ul className="mt-1.5 list-disc space-y-1 pl-5 text-muted">
                      {s.warnings.map((w) => (
                        <li key={w}>{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardBody>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Receipt
            title={t.receipt.title}
            rows={[
              { label: t.receipt.what, value: `${r.repo}#${r.prNumber}` },
              { label: t.receipt.product, value: 'Review' },
              ...(r.models
                ? [
                    {
                      label: 'Reviewer',
                      value: <span className="font-mono text-xs">{r.models.reviewer}</span>,
                    },
                    { label: 'Critic', value: <span className="font-mono text-xs">{r.models.critic}</span> },
                  ]
                : []),
              {
                label: t.receipt.cost,
                value: <Money micros={r.costMicros} rate={rate} locale={locale} precise usd />,
                strong: true,
              },
              { label: t.receipt.latency, value: formatDuration(r.durationMs, locale) },
              {
                label: R.trigger,
                value: `${r.trigger} · ${(R.mode as Record<string, string>)[r.mode] ?? r.mode}`,
              },
              { label: t.receipt.when, value: formatDateTime(r.createdAt, locale) },
              ...(r.headSha
                ? [
                    {
                      label: 'SHA',
                      value: <span className="font-mono text-xs">{r.headSha.slice(0, 12)}</span>,
                    },
                  ]
                : []),
              ...(r.billedTo === 'platform' ? [{ label: t.receipt.amount, value: R.billedPlatform }] : []),
            ]}
          />
          <RerunButtons target={`${r.repo}#${r.prNumber}`} />
        </div>
      </div>
    </>
  );
}

function FindingGroup({
  title,
  body,
  empty,
  findings,
  t,
  locale,
  showCritic,
}: {
  title: string;
  body: string;
  empty: string;
  findings: ReviewFinding[];
  t: Dict;
  locale: Locale;
  showCritic?: boolean;
}) {
  const R = t.review;
  return (
    <Card>
      <CardHeader title={`${title} (${findings.length})`} description={body} />
      <CardBody>
        {findings.length === 0 ? (
          <p className="text-sm text-muted">{empty}</p>
        ) : (
          <ul className="space-y-4">
            {findings.map((f) => (
              <li key={f.id} className="rounded-xl border border-line p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={severityTone(f.severity)}>{R.severity[f.severity]}</Badge>
                  <span className="text-xs text-muted">{f.category}</span>
                  <Badge
                    tone={f.verdict === 'rejected' ? 'neutral' : f.verdict === 'confirmed' ? 'ok' : 'info'}
                  >
                    {R.verdict[f.verdict]}
                  </Badge>
                  {f.status !== 'posted' && f.status !== 'rejected' && (
                    <span className="text-xs text-muted">
                      {(R.findingStatus as Record<string, string>)[f.status] ?? f.status}
                    </span>
                  )}
                </div>
                <h4 className="mt-2 font-medium">{f.title}</h4>
                <div className="mt-0.5 font-mono text-xs text-muted">
                  {f.path}:{f.line}
                  {f.endLine && f.endLine !== f.line ? `-${f.endLine}` : ''}
                </div>
                <p className="mt-2 text-sm whitespace-pre-wrap">{f.body}</p>
                {f.failureScenario && (
                  <div className="mt-3 text-sm">
                    <div className="font-medium">{R.failureScenario}</div>
                    <p className="mt-0.5 whitespace-pre-wrap text-muted">{f.failureScenario}</p>
                  </div>
                )}
                {(f.replacement || f.suggestion) && (
                  <div className="mt-3 text-sm">
                    <div className="font-medium">{R.suggestion}</div>
                    {f.replacement ? (
                      <pre className="mt-1 overflow-x-auto rounded-lg bg-surface-2 p-3 text-xs">
                        <code>{f.replacement}</code>
                      </pre>
                    ) : (
                      <p className="mt-0.5 text-muted">{f.suggestion}</p>
                    )}
                  </div>
                )}
                {(showCritic || f.criticReason) && f.criticReason && (
                  <div className="mt-3 rounded-lg bg-surface-2 p-3 text-sm">
                    <div className="font-medium">{R.criticReason}</div>
                    <p className="mt-0.5 whitespace-pre-wrap text-muted">{f.criticReason}</p>
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-x-3 text-xs text-muted">
                  <span>{fmt(R.confidence, { n: formatPercent(f.confidence, locale) })}</span>
                  {f.statusReason && <span>{f.statusReason}</span>}
                  {f.dismissedReason && <span>{f.dismissedReason}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
