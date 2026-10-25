'use client';

import {
  Bot,
  ChartColumn,
  GitPullRequest,
  KeyRound,
  LayoutDashboard,
  List,
  Menu,
  MessageSquare,
  ScanSearch,
  Server,
  Settings,
  Wallet,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cx } from '@/lib/cx';

const ICONS = {
  overview: LayoutDashboard,
  billing: Wallet,
  keys: KeyRound,
  usage: ChartColumn,
  requests: List,
  playground: MessageSquare,
  providers: Server,
  agents: Bot,
  safe: ScanSearch,
  review: GitPullRequest,
  settings: Settings,
} as const;

export type NavIcon = keyof typeof ICONS;
export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Match only the exact path (for /console). */
  exact?: boolean;
  badge?: number;
}
export interface NavGroup {
  label?: string;
  items: NavItem[];
}

function isActive(pathname: string, item: NavItem) {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function NavList({ groups, onNavigate }: { groups: NavGroup[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <div className="space-y-5">
      {groups.map((g, gi) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static navigation
        <div key={gi}>
          {g.label && (
            <div className="mb-1.5 px-3 text-xs font-medium tracking-wide text-faint uppercase">
              {g.label}
            </div>
          )}
          <ul className="space-y-0.5">
            {g.items.map((item) => {
              const Icon = ICONS[item.icon];
              const active = isActive(pathname, item);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cx(
                      'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                      active
                        ? 'bg-surface-3 font-medium text-fg'
                        : 'text-muted hover:bg-surface-2 hover:text-fg',
                    )}
                  >
                    <Icon className={cx('size-4 shrink-0', active ? 'text-accent' : '')} aria-hidden />
                    <span className="truncate">{item.label}</span>
                    {item.badge ? (
                      <span className="ml-auto rounded-full bg-accent px-1.5 text-xs font-semibold text-accent-fg tabular-nums">
                        {item.badge}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function SidebarNav({ groups }: { groups: NavGroup[] }) {
  return <NavList groups={groups} />;
}

/** Phone/tablet: a drawer opened from the top bar. */
export function MobileNav({
  groups,
  title,
  menuLabel,
  closeLabel,
}: {
  groups: NavGroup[];
  title: React.ReactNode;
  menuLabel: string;
  closeLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // biome-ignore lint/correctness/useExhaustiveDependencies: close on navigation
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="grid size-9 place-items-center rounded-lg hover:bg-surface-2 lg:hidden"
        aria-label={menuLabel}
        aria-expanded={open}
      >
        <Menu className="size-5" aria-hidden />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={menuLabel}>
          <button
            type="button"
            aria-label={closeLabel}
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-line bg-surface p-4 shadow-pop">
            <div className="mb-5 flex items-center justify-between">
              {title}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="grid size-9 place-items-center rounded-lg hover:bg-surface-2"
                aria-label={closeLabel}
              >
                <X className="size-5" aria-hidden />
              </button>
            </div>
            <NavList groups={groups} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}

/** Horizontal tabs for sub-sections (Gateway, Agents…). */
export function Tabs({
  items,
}: {
  items: { href: string; label: string; exact?: boolean; badge?: number; activePrefixes?: string[] }[];
}) {
  const pathname = usePathname();
  return (
    <nav className="-mx-4 mb-6 overflow-x-auto border-b border-line px-4 sm:mx-0 sm:px-0">
      <ul className="flex min-w-max gap-1">
        {items.map((it) => {
          const active =
            (it.exact ? pathname === it.href : pathname === it.href || pathname.startsWith(`${it.href}/`)) ||
            Boolean(it.activePrefixes?.some((p) => pathname.startsWith(p)));
          return (
            <li key={it.href}>
              <Link
                href={it.href}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm transition-colors',
                  active
                    ? 'border-accent font-medium text-fg'
                    : 'border-transparent text-muted hover:text-fg',
                )}
              >
                {it.label}
                {it.badge ? (
                  <span className="rounded-full bg-accent px-1.5 text-xs font-semibold text-accent-fg tabular-nums">
                    {it.badge}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
