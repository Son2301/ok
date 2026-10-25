import { GitPullRequest } from 'lucide-react';
import type { Metadata } from 'next';
import { ButtonLink, Notice } from '@/components/ui';
import { fmt, getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { requireSession } from '@/lib/session';
import { LinkForm } from './link-form';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).review.linkTitle };
}

/** Target of the "link your account" link the review bot posts on pull requests. */
export default async function ReviewLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ installation_id?: string; state?: string; code?: string }>;
}) {
  const session = await requireSession();
  const { t } = await getI18n();
  const sp = await searchParams;
  const id = sp.installation_id && /^\d{1,20}$/.test(sp.installation_id) ? sp.installation_id : null;

  return (
    <div className="mx-auto max-w-lg px-4 py-14 sm:py-20">
      <div className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent-ink">
        <GitPullRequest className="size-5" aria-hidden />
      </div>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">{t.review.linkTitle}</h1>
      {id ? (
        <>
          <p className="mt-2 text-muted">{fmt(t.review.linkBody, { id, org: session.org.name })}</p>
          <div className="mt-6 rounded-2xl border border-line bg-surface p-6 shadow-card">
            <LinkForm installationId={id} state={sp.state} code={sp.code} />
          </div>
        </>
      ) : (
        <div className="mt-6 space-y-4">
          <Notice tone="warn">{t.review.linkMissing}</Notice>
          <ButtonLink href="/console/review" variant="secondary">
            {t.review.title}
          </ButtonLink>
        </div>
      )}
    </div>
  );
}
