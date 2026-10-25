import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ServiceProblem } from '@/components/console';
import { VerdictCard } from '@/components/safe/verdict-card';
import { Notice, PageHeader } from '@/components/ui';
import { getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { safeApi } from '@/lib/services';
import { requireSession } from '@/lib/session';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).safeConsole.detailTitle };
}

export default async function SafeCheckPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { t } = await getI18n();
  const { id } = await params;
  const res = await safeApi.historyItem(session.org.id, id);
  return (
    <div className="max-w-3xl">
      <Link
        href="/console/safe"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t.safeConsole.historyTitle}
      </Link>
      <PageHeader title={t.safeConsole.detailTitle} />
      {res.ok ? (
        <>
          {res.data.kind === 'text' && (
            <Notice tone="neutral" className="mb-4">
              {t.safeConsole.redacted}
            </Notice>
          )}
          <VerdictCard verdict={res.data} />
        </>
      ) : (
        <ServiceProblem error={res.error} t={t} />
      )}
    </div>
  );
}
