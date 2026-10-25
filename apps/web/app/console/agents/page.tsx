import { Bot, Plus } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Money, ServiceProblem } from '@/components/console';
import { Badge, ButtonLink, Card, CardBody, CardHeader, EmptyState, PageHeader } from '@/components/ui';
import { formatMicrosVnd, formatTokens } from '@/lib/format';
import { fmt, getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { agentsApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import { agentStatusTone } from '@/lib/status';
import { getWallet } from '@/lib/wallet';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).agents.title };
}

export default async function AgentsPage() {
  const session = await requireSession();
  const { t, locale } = await getI18n();
  const A = t.agents;
  const orgId = session.org.id;
  const [agents, usage, plans, wallet] = await Promise.all([
    agentsApi.list(orgId),
    agentsApi.usage(orgId),
    agentsApi.plans(orgId),
    getWallet(orgId),
  ]);
  const rate = wallet.summary.vndPerUsd;

  const header = (
    <PageHeader
      title={A.title}
      description={A.subtitle}
      action={
        agents.ok && (
          <ButtonLink href="/console/agents/new">
            <Plus className="size-4" aria-hidden />
            {A.newAgent}
          </ButtonLink>
        )
      }
    />
  );

  if (!agents.ok) {
    return (
      <>
        {header}
        <ServiceProblem error={agents.error} t={t} />
      </>
    );
  }
  const usageBy = new Map((usage.ok ? usage.data.data : []).map((u) => [u.agentId, u]));

  return (
    <>
      {header}
      {agents.data.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Bot className="size-5" />}
            title={A.listEmpty}
            action={
              <ButtonLink href="/console/agents/new">
                <Plus className="size-4" aria-hidden />
                {A.newAgent}
              </ButtonLink>
            }
          >
            {A.listEmptyBody}
          </EmptyState>
        </Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {agents.data.data.map((a) => {
            const u = usageBy.get(a.id);
            return (
              <li key={a.id}>
                <Link
                  href={`/console/agents/${encodeURIComponent(a.id)}`}
                  className="flex h-full flex-col rounded-xl border border-line bg-surface p-5 shadow-card transition-colors hover:border-line-strong"
                >
                  <div className="flex items-start gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft font-semibold text-accent-ink">
                      {a.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{a.name}</span>
                        <Badge tone={agentStatusTone(a.status)} dot>
                          {A.status[a.status] ?? a.status}
                        </Badge>
                      </div>
                      <div className="mt-0.5 truncate text-sm text-muted">{a.role || '—'}</div>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                    <span className="capitalize">{a.plan}</span>
                    {u && (
                      <span>
                        {fmt(A.usageTokens, {
                          used: formatTokens(u.platformTokens, locale),
                          included: formatTokens(u.includedTokens, locale),
                        })}
                      </span>
                    )}
                    {u && u.customerCostMicros > 0 && (
                      <span>
                        <Money micros={u.customerCostMicros} rate={rate} locale={locale} precise />
                      </span>
                    )}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {plans.ok && plans.data.data.length > 0 && (
        <Card className="mt-6">
          <CardHeader title={A.plansTitle} description={A.serviceNote} />
          <CardBody className="grid gap-3 sm:grid-cols-2">
            {plans.data.data.map((p) => (
              <div key={p.id} className="rounded-xl border border-line p-4">
                <div className="font-medium">{p.name}</div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {formatMicrosVnd(p.monthlyPriceMicros, rate, locale)}
                  <span className="text-sm font-normal text-muted">
                    /{locale === 'vi' ? 'tháng' : 'month'}
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted">
                  {formatTokens(p.includedTokensPerMonth, locale)} token · {p.limits.cpus} CPU ·{' '}
                  {p.limits.memoryMb} MB
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      )}
    </>
  );
}
