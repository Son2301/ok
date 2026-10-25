'use client';

import { useEffect } from 'react';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui';

/** Last-resort boundary: a calm message and a retry, never a stack trace. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main id="main" className="mx-auto grid min-h-[60vh] max-w-md place-items-center px-4 text-center">
      <div>
        <h1 className="text-xl font-semibold">{t.errors.crashTitle}</h1>
        <p className="mt-2 text-muted">{t.errors.crashBody}</p>
        {error.digest && <p className="mt-2 font-mono text-xs text-faint">{error.digest}</p>}
        <Button className="mt-6" onClick={reset}>
          {t.common.retry}
        </Button>
      </div>
    </main>
  );
}
