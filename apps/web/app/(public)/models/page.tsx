import { Sparkles } from 'lucide-react';
import type { Metadata } from 'next';
import { ServiceProblem } from '@/components/console';
import { env } from '@/lib/env';
import { formatNumber } from '@/lib/format';
import { fmt, getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { gatewayApi } from '@/lib/services';
import { ModelsTable } from './models-table';

export async function generateMetadata(): Promise<Metadata> {
  const t = getDictionary(await getLocale());
  return { title: t.models.title, description: t.products.gateway.body };
}

export default async function ModelsPage() {
  const { t, locale } = await getI18n();
  const rate = env().vndPerUsd;
  const res = await gatewayApi.models({ include_disabled: 'true' });

  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold tracking-tight">{t.models.title}</h1>
      <p className="mt-2 max-w-3xl text-muted">
        {fmt(t.models.subtitle, { rate: formatNumber(rate, locale) })}
      </p>

      <div className="mt-6 flex gap-3 rounded-xl border border-line bg-surface p-4 shadow-card">
        <Sparkles className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
        <div>
          <h2 className="font-medium">{t.models.autoTitle}</h2>
          <p className="mt-1 text-sm text-muted">{t.models.autoBody}</p>
        </div>
      </div>

      <div className="mt-8">
        {res.ok ? (
          <ModelsTable models={res.data.data} rate={rate} />
        ) : (
          <ServiceProblem error={res.error} t={t} />
        )}
      </div>
      <p className="mt-6 text-xs text-muted">* {t.models.unverifiedHint}</p>
      <p className="mt-1 text-xs text-muted">{t.models.pricesNote}</p>
    </div>
  );
}
