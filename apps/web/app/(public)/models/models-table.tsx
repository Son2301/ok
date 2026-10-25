'use client';

import { Search } from 'lucide-react';
import { useDeferredValue, useId, useMemo, useState } from 'react';
import { useI18n } from '@/components/i18n-provider';
import { Badge } from '@/components/ui';
import { cx } from '@/lib/cx';
import { formatNumber, formatPricePerMillion, formatTokens } from '@/lib/format';
import { fmt } from '@/lib/i18n';
import type { Capabilities, GwModel } from '@/lib/types/gateway';

const CAPS: (keyof Capabilities)[] = ['tools', 'vision', 'json', 'streaming'];

export function ModelsTable({ models, rate }: { models: GwModel[]; rate: number }) {
  const { t, locale } = useI18n();
  const M = t.models;
  const [q, setQ] = useState('');
  const query = useDeferredValue(q.trim().toLowerCase());
  const [caps, setCaps] = useState<Set<keyof Capabilities>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const searchId = useId();

  const rows = useMemo(
    () =>
      models
        .filter((m) => !m.id.startsWith('auto'))
        .filter((m) => showAll || m.available)
        .filter((m) => [...caps].every((c) => m.capabilities?.[c]))
        .filter((m) => {
          if (!query) return true;
          const hay = [m.id, m.name, m.owned_by, ...(m.aliases ?? []), ...m.providers.map((p) => p.provider)]
            .join(' ')
            .toLowerCase();
          return query.split(/\s+/).every((w) => hay.includes(w));
        })
        .sort((a, b) => Number(b.available) - Number(a.available) || a.id.localeCompare(b.id)),
    [models, caps, query, showAll],
  );

  const toggle = (c: keyof Capabilities) =>
    setCaps((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <label htmlFor={searchId} className="sr-only">
            {M.searchLabel}
          </label>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
            aria-hidden
          />
          <input
            id={searchId}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={M.searchPlaceholder}
            className="input pl-9"
          />
        </div>
        <fieldset className="flex flex-wrap gap-1.5">
          <legend className="sr-only">{M.filterLabel}</legend>
          {CAPS.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={caps.has(c)}
              onClick={() => toggle(c)}
              className={cx(
                'rounded-full border px-3 py-1.5 text-sm transition-colors',
                caps.has(c)
                  ? 'border-accent bg-accent-soft text-accent-ink'
                  : 'border-line text-muted hover:text-fg',
              )}
            >
              {M.cap[c]}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
        <span aria-live="polite">{fmt(M.count, { n: formatNumber(rows.length, locale) })}</span>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          {M.showUnavailable}
        </label>
      </div>

      {rows.length === 0 ? (
        <p className="py-16 text-center text-muted">{M.empty}</p>
      ) : (
        <ul className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-card">
          {rows.map((m) => {
            const price = m.pricing;
            const input = price ? formatPricePerMillion(price.prompt, rate, locale) : null;
            const output = price ? formatPricePerMillion(price.completion, rate, locale) : null;
            const unverified = m.providers.some((p) => !p.verified);
            return (
              <li
                key={m.id}
                className={cx(
                  'grid gap-3 px-4 py-4 sm:px-5 md:grid-cols-[1fr_9rem_9rem_7rem] md:items-center',
                  !m.available && 'opacity-60',
                )}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{m.name}</span>
                    {!m.available && <Badge>{M.unavailable}</Badge>}
                    {unverified && (
                      <Badge tone="neutral" title={M.unverifiedHint}>
                        {M.unverified}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-muted break-all">{m.id}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {CAPS.filter((c) => m.capabilities?.[c]).map((c) => (
                      <span key={c} className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">
                        {M.cap[c]}
                      </span>
                    ))}
                    {m.providers.map((p) => (
                      <span
                        key={p.provider}
                        className={cx(
                          'rounded border border-line px-1.5 py-0.5 text-xs',
                          p.enabled ? 'text-fg' : 'text-faint line-through',
                        )}
                        title={p.verified ? undefined : M.unverifiedHint}
                      >
                        {p.provider}
                        {!p.verified && '*'}
                      </span>
                    ))}
                  </div>
                </div>
                <PriceCell label={M.colInput} price={input} />
                <PriceCell label={M.colOutput} price={output} />
                <div className="text-sm md:text-right">
                  <div className="text-xs text-muted md:hidden">{M.colContext}</div>
                  {m.context_length
                    ? fmt(M.contextTokens, { n: formatTokens(m.context_length, locale) })
                    : '—'}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PriceCell({ label, price }: { label: string; price: { usd: string; vnd: string } | null }) {
  const { t } = useI18n();
  return (
    <div className="text-sm md:text-right">
      <div className="text-xs text-muted">
        {label} <span className="md:hidden">{t.common.perMillion}</span>
      </div>
      {price ? (
        <>
          <div className="font-medium tabular-nums">{price.vnd}</div>
          <div className="text-xs text-muted tabular-nums">{price.usd}</div>
        </>
      ) : (
        '—'
      )}
    </div>
  );
}
