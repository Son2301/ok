import type { ReactNode } from 'react';
import { Tabs } from '@/components/console-nav';
import { getI18n } from '@/lib/i18n/server';
import { agentsApi } from '@/lib/services';
import { requireSession } from '@/lib/session';

export default async function AgentsLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const { t } = await getI18n();
  const A = t.agents.tabs;
  const pending = await agentsApi.approvals(session.org.id, { status: 'open', limit: 50 });
  return (
    <>
      <div className="mb-1 text-sm text-muted">{t.console.nav.agents}</div>
      <Tabs
        items={[
          {
            href: '/console/agents',
            label: A.agents,
            exact: true,
            activePrefixes: ['/console/agents/agt_', '/console/agents/new'],
          },
          {
            href: '/console/agents/approvals',
            label: A.approvals,
            badge: pending.ok ? pending.data.data.length : 0,
          },
          { href: '/console/agents/tasks', label: A.tasks },
          { href: '/console/agents/reports', label: A.reports },
          { href: '/console/agents/usage', label: A.usage },
        ]}
      />
      {children}
    </>
  );
}
