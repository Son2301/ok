import type { Metadata } from 'next';
import Link from 'next/link';
import { Money, ServiceProblem } from '@/components/console';
import { Card, EmptyState, Meter, PageHeader, Table, Td, Th } from '@/components/ui';
import { formatMicrosVnd, formatNumber, formatTokens } from '@/lib/format';
import { fmt, getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { agentsApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import { getWallet, spendByProduct } from '@/lib/wallet';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).agents.tabs.usage };
}

export default async function AgentsUsagePage() {
  const session = await requireSession();
  const { t, locale } = await getI18n();
  const A = t.agents;
  const [usage, wallet, spend] = await Promise.all([
    agentsApi.usage(session.org.id),
    getWallet(session.org.id),
    spendByProduct(session.org.id, 30),
  ]);
  const rate = wallet.summary.vndPerUsd;
  const agentsSpend = spend.find((s) => s.product === 'agents');

  return (
    <>
      <PageHeader
        title={usage.ok ? fmt(A.usageTitle, { month: usage.data.month }) : A.tabs.usage}
        description={`${A.serviceNote} ${t.overview.spendTitle}: ${formatMicrosVnd(agentsSpend?.micros ?? 0, rate, locale, { precise: true })}.`}
      />
      {!usage.ok ? (
        <ServiceProblem error={usage.error} t={t} />
      ) : usage.data.data.length === 0 ? (
        <Card>
          <EmptyState title={A.listEmpty} />
        </Card>
      ) : (
        <Card>
          <Table label={A.tabs.usage}>
            <thead>
              <tr>
                <Th>{A.colName}</Th>
                <Th>{A.includedTokens}</Th>
                <Th align="right">{A.usageBeyond}</Th>
                <Th align="right">{A.fieldBudget}</Th>
              </tr>
            </thead>
            <tbody>
              {usage.data.data.map((u) => (
                <tr key={u.agentId}>
                  <Td>
                    <Link
                      href={`/console/agents/${encodeURIComponent(u.agentId)}`}
                      className="font-medium text-accent hover:underline"
                    >
                      {u.name}
                    </Link>
                    <div className="text-xs text-muted capitalize">
                      {u.plan} · {formatNumber(u.requests, locale)} req
                    </div>
                  </Td>
                  <Td className="min-w-48">
                    <Meter value={u.platformTokens} max={u.includedTokens} label={u.name} />
                    <div className="mt-1 text-xs text-muted">
                      {formatTokens(u.platformTokens, locale)} / {formatTokens(u.includedTokens, locale)}
                    </div>
                  </Td>
                  <Td align="right">
                    <Money micros={u.customerCostMicros} rate={rate} locale={locale} precise />
                    <div className="text-xs text-muted">{formatTokens(u.customerTokens, locale)} token</div>
                  </Td>
                  <Td align="right">
                    {u.budgetMonthlyMicros == null ? (
                      <span className="text-warn">{A.usageNoBudget}</span>
                    ) : (
                      <Money micros={u.budgetMonthlyMicros} rate={rate} locale={locale} />
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
