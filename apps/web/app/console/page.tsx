import { ArrowRight, Bot, GitPullRequest, KeyRound, MessageSquare, QrCode, ScanSearch } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { RelativeTime } from '@/components/client';
import { BarChart, CodeBlock, Money, ShareBars } from '@/components/console';
import { ButtonLink, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader } from '@/components/ui';
import { env } from '@/lib/env';
import { formatDayKey, formatMicrosVnd, formatNumber } from '@/lib/format';
import { fmt, getDictionary, plural } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { describeEntry, entrySourceHref, productName, toLedgerEntry } from '@/lib/ledger';
import { platform } from '@/lib/platform';
import { requireSession } from '@/lib/session';
import { gatewayCurl } from '@/lib/snippets';
import { dailySpend, getWallet, listLedger, spendByProduct } from '@/lib/wallet';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).overview.title };
}

export default async function OverviewPage() {
  const session = await requireSession();
  const { t, locale } = await getI18n();
  const orgId = session.org.id;
  const cfg = env();

  const [wallet, byProduct, byDay, recent, keys] = await Promise.all([
    getWallet(orgId),
    spendByProduct(orgId, 30),
    dailySpend(orgId, 30),
    listLedger(orgId, { limit: 8 }),
    platform().then(({ core }) => core.listApiKeys(orgId)),
  ]);
  const { summary } = wallet;
  const rate = summary.vndPerUsd;
  const totalSpend = byProduct.reduce((s, p) => s + p.micros, 0);
  const name = session.user.name || session.org.name;
  const O = t.overview;

  const forecast =
    summary.forecastDaysLeft === null
      ? O.forecastNone
      : summary.forecastDaysLeft <= 0
        ? O.forecastZero
        : fmt(O.forecast, { n: formatNumber(summary.forecastDaysLeft, locale) });

  const quick = [
    { href: '/console/billing#topup', label: O.quick.topup, icon: QrCode },
    { href: '/console/keys', label: O.quick.key, icon: KeyRound },
    { href: '/console/gateway/playground', label: O.quick.playground, icon: MessageSquare },
    { href: '/console/agents/new', label: O.quick.agents, icon: Bot },
    { href: '/safe', label: O.quick.safe, icon: ScanSearch },
    { href: '/console/review', label: O.quick.review, icon: GitPullRequest },
  ];

  return (
    <>
      <PageHeader title={fmt(O.greeting, { name })} />

      {wallet.source === 'local' && (
        <Notice tone="neutral" className="mb-4">
          {t.console.localWallet}
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <Card>
          <CardBody>
            <div className="text-sm text-muted">{O.balanceLabel}</div>
            <div className="mt-1 text-4xl font-semibold tracking-tight tabular-nums">
              {formatMicrosVnd(summary.balanceMicros, rate, locale)}
            </div>
            <p
              className={`mt-2 text-sm ${summary.forecastDaysLeft !== null && summary.forecastDaysLeft <= 3 ? 'text-warn' : 'text-muted'}`}
            >
              {forecast}
            </p>
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              <span>{O.neverExpire}</span>
              {summary.avgDailySpendMicros > 0 && (
                <span>
                  {fmt(O.avgDaily, { amount: formatMicrosVnd(summary.avgDailySpendMicros, rate, locale) })}
                </span>
              )}
              <span>{fmt(O.rate, { rate: formatNumber(rate, locale) })}</span>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <ButtonLink href="/console/billing#topup">
                <QrCode className="size-4" aria-hidden />
                {t.console.topUp}
              </ButtonLink>
              <ButtonLink href="/console/billing" variant="secondary">
                {t.billing.ledgerTitle}
              </ButtonLink>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title={O.spendTitle}
            action={
              <span className="text-sm text-muted">
                {O.totalSpend}:{' '}
                <Money micros={totalSpend} rate={rate} locale={locale} className="font-medium text-fg" />
              </span>
            }
          />
          <CardBody>
            {totalSpend === 0 ? (
              <p className="py-6 text-center text-sm text-muted">{O.spendEmpty}</p>
            ) : (
              <ShareBars
                rows={byProduct.map((p) => ({
                  key: p.product,
                  label: productName(p.product, t),
                  value: p.micros,
                  display: <Money micros={p.micros} rate={rate} locale={locale} precise />,
                  sub: p.count
                    ? plural(
                        p.count,
                        { one: O.entriesOne, other: O.entries },
                        { n: formatNumber(p.count, locale) },
                      )
                    : undefined,
                }))}
              />
            )}
          </CardBody>
        </Card>
      </div>

      {totalSpend > 0 && (
        <Card className="mt-4">
          <CardHeader title={O.spendByDay} />
          <CardBody>
            <BarChart
              data={byDay.map((d) => ({ key: d.day, value: d.micros }))}
              label={O.spendTitle}
              formatValue={(v) => formatMicrosVnd(v, rate, locale, { precise: true })}
              formatLabel={(k) => formatDayKey(k, locale)}
            />
          </CardBody>
        </Card>
      )}

      <section className="mt-8" aria-labelledby="quick">
        <h2 id="quick" className="mb-3 text-base font-semibold">
          {O.quickTitle}
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {quick.map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <Link
                href={href}
                className="group flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3.5 text-sm shadow-card hover:border-line-strong"
              >
                <Icon className="size-4 text-accent" aria-hidden />
                <span className="flex-1">{label}</span>
                <ArrowRight
                  className="size-4 text-faint transition-transform group-hover:translate-x-0.5"
                  aria-hidden
                />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {keys.filter((k) => !k.revokedAt).length === 0 && (
        <Card className="mt-8">
          <CardHeader title={O.curlTitle} description={O.curlBody} />
          <CardBody>
            <CodeBlock code={gatewayCurl(cfg.publicApiUrl)} />
          </CardBody>
        </Card>
      )}

      <Card className="mt-8">
        <CardHeader
          title={O.activityTitle}
          action={
            recent.length > 0 && (
              <Link href="/console/billing#ledger" className="text-sm text-accent hover:underline">
                {t.common.viewAll}
              </Link>
            )
          }
        />
        {recent.length === 0 ? (
          <EmptyState title={O.activityEmpty} />
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {recent.map((raw) => {
              const e = toLedgerEntry(raw);
              const href = entrySourceHref(e);
              const body = (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{describeEntry(e, t)}</div>
                    <div className="mt-0.5 text-xs text-muted">
                      {productName(e.product, t) !== '—' ? `${productName(e.product, t)} · ` : ''}
                      <RelativeTime date={e.createdAt} />
                    </div>
                  </div>
                  <Money
                    micros={e.amountMicros}
                    rate={rate}
                    locale={locale}
                    precise
                    signed
                    className={`text-sm font-medium ${e.amountMicros > 0 ? 'text-ok' : ''}`}
                  />
                </>
              );
              return (
                <li key={e.id}>
                  {href ? (
                    <Link href={href} className="flex items-center gap-4 px-5 py-3 hover:bg-surface-2">
                      {body}
                    </Link>
                  ) : (
                    <div className="flex items-center gap-4 px-5 py-3">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
