import { ExternalLink } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Money, Receipt, ServiceProblem } from '@/components/console';
import {
  Badge,
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
import { env } from '@/lib/env';
import { formatDateTime, formatNumber, formatTokens, formatUsd, formatVnd } from '@/lib/format';
import { fmt, getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { describeEntry, entrySourceHref, kindLabel, productName, toLedgerEntry } from '@/lib/ledger';
import { platform } from '@/lib/platform';
import { gatewayApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import type { Topup } from '@/lib/types/gateway';
import { getWallet, isProduct, listLedger } from '@/lib/wallet';
import { ProfileForm } from './profile-form';
import { TopupPanel } from './topup-panel';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).billing.title };
}

const LEDGER_PAGE = 25;

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string; before?: string }>;
}) {
  const session = await requireSession();
  const { t, locale } = await getI18n();
  const sp = await searchParams;
  const orgId = session.org.id;
  const cfg = env();
  const B = t.billing;

  const product = isProduct(sp.product) ? sp.product : undefined;
  const before = sp.before && !Number.isNaN(Date.parse(sp.before)) ? new Date(sp.before) : undefined;

  const [wallet, topups, ledger, profile, keys] = await Promise.all([
    getWallet(orgId),
    gatewayApi.topups(orgId),
    listLedger(orgId, { product, before, limit: LEDGER_PAGE + 1 }),
    platform()
      .then(({ billing }) => billing.getProfile(orgId))
      .catch(() => 'error' as const),
    platform().then(({ core }) => core.listApiKeys(orgId)),
  ]);
  const rate = wallet.summary.vndPerUsd;
  const keyName = new Map(keys.map((k) => [k.id, `${k.name} (${k.prefix})`]));
  const hasMore = ledger.length > LEDGER_PAGE;
  const rows = ledger.slice(0, LEDGER_PAGE).map(toLedgerEntry);
  const nextBefore = hasMore ? rows[rows.length - 1]?.createdAt : undefined;

  const resumable = topups.ok
    ? topups.data.data.find(
        (tp) =>
          tp.status === 'pending' &&
          new Date(tp.expiresAt).getTime() > Date.now() &&
          Date.now() - new Date(tp.createdAt).getTime() < 30 * 60_000,
      )
    : undefined;

  const filterHref = (p?: string) => (p ? `/console/billing?product=${p}#ledger` : '/console/billing#ledger');

  return (
    <>
      <PageHeader title={B.title} description={B.subtitle} />

      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <Card id="topup" className="scroll-mt-20">
          <CardHeader title={B.topupTitle} description={B.topupBody} />
          <CardBody>
            {topups.ok || topups.error.kind === 'http' ? (
              <TopupPanel
                rate={rate}
                initialTopup={resumable ?? null}
                contactEmail={cfg.contactEmail}
                contactZalo={cfg.contactZalo}
              />
            ) : (
              <ServiceProblem error={topups.error} t={t} />
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={B.policiesTitle} />
          <CardBody className="pt-3">
            <ul className="space-y-2.5 text-sm text-muted">
              {B.policies.map((p) => (
                <li key={p} className="flex gap-2">
                  <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </div>

      {/* Top-up history */}
      <Card className="mt-6">
        <CardHeader title={B.historyTitle} />
        <div className="mt-3">
          {!topups.ok ? (
            <div className="px-5 pb-5">
              <ServiceProblem error={topups.error} t={t} />
            </div>
          ) : topups.data.data.length === 0 ? (
            <EmptyState title={B.historyEmpty} />
          ) : (
            <Table label={B.historyTitle}>
              <thead>
                <tr>
                  <Th>{B.colDate}</Th>
                  <Th>{B.colCode}</Th>
                  <Th align="right">{B.colAmount}</Th>
                  <Th align="right">{B.colCredit}</Th>
                  <Th>{B.colStatus}</Th>
                </tr>
              </thead>
              <tbody>
                {topups.data.data.map((tp) => (
                  <tr key={tp.id}>
                    <Td className="whitespace-nowrap text-muted">{formatDateTime(tp.createdAt, locale)}</Td>
                    <Td className="font-mono text-xs">{tp.code}</Td>
                    <Td align="right">{formatVnd(tp.receivedVnd ?? tp.amountVnd, locale)}</Td>
                    <Td align="right">
                      {tp.creditedMicros != null ? (
                        <Money micros={tp.creditedMicros} rate={tp.vndPerUsd} locale={locale} />
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td>
                      <TopupStatus tp={tp} t={t} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </div>
      </Card>

      {/* Ledger */}
      <Card id="ledger" className="mt-6 scroll-mt-20">
        <CardHeader title={B.ledgerTitle} description={B.ledgerBody} />
        <nav aria-label={B.ledgerFilter} className="flex flex-wrap gap-1.5 px-5 pt-4">
          {[undefined, 'gateway', 'agents', 'safe', 'review'].map((p) => (
            <Link
              key={p ?? 'all'}
              href={filterHref(p)}
              aria-current={product === p ? 'page' : undefined}
              className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                product === p
                  ? 'border-accent bg-accent-soft text-accent-ink'
                  : 'border-line text-muted hover:text-fg'
              }`}
            >
              {p ? productName(p, t) : t.common.all}
            </Link>
          ))}
        </nav>
        <div className="mt-3">
          {rows.length === 0 ? (
            <EmptyState title={B.ledgerEmpty} />
          ) : (
            <ul className="divide-y divide-line border-t border-line">
              {rows.map((e) => {
                const src = entrySourceHref(e);
                const meta = e.meta ?? {};
                const tokens =
                  typeof meta.prompt_tokens === 'number' && typeof meta.completion_tokens === 'number'
                    ? `${fmt(t.receipt.tokensDetail, {
                        prompt: formatTokens(meta.prompt_tokens, locale),
                        completion: formatTokens(meta.completion_tokens, locale),
                      })}${meta.estimated ? ` (${t.receipt.estimated})` : ''}`
                    : null;
                return (
                  <li key={e.id}>
                    <details className="group">
                      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3 hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm">{describeEntry(e, t)}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                            <span>{formatDateTime(e.createdAt, locale)}</span>
                            <span aria-hidden>·</span>
                            <span>{e.product ? productName(e.product, t) : kindLabel(e.kind, t)}</span>
                          </div>
                        </div>
                        <div className="text-right">
                          <Money
                            micros={e.amountMicros}
                            rate={rate}
                            locale={locale}
                            precise
                            signed
                            className={`text-sm font-medium ${e.amountMicros > 0 ? 'text-ok' : ''}`}
                          />
                          <div className="text-xs text-muted tabular-nums">
                            <Money micros={e.balanceAfterMicros} rate={rate} locale={locale} />
                          </div>
                        </div>
                      </summary>
                      <div className="px-5 pb-4">
                        <Receipt
                          title={t.receipt.title}
                          rows={[
                            { label: t.receipt.what, value: describeEntry(e, t) },
                            {
                              label: t.receipt.product,
                              value: e.product ? productName(e.product, t) : kindLabel(e.kind, t),
                            },
                            ...(typeof meta.model === 'string'
                              ? [
                                  {
                                    label: t.receipt.model,
                                    value: <span className="font-mono text-xs">{meta.model}</span>,
                                  },
                                ]
                              : []),
                            ...(typeof meta.provider === 'string'
                              ? [{ label: t.receipt.provider, value: meta.provider }]
                              : []),
                            ...(tokens ? [{ label: t.receipt.tokens, value: tokens }] : []),
                            ...(typeof meta.amount_vnd === 'number'
                              ? [{ label: B.amount, value: formatVnd(meta.amount_vnd, locale) }]
                              : []),
                            ...(typeof meta.vnd_per_usd === 'number'
                              ? [
                                  {
                                    label: t.receipt.rateUsed,
                                    value: `${formatNumber(meta.vnd_per_usd, locale)}đ/USD`,
                                  },
                                ]
                              : []),
                            {
                              label: t.receipt.amount,
                              value: (
                                <>
                                  <Money micros={e.amountMicros} rate={rate} locale={locale} precise signed />
                                  <span className="ml-1.5 text-xs text-muted">
                                    {formatUsd(e.amountMicros)}
                                  </span>
                                </>
                              ),
                              strong: true,
                            },
                            { label: t.receipt.when, value: formatDateTime(e.createdAt, locale) },
                            {
                              label: t.receipt.balanceAfter,
                              value: <Money micros={e.balanceAfterMicros} rate={rate} locale={locale} />,
                            },
                            ...(e.apiKeyId
                              ? [{ label: t.receipt.apiKey, value: keyName.get(e.apiKeyId) ?? e.apiKeyId }]
                              : []),
                            ...(e.ref
                              ? [
                                  {
                                    label: t.receipt.ref,
                                    value: <span className="font-mono text-xs">{e.ref}</span>,
                                  },
                                ]
                              : []),
                          ]}
                          footer={
                            src ? (
                              <Link
                                href={src}
                                className="inline-flex items-center gap-1 text-accent hover:underline"
                              >
                                {t.common.details}
                                <ExternalLink className="size-3" aria-hidden />
                              </Link>
                            ) : undefined
                          }
                        />
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
          {(before || nextBefore) && (
            <div className="flex justify-between border-t border-line px-5 py-3 text-sm">
              {before ? (
                <Link href={filterHref(product)} className="text-accent hover:underline">
                  ← {t.common.newer}
                </Link>
              ) : (
                <span />
              )}
              {nextBefore && (
                <Link
                  href={`/console/billing?${new URLSearchParams({ ...(product ? { product } : {}), before: String(nextBefore) })}#ledger`}
                  className="text-accent hover:underline"
                >
                  {t.common.older} →
                </Link>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* E-invoice profile */}
      <Card className="mt-6">
        <CardHeader title={B.profileTitle} description={B.profileBody} />
        <CardBody>
          {profile === 'error' && (
            <Notice tone="neutral" className="mb-4">
              {t.auth.unavailable}
            </Notice>
          )}
          <ProfileForm
            profile={
              profile && profile !== 'error'
                ? {
                    taxCode: profile.taxCode,
                    companyName: profile.companyName,
                    address: profile.address,
                    invoiceEmail: profile.invoiceEmail,
                  }
                : null
            }
          />
        </CardBody>
      </Card>
    </>
  );
}

function TopupStatus({ tp, t }: { tp: Topup; t: ReturnType<typeof getDictionary> }) {
  if (tp.status === 'paid')
    return (
      <Badge tone="ok" dot>
        {t.billing.status.paid}
      </Badge>
    );
  if (new Date(tp.expiresAt).getTime() < Date.now()) return <Badge>{t.billing.status.expired}</Badge>;
  return (
    <Badge tone="warn" dot>
      {t.billing.status.pending}
    </Badge>
  );
}
