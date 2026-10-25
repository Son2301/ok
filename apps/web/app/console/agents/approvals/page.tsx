import { Inbox } from 'lucide-react';
import type { Metadata } from 'next';
import { ServiceProblem } from '@/components/console';
import { Badge, Card, CardHeader, EmptyState, PageHeader } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { agentsApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import { ApprovalCard } from './approval-card';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).agents.approvalsTitle };
}

export default async function ApprovalsPage() {
  const session = await requireSession();
  const { t, locale } = await getI18n();
  const A = t.agents;
  const orgId = session.org.id;
  const [open, all, agents] = await Promise.all([
    agentsApi.approvals(orgId, { status: 'open', limit: 50 }),
    agentsApi.approvals(orgId, { limit: 30 }),
    agentsApi.list(orgId),
  ]);
  const names = new Map((agents.ok ? agents.data.data : []).map((a) => [a.id, a.name]));

  if (!open.ok) {
    return (
      <>
        <PageHeader title={A.approvalsTitle} description={A.approvalsBody} />
        <ServiceProblem error={open.error} t={t} />
      </>
    );
  }
  const history = all.ok
    ? all.data.data.filter((a) => a.status !== 'pending' && a.status !== 'drafted').slice(0, 15)
    : [];

  return (
    <>
      <PageHeader title={A.approvalsTitle} description={A.approvalsBody} />
      {open.data.data.length === 0 ? (
        <Card>
          <EmptyState icon={<Inbox className="size-5" />} title={A.approvalsEmpty} />
        </Card>
      ) : (
        <div className="space-y-3">
          {open.data.data.map((a) => (
            <ApprovalCard key={a.id} approval={a} agentName={names.get(a.agentId) ?? a.agentId} />
          ))}
        </div>
      )}

      {history.length > 0 && (
        <Card className="mt-8">
          <CardHeader title={A.approvalHistory} />
          <ul className="mt-3 divide-y divide-line border-t border-line">
            {history.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm">
                <div className="min-w-0">
                  <span className="font-mono text-xs">{a.tool}</span>
                  <span className="ml-2 text-xs text-muted">
                    {names.get(a.agentId) ?? a.agentId} · {formatDateTime(a.decidedAt ?? a.createdAt, locale)}
                  </span>
                  {a.decisionNote && <div className="mt-0.5 text-xs text-muted">“{a.decisionNote}”</div>}
                  {a.error && <div className="mt-0.5 text-xs text-danger">{a.error}</div>}
                </div>
                <Badge tone={a.status === 'executed' ? 'ok' : a.status === 'failed' ? 'danger' : 'neutral'}>
                  {A.approvalStatus[a.status] ?? a.status}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
