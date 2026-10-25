import type { ReactNode } from 'react';
import { Tabs } from '@/components/console-nav';
import { getI18n } from '@/lib/i18n/server';

export default async function GatewayLayout({ children }: { children: ReactNode }) {
  const { t } = await getI18n();
  const n = t.console.nav;
  return (
    <>
      <div className="mb-1 text-sm text-muted">{n.gateway}</div>
      <Tabs
        items={[
          { href: '/console/gateway', label: n.gatewayUsage, exact: true },
          { href: '/console/gateway/requests', label: n.gatewayRequests },
          { href: '/console/gateway/playground', label: n.gatewayPlayground },
          { href: '/console/gateway/providers', label: n.gatewayProviders },
        ]}
      />
      {children}
    </>
  );
}
