import { ChartColumn } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { BarChart, CodeBlock, Money, ServiceProblem } from '@/components/console';
import {
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  PageHeader,
  Stat,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { env } from '@/lib/env';
import { formatDayKey, formatDuration, formatMicrosVnd, formatNumber, formatTokens } from '@/lib/format';
import { getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { productName } from '@/lib/ledger';
import { platform } from '@/lib/platform';
import { gatewayApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import { gatewayCurl } from '@/lib/snippets';
import { getWallet } from '@/lib/wallet';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).gateway.usageTitle };
}

const GROUPS = ['model', 'provider', 'product', 'key'] as const;
type Group = (typeof GROUPS)[number];

export default async function GatewayUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string }>;
}) {
  const session = await requireSession();
  const { t, locale } = await getI18n();
  const sp = await searchParams;
  const group: Group = (GROUPS as readonly string[]).includes(sp.group ?? '') ? (sp.group as Group) : 'model';
  const orgId = session.org.id;
  const G = t.gateway;

  const [daily, grouped, wallet, keys] = await Promise.all([
    gatewayApi.usage(orgId, { group_by: 'day' }),
    gatewayApi.usage(orgId, { group_by: group }),
    getWallet(orgId),
    platform().then(({ core }) => core.listApiKeys(orgId)),
  ]);
  const rate = wallet.summary.vndPerUsd;
  const keyNames = new Map(keys.map((k) => [k.id, k.name]));

  if (!daily.ok) {
    return (
      <>
        <PageHeader title={G.usageTitle} description={G.usageSubtitle} />
        <ServiceProblem error={daily.error} t={t} />
      </>
    );
  }

  const totals = daily.data.totals;
  const labelFor = (key: string) => {
    if (group === 'product') return productName(key, t);
    if (group === 'key') return key === 'internal' ? t.receipt.internal : (keyNames.get(key) ?? key);
    return key;
  };

  return (
    <>
      <PageHeader title={G.usageTitle} description={G.usageSubtitle} />

      {totals.requests === 0 ? (
        <Card>
          <EmptyState
            icon={<ChartColumn className="size-5" />}
            title={G.usageEmpty}
            action={<ButtonLink href="/console/gateway/playground">{t.overview.quick.playground}</ButtonLink>}
          >
            {t.overview.curlBody}
          </EmptyState>
          <CardBody className="pt-0">
            <CodeBlock code={gatewayCurl(env().publicApiUrl)} />
          </CardBody>
        </Card>
      ) : (
        <>
          <Card>
            <CardBody className="grid grid-cols-2 gap-6 sm:grid-cols-4">
              <Stat label={G.totals.requests} value={formatNumber(totals.requests, locale)} />
              <Stat label={G.totals.errors} value={formatNumber(totals.errors, locale)} />
              <Stat
                label={G.totals.tokens}
                value={formatTokens(totals.prompt_tokens + totals.completion_tokens, locale)}
                hint={`${formatTokens(totals.prompt_tokens, locale)} / ${formatTokens(totals.completion_tokens, locale)}`}
              />
              <Stat
                label={G.totals.cost}
                value={formatMicrosVnd(totals.cost_micros, rate, locale, { precise: true })}
                hint={`$${totals.cost_usd.toFixed(totals.cost_usd < 1 ? 4 : 2)}`}
              />
            </CardBody>
          </Card>

          <Card className="mt-4">
            <CardHeader title={G.chartTitle} />
            <CardBody>
              <BarChart
                data={daily.data.data.map((d) => ({ key: d.key, value: d.cost_micros }))}
                label={G.chartDesc}
                formatValue={(v) => formatMicrosVnd(v, rate, locale, { precise: true })}
                formatLabel={(k) => formatDayKey(k, locale)}
              />
            </CardBody>
          </Card>

          <Card className="mt-4">
            <CardHeader
              title={G.groupBy}
              action={
                <nav className="flex flex-wrap gap-1.5" aria-label={G.groupBy}>
                  {GROUPS.map((g) => (
                    <Link
                      key={g}
                      href={`/console/gateway?group=${g}`}
                      aria-current={g === group ? 'page' : undefined}
                      className={`rounded-full border px-3 py-1 text-sm ${
                        g === group
                          ? 'border-accent bg-accent-soft text-accent-ink'
                          : 'border-line text-muted hover:text-fg'
                      }`}
                    >
                      {G.group[g]}
                    </Link>
                  ))}
                </nav>
              }
            />
            <div className="mt-4">
              {!grouped.ok ? (
                <div className="px-5 pb-5">
                  <ServiceProblem error={grouped.error} t={t} />
                </div>
              ) : (
                <Table label={G.groupBy}>
                  <thead>
                    <tr>
                      <Th>{G.group[group]}</Th>
                      <Th align="right">{G.colRequests}</Th>
                      <Th align="right">{G.colErrors}</Th>
                      <Th align="right">{G.colTokens}</Th>
                      <Th align="right">{G.colLatency}</Th>
                      <Th align="right">{G.colCost}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {grouped.data.data.map((b) => (
                      <tr key={b.key}>
                        <Td className="max-w-64 truncate font-mono text-xs">{labelFor(b.key)}</Td>
                        <Td align="right">{formatNumber(b.requests, locale)}</Td>
                        <Td align="right" className={b.errors ? 'text-danger' : 'text-muted'}>
                          {formatNumber(b.errors, locale)}
                        </Td>
                        <Td align="right" className="whitespace-nowrap">
                          {formatTokens(b.prompt_tokens, locale)} /{' '}
                          {formatTokens(b.completion_tokens, locale)}
                        </Td>
                        <Td align="right">{formatDuration(b.avg_latency_ms, locale)}</Td>
                        <Td align="right" className="font-medium">
                          <Money micros={b.cost_micros} rate={rate} locale={locale} precise />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          </Card>
        </>
      )}
    </>
  );
}
