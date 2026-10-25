'use client';

import { CircleCheck, Clock, QrCode } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, useTransition } from 'react';
import { CopyButton } from '@/components/client';
import { useI18n } from '@/components/i18n-provider';
import { Button, Notice } from '@/components/ui';
import { cx } from '@/lib/cx';
import {
  formatCompactVnd,
  formatDateTime,
  formatMicrosVnd,
  formatNumber,
  formatUsd,
  formatVnd,
  parseVndInput,
  vndToMicros,
} from '@/lib/format';
import { fmt } from '@/lib/i18n';
import type { Topup } from '@/lib/types/gateway';
import { topupBankInfo } from '@/lib/vietqr';
import { createTopupAction } from './actions';

export const PRESETS = [100_000, 200_000, 500_000, 1_000_000, 2_000_000, 5_000_000];
const MIN = 20_000;
const MAX = 50_000_000;
const POLL_MS = 3000;
const POLL_FOR_MS = 30 * 60_000;

type View =
  | { kind: 'choose' }
  | { kind: 'qr'; topup: Topup }
  | { kind: 'paid'; topup: Topup; balanceMicros: number | null }
  | { kind: 'unavailable' };

export function TopupPanel({
  rate,
  initialTopup,
  contactEmail,
  contactZalo,
}: {
  rate: number;
  initialTopup?: Topup | null;
  contactEmail?: string;
  contactZalo?: string;
}) {
  const { t, locale } = useI18n();
  const B = t.billing;
  const router = useRouter();
  const [view, setView] = useState<View>(
    initialTopup ? { kind: 'qr', topup: initialTopup } : { kind: 'choose' },
  );
  const [preset, setPreset] = useState<number | null>(200_000);
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  const [pending, start] = useTransition();
  const customId = useId();

  const customAmount = custom ? parseVndInput(custom) : null;
  const amount = custom ? customAmount : preset;
  const amountError =
    custom && customAmount === null
      ? B.invalidAmount
      : amount !== null && (amount < MIN || amount > MAX)
        ? fmt(B.amountRange, { min: formatVnd(MIN, locale), max: formatVnd(MAX, locale) })
        : null;

  function create() {
    if (!amount || amountError) return;
    setError(null);
    start(async () => {
      const res = await createTopupAction(amount);
      if (res.ok) {
        setQrFailed(false);
        setView({ kind: 'qr', topup: res.topup });
      } else if (res.unavailable) setView({ kind: 'unavailable' });
      else setError(fmt(B.errorCreate, { message: res.message }));
    });
  }

  // Poll until the bank transfer lands.
  const polling = view.kind === 'qr' ? view.topup.id : null;
  useEffect(() => {
    if (!polling) return;
    const started = Date.now();
    let stopped = false;
    const tick = async () => {
      if (stopped || document.visibilityState === 'hidden') return;
      try {
        const res = await fetch(`/api/wallet/topups/${encodeURIComponent(polling)}`, { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { topup: Topup; balanceMicros: number | null };
        if (body.topup.status === 'paid' && !stopped) {
          stopped = true;
          setView({ kind: 'paid', topup: body.topup, balanceMicros: body.balanceMicros });
          router.refresh();
        }
      } catch {}
    };
    const id = setInterval(() => {
      if (Date.now() - started > POLL_FOR_MS) clearInterval(id);
      else void tick();
    }, POLL_MS);
    void tick();
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [polling, router]);

  if (view.kind === 'unavailable') {
    return (
      <div className="rounded-xl border border-dashed border-line-strong bg-surface-2/50 p-5">
        <div className="flex items-start gap-3">
          <Clock className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
          <div>
            <h3 className="font-semibold">{B.unavailableTitle}</h3>
            <p className="mt-1 text-sm text-muted">{B.unavailableBody}</p>
            {(contactEmail || contactZalo) && (
              <p className="mt-3 text-sm">
                {B.contact}:{' '}
                {contactEmail && (
                  <a className="text-accent hover:underline" href={`mailto:${contactEmail}`}>
                    {contactEmail}
                  </a>
                )}
                {contactEmail && contactZalo && ' · '}
                {contactZalo && (
                  <a
                    className="text-accent hover:underline"
                    href={`https://zalo.me/${contactZalo}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Zalo {contactZalo}
                  </a>
                )}
              </p>
            )}
            <Button
              variant="secondary"
              size="sm"
              className="mt-4"
              onClick={() => setView({ kind: 'choose' })}
            >
              {t.common.back}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (view.kind === 'paid') {
    const received = view.topup.receivedVnd ?? view.topup.amountVnd;
    return (
      <div
        className="animate-pop rounded-xl border border-ok/30 bg-ok-soft p-6 text-center"
        role="status"
        aria-live="polite"
      >
        <CircleCheck className="mx-auto size-10 text-ok" aria-hidden />
        <h3 className="mt-3 text-2xl font-semibold text-ok-ink">
          {fmt(B.paidTitle, { amount: formatVnd(received, locale) })}
        </h3>
        <p className="mt-2 text-sm text-ok-ink/90">
          {fmt(B.paidBody, {
            credit: formatMicrosVnd(
              view.topup.creditedMicros ?? view.topup.creditMicros,
              view.topup.vndPerUsd,
              locale,
            ),
            balance: view.balanceMicros === null ? '—' : formatMicrosVnd(view.balanceMicros, rate, locale),
          })}
        </p>
        <Button className="mt-5" onClick={() => setView({ kind: 'choose' })}>
          {B.paidDone}
        </Button>
      </div>
    );
  }

  if (view.kind === 'qr') {
    const tp = view.topup;
    const qr = topupBankInfo(tp);
    const expired = new Date(tp.expiresAt).getTime() < Date.now();
    return (
      <div className="grid gap-6 md:grid-cols-[minmax(0,15rem)_1fr]">
        <div className="mx-auto w-full max-w-60">
          {tp.qrImageUrl && !qrFailed ? (
            // biome-ignore lint/performance/noImgElement: external VietQR image, already sized; next/image adds nothing here
            <img
              src={tp.qrImageUrl}
              alt={fmt(B.qrAlt, { amount: formatVnd(tp.amountVnd, locale), account: qr?.accountNo ?? '' })}
              width={240}
              height={240}
              onError={() => setQrFailed(true)}
              className="aspect-square w-full rounded-xl border border-line bg-white object-contain p-2"
            />
          ) : (
            <div className="grid aspect-square place-items-center rounded-xl border border-dashed border-line-strong bg-surface-2 p-4 text-center">
              <div>
                <QrCode className="mx-auto size-10 text-faint" aria-hidden />
                <p className="mt-2 text-xs text-muted">{B.qrUnavailable}</p>
              </div>
            </div>
          )}
          {!qrFailed && tp.qrImageUrl && <p className="mt-2 text-center text-xs text-muted">{B.qrHelp}</p>}
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold">{B.qrTitle}</h3>
          <dl className="mt-3 divide-y divide-line rounded-xl border border-line">
            {qr && <CopyRow label={B.bank} value={qr.bankName} copy={false} />}
            {qr && <CopyRow label={B.accountNo} value={qr.accountNo} mono />}
            {qr?.accountName && <CopyRow label={B.accountName} value={qr.accountName} copy={false} />}
            <CopyRow
              label={B.amount}
              value={formatVnd(tp.amountVnd, locale)}
              copyValue={String(tp.amountVnd)}
              strong
            />
            <CopyRow label={B.content} value={tp.code} mono strong hint={B.contentHint} />
          </dl>
          <p className="mt-3 text-xs text-muted">
            {fmt(B.lockedRate, { rate: formatNumber(tp.vndPerUsd, locale) })}
          </p>
          <div
            className="mt-4 flex items-center gap-3 rounded-xl bg-surface-2 px-4 py-3"
            role="status"
            aria-live="polite"
          >
            <span
              aria-hidden
              className="size-4 shrink-0 animate-spin rounded-full border-2 border-accent border-r-transparent"
            />
            <div className="min-w-0 text-sm">
              <div className="font-medium">{B.waiting}</div>
              <div className="text-xs text-muted">{B.waitingHint}</div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
            <span className={cx(expired && 'text-warn')}>
              {fmt(B.expires, { time: formatDateTime(tp.expiresAt, locale) })}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setView({ kind: 'choose' })}>
              {B.newTopup}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <fieldset>
        <legend className="sr-only">{B.amount}</legend>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {PRESETS.map((p) => {
            const active = !custom && preset === p;
            return (
              <button
                key={p}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setPreset(p);
                  setCustom('');
                }}
                className={cx(
                  'rounded-lg border px-2 py-3 text-center transition-colors',
                  active
                    ? 'border-accent bg-accent-soft text-accent-ink ring-1 ring-accent'
                    : 'border-line-strong bg-surface hover:bg-surface-2',
                )}
              >
                <div className="font-semibold">{formatCompactVnd(p, locale)}</div>
                <div className="text-[0.7rem] text-muted tabular-nums">{formatVnd(p, locale)}</div>
              </button>
            );
          })}
        </div>
      </fieldset>
      <div className="mt-4 max-w-sm">
        <label htmlFor={customId} className="block text-sm font-medium">
          {B.customAmount}
        </label>
        <input
          id={customId}
          inputMode="decimal"
          autoComplete="off"
          placeholder={B.customPlaceholder}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          aria-invalid={Boolean(custom && amountError)}
          aria-describedby={`${customId}-hint`}
          className="input mt-1.5"
        />
        <p
          id={`${customId}-hint`}
          className={cx('mt-1.5 text-xs', custom && amountError ? 'text-danger' : 'text-muted')}
        >
          {custom && amountError
            ? amountError
            : fmt(B.customHint, { min: formatVnd(MIN, locale), max: formatVnd(MAX, locale) })}
        </p>
      </div>

      {amount && !amountError && (
        <div className="mt-5 rounded-xl bg-surface-2 px-4 py-3">
          <div className="text-sm font-medium">{fmt(B.youGet, { credit: formatVnd(amount, locale) })}</div>
          <div className="mt-0.5 text-xs text-muted">
            {fmt(B.youGetUsd, {
              usd: formatUsd(vndToMicros(amount, rate)),
              rate: formatNumber(rate, locale),
            })}
          </div>
        </div>
      )}

      {error && (
        <Notice tone="danger" className="mt-4">
          {error}
        </Notice>
      )}

      <Button
        className="mt-5"
        size="lg"
        onClick={create}
        disabled={!amount || Boolean(amountError) || pending}
      >
        {pending ? (
          <>
            <span
              aria-hidden
              className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent"
            />
            {B.creating}
          </>
        ) : (
          <>
            <QrCode className="size-4" aria-hidden />
            {B.createQr}
          </>
        )}
      </Button>
    </div>
  );
}

function CopyRow({
  label,
  value,
  copyValue,
  mono,
  strong,
  hint,
  copy = true,
}: {
  label: string;
  value: string;
  copyValue?: string;
  mono?: boolean;
  strong?: boolean;
  hint?: string;
  copy?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <dt className="text-xs text-muted">{label}</dt>
        <dd className={cx('truncate', mono && 'font-mono tracking-wide', strong && 'font-semibold')}>
          {value}
        </dd>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </div>
      {copy && <CopyButton value={copyValue ?? value} variant="ghost" iconOnly />}
    </div>
  );
}
