import { LogOut } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { logoutAction } from '@/app/actions';
import { LanguageToggle, ThemeToggle } from '@/components/client';
import { MobileNav, type NavGroup, SidebarNav } from '@/components/console-nav';
import { Logo } from '@/components/logo';
import { env } from '@/lib/env';
import { formatMicrosVnd } from '@/lib/format';
import { getI18n, getTheme } from '@/lib/i18n/server';
import { platform } from '@/lib/platform';
import { services } from '@/lib/services';
import { requireSession } from '@/lib/session';
import type { Approval } from '@/lib/types/agents';

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const session = await requireSession();
  const [{ t, locale }, theme] = await Promise.all([getI18n(), getTheme()]);
  const cfg = env();
  const orgId = session.org.id;

  // Header data must never block or break the page: local balance (same DB), approvals with a short timeout.
  const [balanceMicros, approvals] = await Promise.all([
    platform()
      .then(({ core }) => core.getBalance(orgId))
      .catch(() => null),
    services().attempt<{ data: Approval[] }>('agents', '/v1/approvals', {
      orgId,
      query: { status: 'open', limit: 50 },
      timeoutMs: 1500,
    }),
  ]);
  const pending = approvals.ok ? approvals.data.data.length : 0;

  const n = t.console.nav;
  const groups: NavGroup[] = [
    {
      items: [
        { href: '/console', label: n.overview, icon: 'overview', exact: true },
        { href: '/console/billing', label: n.billing, icon: 'billing' },
        { href: '/console/keys', label: n.keys, icon: 'keys' },
      ],
    },
    {
      label: n.products,
      items: [
        { href: '/console/gateway', label: n.gateway, icon: 'usage' },
        { href: '/console/agents', label: n.agents, icon: 'agents', badge: pending },
        { href: '/console/safe', label: n.safe, icon: 'safe' },
        { href: '/console/review', label: n.review, icon: 'review' },
      ],
    },
    { items: [{ href: '/console/settings', label: n.settings, icon: 'settings' }] },
  ];

  const balance = balanceMicros === null ? null : formatMicrosVnd(balanceMicros, cfg.vndPerUsd, locale);
  const orgName = session.org.name;

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15.5rem_1fr]">
      {/* Sidebar (desktop): the column carries the border/background, the inner panel sticks. */}
      <div className="hidden border-r border-line bg-surface/70 lg:block">
        <aside className="sticky top-0 flex h-dvh flex-col px-3 py-4">
          <div className="px-2">
            <Logo brand={cfg.brandName} href="/console" />
            <div className="mt-3 truncate text-sm text-muted" title={orgName}>
              {orgName}
            </div>
          </div>
          <div className="mt-6 flex-1 overflow-y-auto">
            <SidebarNav groups={groups} />
          </div>
          <div className="mt-4 space-y-3 border-t border-line px-2 pt-4">
            <div className="flex items-center justify-between">
              <LanguageToggle />
              <ThemeToggle initial={theme} />
            </div>
            <div className="truncate text-xs text-muted" title={session.user.email}>
              {session.user.email}
            </div>
            <form action={logoutAction}>
              <button type="submit" className="flex items-center gap-2 text-sm text-muted hover:text-fg">
                <LogOut className="size-4" aria-hidden />
                {t.common.signOut}
              </button>
            </form>
          </div>
        </aside>
      </div>

      <div className="min-w-0">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-bg/85 px-4 backdrop-blur-md sm:px-6">
          <MobileNav
            groups={groups}
            title={<Logo brand={cfg.brandName} href="/console" />}
            menuLabel={t.common.menu}
            closeLabel={t.common.close}
          />
          <div className="min-w-0 truncate text-sm font-medium lg:hidden">{orgName}</div>
          <div className="ml-auto flex items-center gap-2">
            {balance !== null && (
              <Link
                href="/console/billing"
                className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm shadow-card hover:border-line-strong"
                title={t.overview.neverExpire}
              >
                <span className="hidden text-muted sm:inline">{t.console.balance}</span>
                <span className="font-semibold tabular-nums">{balance}</span>
              </Link>
            )}
            <Link
              href="/console/billing#topup"
              className="hidden rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg shadow-card hover:bg-accent-hover sm:inline-block"
            >
              {t.console.topUp}
            </Link>
            <div className="lg:hidden">
              <ThemeToggle initial={theme} />
            </div>
          </div>
        </header>

        <main id="main" className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>

        <div className="mx-auto max-w-6xl px-4 pb-8 sm:px-6 lg:hidden">
          <div className="flex items-center justify-between border-t border-line pt-4">
            <LanguageToggle />
            <form action={logoutAction}>
              <button type="submit" className="flex items-center gap-2 text-sm text-muted hover:text-fg">
                <LogOut className="size-4" aria-hidden />
                {t.common.signOut}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
