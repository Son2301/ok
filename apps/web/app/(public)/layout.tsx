import { Menu } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { LanguageToggle, ThemeToggle } from '@/components/client';
import { Logo } from '@/components/logo';
import { ButtonLink } from '@/components/ui';
import { env } from '@/lib/env';
import { getI18n, getTheme } from '@/lib/i18n/server';
import { getSession } from '@/lib/session';

export default async function PublicLayout({ children }: { children: ReactNode }) {
  const [{ t }, theme, session] = await Promise.all([getI18n(), getTheme(), getSession()]);
  const cfg = env();
  const nav = [
    { href: '/#products', label: t.nav.products },
    { href: '/models', label: t.nav.models },
    { href: '/safe', label: t.nav.safe },
  ];

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-line/70 bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Logo brand={cfg.brandName} />
          <nav aria-label={t.nav.products} className="ml-6 hidden items-center gap-1 md:flex">
            {nav.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg"
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <LanguageToggle className="hidden sm:block" />
            <ThemeToggle initial={theme} />
            {session ? (
              <ButtonLink href="/console" size="sm">
                {t.common.openConsole}
              </ButtonLink>
            ) : (
              <>
                <span className="hidden sm:inline">
                  <ButtonLink href="/login" size="sm" variant="ghost">
                    {t.common.signIn}
                  </ButtonLink>
                </span>
                <ButtonLink href="/signup" size="sm">
                  {t.common.signUp}
                </ButtonLink>
              </>
            )}
            <details className="relative md:hidden">
              <summary
                aria-label={t.common.menu}
                className="grid size-8 cursor-pointer list-none place-items-center rounded-lg hover:bg-surface-2 [&::-webkit-details-marker]:hidden"
              >
                <Menu className="size-5" aria-hidden />
              </summary>
              <div className="absolute right-0 mt-2 w-56 rounded-xl border border-line bg-surface p-2 shadow-pop">
                {nav.map((n) => (
                  <Link
                    key={n.href}
                    href={n.href}
                    className="block rounded-lg px-3 py-2 text-sm hover:bg-surface-2"
                  >
                    {n.label}
                  </Link>
                ))}
                {!session && (
                  <Link href="/login" className="block rounded-lg px-3 py-2 text-sm hover:bg-surface-2">
                    {t.common.signIn}
                  </Link>
                )}
                <div className="mt-1 border-t border-line px-3 pt-3 pb-1">
                  <LanguageToggle />
                </div>
              </div>
            </details>
          </div>
        </div>
      </header>

      <main id="main" className="flex-1">
        {children}
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm sm:px-6 md:grid-cols-[1.5fr_1fr_1fr]">
          <div>
            <Logo brand={cfg.brandName} />
            <p className="mt-3 max-w-xs text-muted">{t.landing.footerTagline}</p>
            <p className="mt-3 text-muted">
              {cfg.founderName || t.landing.principles.founder.placeholder}
              {cfg.companyTaxCode && (
                <>
                  {' · '}
                  {t.landing.footerTax} {cfg.companyTaxCode}
                </>
              )}
            </p>
          </div>
          <div>
            <h2 className="font-medium">{t.nav.products}</h2>
            <ul className="mt-3 space-y-2 text-muted">
              <li>
                <Link className="hover:text-fg" href="/models">
                  {t.nav.models}
                </Link>
              </li>
              <li>
                <Link className="hover:text-fg" href="/safe">
                  {t.nav.safe}
                </Link>
              </li>
              <li>
                <Link className="hover:text-fg" href="/#principles">
                  {t.nav.principles}
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h2 className="font-medium">{t.landing.footerContact}</h2>
            <ul className="mt-3 space-y-2 text-muted">
              {cfg.contactEmail && (
                <li>
                  <a className="hover:text-fg" href={`mailto:${cfg.contactEmail}`}>
                    {cfg.contactEmail}
                  </a>
                </li>
              )}
              {cfg.contactZalo && (
                <li>
                  <a
                    className="hover:text-fg"
                    href={`https://zalo.me/${cfg.contactZalo}`}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    Zalo {cfg.contactZalo}
                  </a>
                </li>
              )}
              {!cfg.contactEmail && !cfg.contactZalo && <li>—</li>}
            </ul>
          </div>
        </div>
      </footer>
    </div>
  );
}
