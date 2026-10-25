import { Flag, PhoneOff, ShieldAlert } from 'lucide-react';
import type { Metadata } from 'next';
import { formatNumber, formatVnd } from '@/lib/format';
import { fmt, getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { safeApi } from '@/lib/services';
import { SafeChecker } from './checker';
import { ReportForm } from './report-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = getDictionary(await getLocale());
  return { title: t.safe.title, description: t.safe.subtitle };
}

export default async function SafePage() {
  const { t, locale } = await getI18n();
  const S = t.safe;
  const stats = await safeApi.stats(7);

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <div className="mb-6">
        <h1 className="flex items-center gap-2.5 text-3xl font-semibold tracking-tight">
          <ShieldAlert className="size-7 text-accent" aria-hidden />
          {S.title}
        </h1>
        <p className="mt-2 text-lg text-muted">{S.subtitle}</p>
      </div>

      <SafeChecker />

      <p className="mt-4 text-sm text-muted">{S.privacy}</p>

      <section className="mt-10 flex gap-4 rounded-2xl border border-line bg-surface p-5 sm:p-6">
        <PhoneOff className="mt-0.5 size-6 shrink-0 text-danger" aria-hidden />
        <div>
          <h2 className="text-lg font-semibold">{S.elderTitle}</h2>
          <p className="mt-1.5 text-[1.0625rem] leading-relaxed">{S.elderBody}</p>
        </div>
      </section>

      <section className="mt-10" aria-labelledby="stats">
        <h2 id="stats" className="text-lg font-semibold">
          {S.statsTitle}
        </h2>
        {stats.ok && (stats.data.totalChecks > 0 || stats.data.totalReports > 0) ? (
          <div className="mt-4 rounded-2xl border border-line bg-surface p-5">
            <dl className="grid grid-cols-2 gap-5 sm:grid-cols-4">
              {[
                { n: stats.data.totalChecks, label: S.statsChecks },
                { n: stats.data.dangerousFound, label: S.statsDangerous },
                { n: stats.data.totalReports, label: S.statsReports },
                { n: stats.data.verifiedReports, label: S.statsVerified },
              ].map((s) => (
                <div key={s.label}>
                  <dt className="sr-only">{s.label}</dt>
                  <dd className="text-2xl font-semibold tabular-nums">{formatNumber(s.n, locale)}</dd>
                  <div className="text-sm text-muted" aria-hidden>
                    {s.label}
                  </div>
                </div>
              ))}
            </dl>
            {stats.data.amountLostVnd > 0 && (
              <p className="mt-4 text-sm text-muted">
                {fmt(S.statsLost, { amount: formatVnd(stats.data.amountLostVnd, locale) })}
              </p>
            )}
            {stats.data.topCategories.length > 0 && (
              <div className="mt-5">
                <h3 className="text-sm font-medium">{S.statsTop}</h3>
                <ul className="mt-2 space-y-1.5">
                  {stats.data.topCategories.slice(0, 5).map((c) => (
                    <li key={c.category} className="flex justify-between gap-3 text-sm">
                      <span>{c.label[locale] || c.label.vi}</span>
                      <span className="text-muted tabular-nums">{formatNumber(c.count, locale)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted">{S.statsEmpty}</p>
        )}
      </section>

      <section
        id="report"
        className="mt-10 scroll-mt-20 rounded-2xl border border-line bg-surface p-5 sm:p-6"
        aria-labelledby="report-title"
      >
        <h2 id="report-title" className="flex items-center gap-2 text-lg font-semibold">
          <Flag className="size-5 text-accent" aria-hidden />
          {S.reportTitle}
        </h2>
        <p className="mt-1.5 mb-5 text-sm text-muted">{S.reportBody}</p>
        <ReportForm />
      </section>
    </div>
  );
}
