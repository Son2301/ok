'use client';

import { KeyRound, TriangleAlert } from 'lucide-react';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import { ConfirmButton, CopyButton, RelativeTime, SubmitButton } from '@/components/client';
import { useI18n } from '@/components/i18n-provider';
import { Badge, Button, EmptyState, Field, Notice } from '@/components/ui';
import { cx } from '@/lib/cx';
import { formatMicrosVnd, formatNumber, microsToVnd } from '@/lib/format';
import { fmt } from '@/lib/i18n';
import type { KeyView } from '@/lib/keys';
import { gatewayCurl } from '@/lib/snippets';
import { type CreateKeyState, createKeyAction, revokeKeyAction, updateCapAction } from './actions';

const PRODUCTS = ['gateway', 'agents', 'safe', 'review'] as const;
const DEFAULT_CAP_VND = 500_000;

export function CreateKeyForm({ baseUrl }: { baseUrl: string }) {
  const { t, locale } = useI18n();
  const K = t.keys;
  const [state, action] = useActionState<CreateKeyState, FormData>(createKeyAction, {});
  const [all, setAll] = useState(false);
  const [capOn, setCapOn] = useState(true);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const created = state.created && state.created.key !== dismissed ? state.created : null;

  useEffect(() => {
    if (state.created) formRef.current?.reset();
  }, [state.created]);

  if (created) {
    return (
      <div className="animate-pop space-y-4" role="status">
        <div>
          <h3 className="font-semibold">{K.createdTitle}</h3>
          <p className="mt-1 text-sm text-muted">{K.createdBody}</p>
        </div>
        <div className="flex flex-col gap-2 rounded-xl border border-accent/40 bg-accent-soft p-3 sm:flex-row sm:items-center">
          <code className="min-w-0 flex-1 font-mono text-sm break-all text-accent-ink">{created.key}</code>
          <CopyButton value={created.key} variant="primary" />
        </div>
        <div className="overflow-hidden rounded-xl border border-line bg-surface-2">
          <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
            <span className="font-mono text-xs text-muted">bash</span>
            <CopyButton value={gatewayCurl(baseUrl, created.key)} variant="ghost" />
          </div>
          <pre className="overflow-x-auto p-3 text-[0.8125rem] leading-relaxed">
            <code>{gatewayCurl(baseUrl, created.key)}</code>
          </pre>
        </div>
        <Button variant="secondary" onClick={() => setDismissed(created.key)}>
          {K.createdDone}
        </Button>
      </div>
    );
  }

  const err = (f: CreateKeyState['field']) => (state.field === f ? state.error : undefined);
  return (
    <form ref={formRef} action={action} className="space-y-5" noValidate>
      {state.error && !state.field && <Notice tone="danger">{state.error}</Notice>}
      <Field label={K.name} htmlFor="key-name" error={err('name')}>
        <input
          id="key-name"
          name="name"
          required
          maxLength={80}
          placeholder={K.namePlaceholder}
          aria-invalid={Boolean(err('name'))}
          className="input max-w-md"
        />
      </Field>

      <fieldset>
        <legend className="text-sm font-medium">{K.scopes}</legend>
        <p className="mt-0.5 text-xs text-muted">{K.scopesHint}</p>
        <div className="mt-2.5 flex flex-wrap gap-2">
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
            <input
              type="checkbox"
              name="scope_all"
              checked={all}
              onChange={(e) => setAll(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            {K.scopesAll}
          </label>
          {PRODUCTS.map((p) => (
            <label
              key={p}
              className={cx(
                'flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft',
                all && 'pointer-events-none opacity-50',
              )}
            >
              <input
                type="checkbox"
                name="scopes"
                value={p}
                defaultChecked={p === 'gateway'}
                disabled={all}
                className="accent-[var(--accent)]"
              />
              {t.products[p].name}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="rounded-xl border border-line p-4">
        <label className="flex cursor-pointer items-center gap-2.5 text-sm font-medium">
          <input
            type="checkbox"
            name="cap_on"
            checked={capOn}
            onChange={(e) => setCapOn(e.target.checked)}
            className="size-4 accent-[var(--accent)]"
          />
          {K.capToggle}
        </label>
        {capOn ? (
          <div className="mt-3 max-w-xs">
            <Field label={K.capAmount} htmlFor="key-cap" error={err('cap')}>
              <div className="relative">
                <input
                  id="key-cap"
                  name="cap"
                  inputMode="decimal"
                  defaultValue={formatNumber(DEFAULT_CAP_VND, locale)}
                  aria-invalid={Boolean(err('cap'))}
                  aria-describedby="key-cap-help"
                  className="input pr-10"
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 grid place-items-center text-sm text-muted">
                  {locale === 'vi' ? 'đ' : '₫'}
                </span>
              </div>
            </Field>
            <p id="key-cap-help" className="mt-2 text-xs text-muted">
              {K.capHint}
            </p>
          </div>
        ) : (
          <p className="mt-2 flex items-start gap-2 text-sm text-warn">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            {K.capOffWarning}
          </p>
        )}
      </div>

      <SubmitButton pendingLabel={K.creating}>
        <KeyRound className="size-4" aria-hidden />
        {K.create}
      </SubmitButton>
    </form>
  );
}

export function KeyList({ keys, rate }: { keys: KeyView[]; rate: number }) {
  const { t, locale } = useI18n();
  const K = t.keys;
  const [showRevoked, setShowRevoked] = useState(false);
  const visible = keys.filter((k) => showRevoked || !k.revokedAt);
  const revokedCount = keys.filter((k) => k.revokedAt).length;

  if (keys.length === 0)
    return (
      <EmptyState icon={<KeyRound className="size-5" />} title={K.empty}>
        {K.emptyBody}
      </EmptyState>
    );

  return (
    <div>
      <ul className="divide-y divide-line border-t border-line">
        {visible.map((k) => (
          <KeyRow key={k.id} k={k} rate={rate} />
        ))}
      </ul>
      {revokedCount > 0 && (
        <label className="flex items-center gap-2 px-5 py-3 text-sm text-muted">
          <input
            type="checkbox"
            checked={showRevoked}
            onChange={(e) => setShowRevoked(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          {K.showRevoked} ({formatNumber(revokedCount, locale)})
        </label>
      )}
    </div>
  );
}

function KeyRow({ k, rate }: { k: KeyView; rate: number }) {
  const { t, locale } = useI18n();
  const K = t.keys;
  const [editing, setEditing] = useState(false);
  const [cap, setCap] = useState(
    k.spendLimitMicros != null ? formatNumber(Math.round(microsToVnd(k.spendLimitMicros, rate)), locale) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const capReached = k.spendLimitMicros != null && k.spentMicros >= k.spendLimitMicros;
  const scopes = k.scopes.includes('*')
    ? [K.scopesAll]
    : k.scopes.map((s) => (t.products as Record<string, { name: string }>)[s]?.name ?? s);

  function saveCap(value: string | null) {
    setError(null);
    start(async () => {
      const res = await updateCapAction(k.id, value);
      if (res.ok) setEditing(false);
      else setError(res.error ?? t.errors.generic.replace('{message}', ''));
    });
  }

  return (
    <li className={cx('px-5 py-4', k.revokedAt && 'opacity-60')}>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{k.name}</span>
            {k.revokedAt ? (
              <Badge>{K.revoked}</Badge>
            ) : capReached ? (
              <Badge tone="warn">{K.capReached}</Badge>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <code className="font-mono">{k.prefix}</code>
            <span>{scopes.join(', ')}</span>
            <span>
              {K.colLastUsed}: {k.lastUsedAt ? <RelativeTime date={k.lastUsedAt} /> : K.never}
            </span>
          </div>
        </div>
        <div className="text-right text-sm">
          <div className="tabular-nums">
            <span className="font-medium">
              {formatMicrosVnd(k.spentMicros, rate, locale, { precise: true })}
            </span>
            <span className="text-muted">
              {' '}
              / {k.spendLimitMicros != null ? formatMicrosVnd(k.spendLimitMicros, rate, locale) : K.noCap}
            </span>
          </div>
          {k.spendLimitMicros != null && k.spendLimitMicros > 0 && (
            <div className="mt-1.5 ml-auto h-1.5 w-32 overflow-hidden rounded-full bg-surface-3" aria-hidden>
              <div
                className={cx('h-full rounded-full', capReached ? 'bg-warn' : 'bg-accent')}
                style={{ width: `${Math.min(100, (k.spentMicros / k.spendLimitMicros) * 100)}%` }}
              />
            </div>
          )}
        </div>
        {!k.revokedAt && (
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
              {K.editCap}
            </Button>
            <ConfirmButton
              title={K.revoke}
              body={fmt(K.revokeConfirm, { name: k.name })}
              confirmLabel={K.revokeYes}
              onConfirm={async () => {
                await revokeKeyAction(k.id);
              }}
            >
              {K.revoke}
            </ConfirmButton>
          </div>
        )}
      </div>
      {editing && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="w-44">
            <label htmlFor={`cap-${k.id}`} className="block text-xs text-muted">
              {K.capAmount}
            </label>
            <input
              id={`cap-${k.id}`}
              value={cap}
              inputMode="decimal"
              onChange={(e) => setCap(e.target.value)}
              className="input mt-1"
            />
          </div>
          <Button size="sm" onClick={() => saveCap(cap)} disabled={pending}>
            {K.saveCap}
          </Button>
          {k.spendLimitMicros != null && (
            <Button size="sm" variant="ghost" onClick={() => saveCap(null)} disabled={pending}>
              {K.removeCap}
            </Button>
          )}
          {error && <span className="text-sm text-danger">{error}</span>}
        </div>
      )}
    </li>
  );
}
