import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getDictionary } from '@/lib/i18n';
import { getI18n, getLocale } from '@/lib/i18n/server';
import { safeNext } from '@/lib/safe-next';
import { getSession } from '@/lib/session';
import { SignupForm } from '../auth-forms';

export async function generateMetadata(): Promise<Metadata> {
  return { title: getDictionary(await getLocale()).auth.signupTitle };
}

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const [{ t }, sp, session] = await Promise.all([getI18n(), searchParams, getSession()]);
  const next = safeNext(sp.next);
  if (session) redirect(next);
  return (
    <div className="mx-auto max-w-sm px-4 py-14 sm:py-20">
      <h1 className="text-2xl font-semibold tracking-tight">{t.auth.signupTitle}</h1>
      <p className="mt-1.5 text-muted">{t.auth.signupSubtitle}</p>
      <div className="mt-8 rounded-2xl border border-line bg-surface p-6 shadow-card">
        <SignupForm next={next} />
      </div>
    </div>
  );
}
