import { ArrowLeft, ShieldCheck } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Money, ServiceProblem } from '@/components/console';
import { Badge, Card, CardBody, CardHeader, Meter, Notice, PageHeader } from '@/components/ui';
import { cx } from '@/lib/cx';
import { formatDateTime, formatMicrosVnd, formatTokens } from '@/lib/format';
import { fmt, getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { agentsApi, gatewayApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import { agentStatusTone } from '@/lib/status';
import { getWallet } from '@/lib/wallet';
import {
  AgentChat,
  AgentSettingsForm,
  EnableIntegrationButton,
  IntegrationCredentials,
  KnowledgePanel,
  LifecycleBar,
  TrustControl,
} from './agent-client';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).agents.title };
}

const TABS = ['chat', 'integrations', 'knowledge', 'settings', 'activity'] as const;
type Tab = (typeof TABS)[number];

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await requireSession();
  const { t, locale } = await getI18n();
  const { id } = await params;
  const sp = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(sp.tab ?? '') ? (sp.tab as Tab) : 'chat';
  const A = t.agents;
  const orgId = session.org.id;

  const [detail, status, wallet, plans] = await Promise.all([
    agentsApi.get(orgId, id),
    agentsApi.status(orgId, id),
    getWallet(orgId),
    agentsApi.plans(orgId),
  ]);
  const rate = wallet.summary.vndPerUsd;
  const back = (
    <Link
      href="/console/agents"
      className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {A.title}
    </Link>
  );
  if (!detail.ok) {
    return (
      <>
        {back}
        <ServiceProblem error={detail.error} t={t} />
      </>
    );
  }
  const agent = detail.data;
  const plan = plans.ok ? plans.data.data.find((p) => p.id === agent.plan) : undefined;
  const usage = status.ok ? status.data.usage : null;

  // Tab-specific data, fetched only when shown.
  const [catalog, knowledge, agentList, models] = await Promise.all([
    tab === 'integrations' ? agentsApi.catalog(orgId) : null,
    tab === 'knowledge' ? agentsApi.knowledge(orgId, id) : null,
    tab === 'settings' ? agentsApi.list(orgId) : null,
    tab === 'settings' ? gatewayApi.models({ type: 'chat' }) : null,
  ]);

  const statusLabel = A.status[agent.status] ?? agent.status;

  return (
    <>
      {back}
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {agent.name}
            <Badge tone={agentStatusTone(agent.status)} dot>
              {statusLabel}
            </Badge>
          </span>
        }
        description={agent.role || undefined}
        action={
          <LifecycleBar
            agent={agent}
            dailyFee={plan ? formatMicrosVnd(plan.dailyPriceMicros, rate, locale) : null}
          />
        }
      />
      {agent.statusReason && agent.status !== 'running' && (
        <Notice tone={agent.status === 'error' ? 'danger' : 'warn'} className="mb-4">
          {agent.statusReason}
        </Notice>
      )}

      {usage && (
        <Card className="mb-6">
          <CardBody className="grid gap-5 sm:grid-cols-3">
            <div>
              <div className="text-sm text-muted">{fmt(A.usageTitle, { month: usage.month })}</div>
              <div className="mt-2">
                <Meter value={usage.platformTokens} max={usage.includedTokens} label={A.usageTokens} />
              </div>
              <div className="mt-1.5 text-xs text-muted">
                {fmt(A.usageTokens, {
                  used: formatTokens(usage.platformTokens, locale),
                  included: formatTokens(usage.includedTokens, locale),
                })}
              </div>
            </div>
            <div>
              <div className="text-sm text-muted">{A.usageBeyond}</div>
              <div className="mt-1 text-lg font-semibold">
                <Money micros={usage.customerCostMicros} rate={rate} locale={locale} precise />
              </div>
              <div className="text-xs text-muted">{formatTokens(usage.customerTokens, locale)} token</div>
            </div>
            <div>
              <div className="text-sm text-muted">{A.fieldBudget}</div>
              {usage.budgetMonthlyMicros == null ? (
                <div className="mt-1 text-sm text-warn">{A.usageNoBudget}</div>
              ) : (
                <>
                  <div className="mt-2">
                    <Meter
                      value={usage.customerCostMicros}
                      max={usage.budgetMonthlyMicros}
                      tone={usage.customerCostMicros >= usage.budgetMonthlyMicros * 0.8 ? 'warn' : 'accent'}
                      label={A.fieldBudget}
                    />
                  </div>
                  <div className="mt-1.5 text-xs text-muted">
                    {fmt(A.usageBudget, {
                      spent: formatMicrosVnd(usage.customerCostMicros, rate, locale, { precise: true }),
                      budget: formatMicrosVnd(usage.budgetMonthlyMicros, rate, locale),
                    })}
                  </div>
                </>
              )}
            </div>
          </CardBody>
        </Card>
      )}

      <nav className="-mx-4 mb-5 overflow-x-auto px-4 sm:mx-0 sm:px-0" aria-label={A.title}>
        <ul className="flex min-w-max gap-1 rounded-xl bg-surface-2 p-1">
          {TABS.map((tb) => (
            <li key={tb}>
              <Link
                href={`/console/agents/${encodeURIComponent(id)}?tab=${tb}`}
                aria-current={tab === tb ? 'page' : undefined}
                className={cx(
                  'block rounded-lg px-3 py-1.5 text-sm transition-colors',
                  tab === tb ? 'bg-surface font-medium text-fg shadow-card' : 'text-muted hover:text-fg',
                )}
              >
                {A.detailTabs[tb]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {tab === 'chat' && (
        <section>
          <p className="mb-3 text-sm text-muted">{A.chatBody}</p>
          <AgentChat
            agentId={agent.id}
            running={agent.status === 'running'}
            statusLabel={statusLabel}
            rate={rate}
          />
        </section>
      )}

      {tab === 'integrations' && (
        <section className="space-y-4">
          <Notice
            tone="info"
            icon={<ShieldCheck className="size-4" aria-hidden />}
            title={A.integrationsTitle}
          >
            {A.integrationsBody}
          </Notice>
          {agent.integrationStatus.map((ig) => {
            const cat = catalog?.ok ? catalog.data.data.find((c) => c.id === ig.integrationId) : undefined;
            return (
              <Card key={ig.integrationId}>
                <CardHeader
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      {ig.name}
                      <span className="text-xs font-normal text-muted">
                        {(A.category as Record<string, string>)[ig.category] ?? ig.category}
                      </span>
                      {ig.status !== 'available' ? (
                        <Badge>{A.comingSoon}</Badge>
                      ) : ig.ready ? (
                        <Badge tone="ok" dot>
                          {cat?.alwaysEnabled ? A.alwaysOn : A.connected}
                        </Badge>
                      ) : (
                        <Badge tone="warn" dot>
                          {A.needsCredentials}
                        </Badge>
                      )}
                      {!ig.verified && (
                        <Badge tone="neutral" title={A.unverified}>
                          {t.models.unverified}
                        </Badge>
                      )}
                    </span>
                  }
                  description={cat?.description}
                  action={
                    !cat?.alwaysEnabled && (
                      <EnableIntegrationButton
                        agentId={agent.id}
                        integrationId={ig.integrationId}
                        enabled={ig.enabled}
                      />
                    )
                  }
                />
                <CardBody className="pt-2">
                  {ig.tools.length > 0 && (
                    <div className="divide-y divide-line">
                      {ig.tools.map((tool) => (
                        <TrustControl
                          key={tool.name}
                          agentId={agent.id}
                          integrationId={ig.integrationId}
                          tool={tool}
                        />
                      ))}
                    </div>
                  )}
                  {cat?.requiresCredentials && (
                    <IntegrationCredentials agentId={agent.id} integration={ig} catalog={cat} />
                  )}
                </CardBody>
              </Card>
            );
          })}
          {catalog?.ok && (
            <Card>
              <CardHeader title={A.addIntegration} />
              <ul className="mt-3 divide-y divide-line border-t border-line">
                {catalog.data.data
                  .filter((c) => !agent.integrationStatus.some((ig) => ig.integrationId === c.id))
                  .map((c) => (
                    <li
                      key={c.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 sm:flex-nowrap"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {c.name}
                          {c.status !== 'available' && <Badge>{A.comingSoon}</Badge>}
                          {!c.verified && <Badge tone="neutral">{t.models.unverified}</Badge>}
                        </div>
                        <div className="mt-0.5 text-xs text-muted">{c.description}</div>
                      </div>
                      {c.status === 'available' && (
                        <EnableIntegrationButton agentId={agent.id} integrationId={c.id} enabled={false} />
                      )}
                    </li>
                  ))}
              </ul>
            </Card>
          )}
          {catalog && !catalog.ok && <ServiceProblem error={catalog.error} t={t} />}
        </section>
      )}

      {tab === 'knowledge' && (
        <Card>
          <CardHeader title={A.knowledgeTitle} description={A.knowledgeBody} />
          <CardBody>
            {knowledge?.ok ? (
              <KnowledgePanel agentId={agent.id} docs={knowledge.data.data} />
            ) : (
              knowledge && <ServiceProblem error={knowledge.error} t={t} />
            )}
          </CardBody>
        </Card>
      )}

      {tab === 'settings' && (
        <Card>
          <CardHeader title={A.settingsTitle} />
          <CardBody>
            <AgentSettingsForm
              agent={agent}
              rate={rate}
              agents={agentList?.ok ? agentList.data.data.map((a) => ({ id: a.id, name: a.name })) : []}
              models={
                models?.ok
                  ? models.data.data.filter((m) => m.available).map((m) => m.id)
                  : ['auto', 'auto:cheap', 'auto:best']
              }
            />
          </CardBody>
        </Card>
      )}

      {tab === 'activity' && (
        <Card>
          <CardHeader
            title={A.activityTitle}
            description={
              status.ok
                ? fmt(A.runtime, { driver: status.data.driver, state: status.data.runtime.state })
                : undefined
            }
          />
          <CardBody>
            {!status.ok ? (
              <ServiceProblem error={status.error} t={t} />
            ) : status.data.events.length === 0 ? (
              <p className="text-sm text-muted">{A.activityEmpty}</p>
            ) : (
              <ol className="space-y-3">
                {status.data.events.map((e, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: event log is append-only
                  <li key={i} className="flex gap-3 text-sm">
                    <span
                      aria-hidden
                      className={cx(
                        'mt-1.5 size-2 shrink-0 rounded-full',
                        e.level === 'error' ? 'bg-danger' : e.level === 'warn' ? 'bg-warn' : 'bg-faint',
                      )}
                    />
                    <div className="min-w-0">
                      <div>{e.message}</div>
                      <div className="text-xs text-muted">
                        <span className="font-mono">{e.type}</span> · {formatDateTime(e.at, locale)}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardBody>
        </Card>
      )}
    </>
  );
}
