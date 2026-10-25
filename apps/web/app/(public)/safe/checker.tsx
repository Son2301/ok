'use client';

import { Paperclip, ScanSearch, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/components/i18n-provider';
import { VerdictCard } from '@/components/safe/verdict-card';
import { Button, Notice, Skeleton } from '@/components/ui';
import { cx } from '@/lib/cx';
import { detectInput, type InputKind } from '@/lib/detect';
import { fmt } from '@/lib/i18n';
import type { Verdict } from '@/lib/types/safe';

const MAX_MB = 20;

interface ApiError {
  error?: {
    code?: string;
    message?: string;
    kind?: string;
    details?: { vi?: string } & Record<string, unknown>;
  };
}

export function SafeChecker() {
  const { t, locale } = useI18n();
  const S = t.safe;
  const [text, setText] = useState('');
  const [override, setOverride] = useState<InputKind | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const detection = useMemo(() => detectInput(text), [text]);
  const kind: InputKind | null = detection.kind === 'empty' ? null : (override ?? detection.kind);
  // Reset a manual choice when the input changes shape.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the detected kind changes
  useEffect(() => setOverride(null), [detection.kind]);

  useEffect(() => {
    if (verdict || busy) resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [verdict, busy]);

  function pickFile(f: File | null) {
    setError(null);
    if (!f) return setFile(null);
    if (!/^(image|video|audio)\//.test(f.type)) return setError(S.fileType);
    if (f.size > MAX_MB * 1024 * 1024) return setError(fmt(S.fileTooLarge, { mb: MAX_MB }));
    setFile(f);
  }

  function valueFor(k: InputKind): { value: string; bank?: string } {
    if (k === detection.kind) return { value: detection.value, bank: detection.bank?.name };
    if (k === 'phone' || k === 'bank_account') {
      const digits = text.replace(/[^\d+]/g, '');
      return { value: digits || text.trim(), bank: detection.bank?.name };
    }
    return { value: text.trim() };
  }

  async function check() {
    if (busy) return;
    if (!file && !kind) return setError(S.emptyInput);
    setError(null);
    setVerdict(null);
    setBusy(true);
    try {
      let res: Response;
      if (file) {
        const form = new FormData();
        form.set('file', file);
        res = await fetch('/api/safe/check', { method: 'POST', body: form });
      } else {
        const k = kind!;
        res = await fetch('/api/safe/check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: k, ...valueFor(k) }),
        });
      }
      const body = (await res.json().catch(() => ({}))) as Verdict & ApiError;
      if (!res.ok) {
        const e = body.error;
        if (e?.kind === 'down' || e?.kind === 'timeout' || res.status === 503) setError(S.serviceDown);
        else
          setError(
            fmt(S.errorGeneric, {
              message: (locale === 'vi' && e?.details?.vi) || e?.message || `HTTP ${res.status}`,
            }),
          );
        return;
      }
      setVerdict(body);
    } catch {
      setError(S.serviceDown);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setVerdict(null);
    setText('');
    setFile(null);
    setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const alternatives = detection.kind === 'empty' ? [] : [detection.kind, ...detection.alternatives];

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
        className="rounded-2xl border border-line bg-surface p-4 shadow-pop sm:p-5"
      >
        <label htmlFor={inputId} className="sr-only">
          {S.inputLabel}
        </label>
        <textarea
          id={inputId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void check();
          }}
          rows={text.split('\n').length > 2 || text.length > 120 ? 6 : 3}
          placeholder={S.placeholder}
          className="input min-h-24 resize-y border-0 p-1 text-base shadow-none focus:shadow-none sm:text-lg"
          aria-describedby={`${inputId}-detect`}
          autoComplete="off"
          spellCheck={false}
        />

        <div
          id={`${inputId}-detect`}
          className="mt-2 flex min-h-8 flex-wrap items-center gap-2 text-sm"
          aria-live="polite"
        >
          {alternatives.length > 0 && !file && (
            <>
              <span className="text-muted">{override ? S.checkAs : S.detected}</span>
              {alternatives.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setOverride(k === detection.kind ? null : k)}
                  aria-pressed={kind === k}
                  className={cx(
                    'rounded-full border px-2.5 py-0.5 transition-colors',
                    kind === k
                      ? 'border-accent bg-accent-soft font-medium text-accent-ink'
                      : 'border-line text-muted hover:text-fg',
                  )}
                >
                  {S.kind[k]}
                  {k === 'bank_account' && detection.bank && kind === k ? ` · ${detection.bank.name}` : ''}
                </button>
              ))}
            </>
          )}
          {file && (
            <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-surface-2 py-0.5 pr-1 pl-3">
              <Paperclip className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{file.name}</span>
              <button
                type="button"
                onClick={() => {
                  setFile(null);
                  if (fileRef.current) fileRef.current.value = '';
                }}
                className="grid size-6 place-items-center rounded-full hover:bg-surface-3"
                aria-label={S.removeFile}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </span>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
          <div>
            <input
              ref={fileRef}
              id={`${inputId}-file`}
              type="file"
              accept="image/*,video/*,audio/*"
              className="sr-only"
              onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            />
            <label
              htmlFor={`${inputId}-file`}
              className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-surface-2 hover:text-fg focus-within:outline-2"
            >
              <Paperclip className="size-4" aria-hidden />
              {S.attach}
            </label>
          </div>
          <Button type="submit" size="lg" disabled={busy || (!file && !kind)} className="min-w-36">
            {busy ? (
              <>
                <span
                  aria-hidden
                  className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
                />
                {S.checking}
              </>
            ) : (
              <>
                <ScanSearch className="size-4" aria-hidden />
                {S.submit}
              </>
            )}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted">{fmt(S.attachHint, { mb: MAX_MB })}</p>
      </form>

      <div ref={resultRef} className="scroll-mt-20">
        {error && (
          <Notice tone="warn" className="mt-4">
            {error}
          </Notice>
        )}
        {busy && (
          <div className="mt-6 rounded-2xl border border-line bg-surface p-6" aria-busy="true">
            <p className="text-sm text-muted">{S.checkingHint}</p>
            <Skeleton className="mt-4 h-7 w-1/2" />
            <Skeleton className="mt-4 h-4 w-full" />
            <Skeleton className="mt-2 h-4 w-5/6" />
            <Skeleton className="mt-2 h-4 w-2/3" />
          </div>
        )}
        {verdict && (
          <div className="mt-6">
            <VerdictCard verdict={verdict} onReset={reset} />
          </div>
        )}
      </div>
    </div>
  );
}
