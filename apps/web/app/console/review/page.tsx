import { CircleCheck, GitPullRequest, Lock, Settings } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { RelativeTime } from '@/components/client';
import { Money, ServiceProblem } from '@/components/console';
import {
  Badge,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Notice,
  PageHeader,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { formatDuration, formatMicrosVnd, formatNumber } from '@/lib/format';
import { fmt, getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { reviewApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import { reviewStatusTone, severityTone } from '@/lib/status';
import { SEVERITIES } from '@/lib/types/review';
import { getWallet } from '@/lib/wallet';
import { UnlinkButton } from './review-client';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).review.title };
}

export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ linked?: string; repo?: string }>;
}) {
  const session = await requireSession();
  const { t, locale } = await getI18n();
  const sp = await searchParams;
  const orgId = session.org.id;
  const R = t.review;
  const repoFilter = sp.repo && /^[\w.-]+\/[\w.-]+$/.test(sp.repo) ? sp.repo : undefined;

  const [installs, installUrl, reviews, usage, wallet] = await Promise.all([
    reviewApi.installations(orgId),
    reviewApi.installUrl(orgId),
    reviewApi.reviews(orgId, { limit: 50, repo: repoFilter }),
    reviewApi.usage(orgId),
    getWallet(orgId),
  ]);
  const rate = wallet.summary.vndPerUsd;

  if (!installs.ok && installs.error.kind !== 'http') {
    return (
      <>
        <PageHeader title={R.title} description={R.subtitle} />
        <ServiceProblem error={installs.error} t={t} />
      </>
    );
  }

  const installations = installs.ok ? installs.data.installations : [];

  return (
    <>
      <PageHeader title={R.title} description={R.subtitle} />

      {sp.linked && /^\d+$/.test(sp.linked) && (
        <Notice tone="ok" icon={<CircleCheck className="size-4" aria-hidden />} className="mb-4">
          {fmt(R.linkedBanner, { id: sp.linked })}
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <Card>
          <CardHeader title={R.installTitle} description={R.installBody} />
          <CardBody>
            {installUrl.ok && installUrl.data.url ? (
              <ButtonLink href={installUrl.data.url}>
                <GitPullRequest className="size-4" aria-hidden />
                {R.installButton}
              </ButtonLink>
            ) : installUrl.ok ? (
              <Notice tone="neutral">{R.notConfigured}</Notice>
            ) : (
              <ServiceProblem error={installUrl.error} t={t} />
            )}
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            {usage.ok ? (
              <>
                <div className="text-sm text-muted">{fmt(R.usageTitle, { period: usage.data.period })}</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {formatMicrosVnd(usage.data.costMicros, rate, locale, { precise: true })}
                </div>
                <div className="mt-1 text-sm text-muted">
                  {fmt(R.usageReviews, { n: formatNumber(usage.data.reviews, locale) })}
                </div>
              </>
            ) : (
              <div className="text-sm text-muted">—</div>
            )}
          </CardBody>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader title={R.installationsTitle} />
        {installations.length === 0 ? (
          <EmptyState title={R.installationsEmpty} />
        ) : (
          <ul className="mt-3 divide-y divide-line border-t border-line">
            {installations.map((inst) => (
              <li key={inst.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{inst.account}</span>
                    <span className="font-mono text-xs text-muted">#{inst.id}</span>
                    {inst.status !== 'active' && <Badge tone="warn">{inst.status}</Badge>}
                    <span className="text-sm text-muted">{fmt(R.repos, { n: inst.repos.length })}</span>
                  </div>
                  <UnlinkButton id={inst.id} account={inst.account} />
                </div>
                {inst.repos.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-2">
                    {inst.repos.map((r) => (
                      <li
                        key={r.id}
                        className="flex items-center gap-1 rounded-lg border border-line bg-surface-2 py-1 pr-1 pl-2.5 text-sm"
                      >
                        {r.private && <Lock className="size-3 text-muted" aria-label={R.private} />}
                        <Link
                          href={`/console/review?repo=${encodeURIComponent(r.fullName)}`}
                          className="font-mono text-xs hover:underline"
                        >
                          {r.fullName}
                        </Link>
                        {!r.active && <Badge>{R.inactive}</Badge>}
                        <Link
                          href={`/console/review/repos/${r.fullName}`}
                          className="grid size-6 place-items-center rounded hover:bg-surface-3"
                          aria-label={`${R.settings} ${r.fullName}`}
                        >
                          <Settings className="size-3.5" aria-hidden />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader
          title={R.reviewsTitle}
          action={
            repoFilter && (
              <Link href="/console/review" className="text-sm text-accent hover:underline">
                <span className="font-mono">{repoFilter}</span> ✕
              </Link>
            )
          }
        />
        <div className="mt-3">
          {!reviews.ok ? (
            <div className="px-5 pb-5">
              <ServiceProblem error={reviews.error} t={t} />
            </div>
          ) : reviews.data.reviews.length === 0 ? (
            <EmptyState icon={<GitPullRequest className="size-5" />} title={R.reviewsEmpty} />
          ) : (
            <Table label={R.reviewsTitle}>
              <thead>
                <tr>
                  <Th>{R.colPr}</Th>
                  <Th>{R.colStatus}</Th>
                  <Th>{R.colFindings}</Th>
                  <Th align="right">{R.colCost}</Th>
                  <Th align="right">{R.colDuration}</Th>
                  <Th align="right">{R.colWhen}</Th>
                </tr>
              </thead>
              <tbody>
                {reviews.data.reviews.map((r) => (
                  <tr key={r.id} className="hover:bg-surface-2">
                    <Td className="min-w-56">
                      <Link
                        href={`/console/review/${encodeURIComponent(r.id)}`}
                        className="font-medium text-accent hover:underline"
                      >
                        {r.prTitle || `#${r.prNumber}`}
                      </Link>
                      <div className="mt-0.5 font-mono text-xs text-muted">
                        {r.repo}#{r.prNumber}
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={reviewStatusTone(r.status)} dot>
                        {(R.status as Record<string, string>)[r.status] ?? r.status}
                      </Badge>
                      {r.billedTo === 'platform' && (
                        <div className="mt-1 text-xs text-muted">{R.billedPlatform}</div>
                      )}
                    </Td>
                    <Td>
                      {r.findingsCount === 0 ? (
                        <span className="text-sm text-muted">
                          {r.status === 'completed' ? R.noFindings : '—'}
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {SEVERITIES.filter((s) => r.findings[s] > 0).map((s) => (
                            <Badge key={s} tone={severityTone(s)}>
                              {r.findings[s]} {R.severity[s]}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </Td>
                    <Td align="right">
                      <Money micros={r.costMicros} rate={rate} locale={locale} precise />
                    </Td>
                    <Td align="right">{formatDuration(r.durationMs, locale)}</Td>
                    <Td align="right" className="whitespace-nowrap text-muted">
                      <RelativeTime date={r.createdAt} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Card>
    </>
  );
}
