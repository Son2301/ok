import '@fontsource/be-vietnam-pro/400.css';
import '@fontsource/be-vietnam-pro/500.css';
import '@fontsource/be-vietnam-pro/600.css';
import '@fontsource/be-vietnam-pro/700.css';
import './globals.css';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/components/i18n-provider';
import { env } from '@/lib/env';
import { fmt } from '@/lib/i18n';
import { getI18n, getTheme } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getI18n();
  const brand = env().brandName;
  return {
    title: { default: fmt(t.meta.title, { brand }), template: `%s · ${brand}` },
    description: t.meta.description,
    applicationName: brand,
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f5f1' },
    { media: '(prefers-color-scheme: dark)', color: '#111110' },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [{ locale, t }, theme] = await Promise.all([getI18n(), getTheme()]);
  return (
    <html lang={locale} data-theme={theme} suppressHydrationWarning>
      <body className="min-h-dvh">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2 focus:shadow-pop"
        >
          {t.common.skipToContent}
        </a>
        <I18nProvider locale={locale} t={t}>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
