import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ServiceProblem } from '@/components/console';
import { Card, CardBody, PageHeader } from '@/components/ui';
import { fmt, getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { reviewApi } from '@/lib/services';
import { requireSession } from '@/lib/session';
import { RepoSettingsForm } from './settings-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).review.settings };
}

export default async function RepoSettingsPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const session = await requireSession();
  const { t } = await getI18n();
  const { owner, repo } = await params;
  const fullName = `${decodeURIComponent(owner)}/${decodeURIComponent(repo)}`;
  const res = await reviewApi.repoSettings(session.org.id, fullName);

  return (
    <>
      <Link
        href="/console/review"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t.review.title}
      </Link>
      <PageHeader
        title={fmt(t.review.settingsTitle, { repo: fullName })}
        description={t.review.settingsBody}
      />
      {res.ok ? (
        <Card>
          <CardBody>
            <RepoSettingsForm
              repo={res.data.repo}
              settings={res.data.settings}
              defaults={res.data.defaults}
            />
          </CardBody>
        </Card>
      ) : (
        <ServiceProblem error={res.error} t={t} />
      )}
    </>
  );
}
