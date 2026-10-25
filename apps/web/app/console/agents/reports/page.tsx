import { FileText } from 'lucide-react';
import type { Metadata } from 'next';
import { ServiceProblem } from '@/components/console';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { agentsApi } from '@/lib/services';
import { requireSession } from '@/lib/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).agents.reportsTitle };
}

export default async function ReportsPage() {
  const session = await requireSession();
  const { t, locale } = await getI18n();
  const A = t.agents;
  const [reports, agents] = await Promise.all([
    agentsApi.reports(session.org.id, { limit: 50 }),
    agentsApi.list(session.org.id),
  ]);
  const names = new Map((agents.ok ? agents.data.data : []).map((a) => [a.id, a.name]));

  return (
    <>
      <PageHeader title={A.reportsTitle} />
      {!reports.ok ? (
        <ServiceProblem error={reports.error} t={t} />
      ) : reports.data.data.length === 0 ? (
        <Card>
          <EmptyState icon={<FileText className="size-5" />} title={A.reportsEmpty} />
        </Card>
      ) : (
        <ul className="space-y-3">
          {reports.data.data.map((r) => (
            <li key={r.id}>
              <article className="rounded-xl border border-line bg-surface p-5 shadow-card">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={r.kind === 'daily_summary' ? 'accent' : 'neutral'}>
                    {A.reportKind[r.kind]}
                  </Badge>
                  <span className="text-sm font-medium">{names.get(r.agentId) ?? r.agentId}</span>
                  <span className="text-xs text-muted">{formatDateTime(r.createdAt, locale)}</span>
                </div>
                <h2 className="mt-2 font-semibold">{r.title}</h2>
                <p className="mt-1.5 text-sm whitespace-pre-wrap text-muted">{r.body}</p>
              </article>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
