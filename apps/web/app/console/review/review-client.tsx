'use client';

import { RefreshCw } from 'lucide-react';
import { useState, useTransition } from 'react';
import { ConfirmButton } from '@/components/client';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui';
import { fmt } from '@/lib/i18n';
import { rerunReviewAction, unlinkInstallationAction } from './actions';

export function UnlinkButton({ id, account }: { id: number; account: string }) {
  const { t } = useI18n();
  return (
    <ConfirmButton
      title={t.review.unlink}
      body={fmt(t.review.unlinkConfirm, { account })}
      confirmLabel={t.review.unlink}
      variant="ghost"
      onConfirm={async () => {
        await unlinkInstallationAction(id);
      }}
    >
      {t.review.unlink}
    </ConfirmButton>
  );
}

export function RerunButtons({ target }: { target: string }) {
  const { t } = useI18n();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (full: boolean) =>
    start(async () => {
      const res = await rerunReviewAction(target, full);
      setMsg({ ok: res.ok, text: res.message });
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm" disabled={pending} onClick={() => run(false)}>
        <RefreshCw className="size-4" aria-hidden />
        {t.review.rerun}
      </Button>
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(true)}>
        {t.review.rerunFull}
      </Button>
      {msg && (
        <span role="status" className={`text-sm ${msg.ok ? 'text-ok' : 'text-danger'}`}>
          {msg.text}
        </span>
      )}
    </div>
  );
}
