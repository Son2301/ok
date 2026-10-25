'use client';

import { Check, X } from 'lucide-react';
import { useId, useState, useTransition } from 'react';
import { RelativeTime } from '@/components/client';
import { useI18n } from '@/components/i18n-provider';
import { Badge, Button } from '@/components/ui';
import type { Approval } from '@/lib/types/agents';
import { decideApprovalAction } from '../actions';

/** One pending action, shown exactly as it will run (tool + arguments), with approve / reject and an optional note. */
export function ApprovalCard({ approval, agentName }: { approval: Approval; agentName: string }) {
  const { t } = useI18n();
  const A = t.agents;
  const [note, setNote] = useState('');
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const noteId = useId();

  const decide = (d: 'approve' | 'reject') =>
    start(async () => {
      const res = await decideApprovalAction(approval.id, d, note);
      setResult(
        res.ok
          ? {
              ok: true,
              text:
                A.approvalStatus[(res.status ?? 'executed') as keyof typeof A.approvalStatus] ??
                res.status ??
                '',
            }
          : { ok: false, text: res.error ?? '' },
      );
    });

  return (
    <article className="rounded-xl border border-line bg-surface p-4 shadow-card sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-medium">{approval.tool}</span>
        <Badge tone={approval.mode === 'draft' ? 'neutral' : 'warn'}>{A.approvalMode[approval.mode]}</Badge>
        <span className="text-xs text-muted">
          {agentName} · <RelativeTime date={approval.createdAt} />
        </span>
      </div>
      <div className="mt-3">
        <div className="text-xs font-medium text-muted">{A.arguments}</div>
        <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-surface-2 p-3 text-xs leading-relaxed whitespace-pre-wrap break-words">
          {JSON.stringify(approval.arguments, null, 2)}
        </pre>
      </div>
      {result ? (
        <p role="status" className={`mt-3 text-sm ${result.ok ? 'text-ok' : 'text-danger'}`}>
          {result.text}
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-56">
            <label htmlFor={noteId} className="sr-only">
              {A.notePlaceholder}
            </label>
            <input
              id={noteId}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={A.notePlaceholder}
              maxLength={1000}
              className="input text-sm"
            />
          </div>
          <Button onClick={() => decide('approve')} disabled={pending}>
            <Check className="size-4" aria-hidden />
            {A.approve}
          </Button>
          <Button variant="secondary" onClick={() => decide('reject')} disabled={pending}>
            <X className="size-4" aria-hidden />
            {A.reject}
          </Button>
        </div>
      )}
    </article>
  );
}
