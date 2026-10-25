import { ButtonLink } from '@/components/ui';
import { getI18n } from '@/lib/i18n/server';

export default async function NotFound() {
  const { t } = await getI18n();
  return (
    <main id="main" className="mx-auto grid min-h-dvh max-w-md place-items-center px-4 text-center">
      <div>
        <p className="font-mono text-sm text-muted">404</p>
        <h1 className="mt-2 text-2xl font-semibold">{t.errors.notFoundTitle}</h1>
        <p className="mt-2 text-muted">{t.errors.notFoundBody}</p>
        <ButtonLink href="/" variant="secondary" className="mt-6">
          {t.errors.goHome}
        </ButtonLink>
      </div>
    </main>
  );
}
