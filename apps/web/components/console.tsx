import { CircleAlert, PlugZap } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { formatMicrosVnd, formatUsd, type Locale } from '@/lib/format';
import { type Dict, fmt } from '@/lib/i18n';
import type { ServiceErrorInfo } from '@/lib/service-client';
import { CopyButton } from './client';
import { Badge, Notice, type Tone } from './ui';

const SERVICE_NAMES = { gateway: 'Gateway', agents: 'Agents', safe: 'Safe', review: 'Review' } as const;

/**
 * Friendly state for a failed service call. "Down" and "timeout" get a calm
 * explanation; HTTP errors show the service's own message (it is written for
 * customers).
 */
export function ServiceProblem({
  error,
  t,
  className,
  audience = 'console',
}: {
  error: ServiceErrorInfo;
  t: Dict;
  className?: string;
  /** Public pages talk to visitors who may have no account or balance. */
  audience?: 'console' | 'public';
}) {
  const service = SERVICE_NAMES[error.service];
  if (error.kind === 'down') {
    return (
      <Notice
        tone="neutral"
        icon={<PlugZap className="size-4" aria-hidden />}
        title={fmt(t.errors.serviceDown, { service })}
        className={className}
      >
        {audience === 'public' ? t.errors.serviceDownBodyPublic : t.errors.serviceDownBody}
      </Notice>
    );
  }
  if (error.kind === 'timeout') {
    return (
      <Notice tone="warn" icon={<CircleAlert className="size-4" aria-hidden />} className={className}>
        {fmt(t.errors.timeout, { service })}
      </Notice>
    );
  }
  if (error.code === 'payment_required') {
    return (
      <Notice tone="warn" icon={<CircleAlert className="size-4" aria-hidden />} className={className}>
        {t.errors.paymentRequired}
      </Notice>
    );
  }
  return (
    <Notice tone="danger" icon={<CircleAlert className="size-4" aria-hidden />} className={className}>
      {fmt(t.errors.generic, { message: error.message })}
    </Notice>
  );
}

/** `12.345đ` with the USD equivalent as a tooltip-free secondary line when asked. */
export function Money({
  micros,
  rate,
  locale,
  precise,
  usd,
  className,
  signed,
}: {
  micros: number;
  rate: number;
  locale: Locale;
  precise?: boolean;
  usd?: boolean;
  className?: string;
  signed?: boolean;
}) {
  return (
    <span className={cx('tabular-nums', className)}>
      {formatMicrosVnd(micros, rate, locale, { precise, signed })}
      {usd && <span className="ml-1.5 text-xs text-muted">{formatUsd(micros)}</span>}
    </span>
  );
}

/**
 * The one receipt pattern used everywhere: what ran, on which model/provider,
 * what it cost in đồng, when — plus any product-specific rows.
 */
export function Receipt({
  title,
  rows,
  footer,
  className,
}: {
  title?: ReactNode;
  rows: { label: ReactNode; value: ReactNode; strong?: boolean }[];
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('rounded-xl border border-line bg-surface', className)}>
      {title && (
        <div className="border-b border-dashed border-line px-4 py-3 text-sm font-medium">{title}</div>
      )}
      <dl className="px-4 py-2">
        {rows.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static rows
          <div key={i} className="flex items-baseline justify-between gap-6 py-1.5 text-sm">
            <dt className="shrink-0 text-muted">{r.label}</dt>
            <dd className={cx('min-w-0 text-right break-words', r.strong && 'font-semibold')}>{r.value}</dd>
          </div>
        ))}
      </dl>
      {footer && (
        <div className="border-t border-dashed border-line px-4 py-2.5 text-xs text-muted">{footer}</div>
      )}
    </div>
  );
}

export function CodeBlock({ code, label, className }: { code: string; label?: string; className?: string }) {
  return (
    <div className={cx('relative overflow-hidden rounded-xl border border-line bg-surface-2', className)}>
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="font-mono text-xs text-muted">{label ?? 'bash'}</span>
        <CopyButton value={code} variant="ghost" />
      </div>
      <pre className="overflow-x-auto p-3 text-[0.8125rem] leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * Minimal accessible bar chart (server-rendered SVG, no library). Bars carry
 * <title>s for hover and the whole chart has a text alternative.
 */
export function BarChart({
  data,
  label,
  formatValue,
  formatLabel,
  height = 160,
}: {
  data: { key: string; value: number }[];
  label: string;
  formatValue: (v: number) => string;
  formatLabel: (k: string) => string;
  height?: number;
}) {
  const max = Math.max(...data.map((d) => d.value), 0);
  const n = data.length || 1;
  const gap = n > 40 ? 1 : 2;
  const barW = 100 / n;
  const ticks = data.length > 0 ? [0, Math.floor((n - 1) / 2), n - 1] : [];
  return (
    <figure className="w-full">
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="block h-40 w-full"
      >
        <line
          x1="0"
          x2="100"
          y1={height - 0.5}
          y2={height - 0.5}
          className="stroke-line"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
        {data.map((d, i) => {
          const h = max > 0 ? Math.max(d.value > 0 ? 2 : 0, (d.value / max) * (height - 8)) : 0;
          return (
            <rect
              key={d.key}
              x={i * barW + (gap / 10) * barW * 0.5}
              width={Math.max(0.2, barW - (gap / 10) * barW)}
              y={height - h}
              height={h}
              rx="0.4"
              className="fill-accent/80 hover:fill-accent"
            >
              <title>{`${formatLabel(d.key)}: ${formatValue(d.value)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="mt-1.5 flex justify-between text-xs text-muted tabular-nums" aria-hidden>
        {ticks.map((i) => (
          <span key={i}>{data[i] ? formatLabel(data[i].key) : ''}</span>
        ))}
      </div>
      <figcaption className="sr-only">
        {data.map((d) => `${formatLabel(d.key)}: ${formatValue(d.value)}`).join('; ')}
      </figcaption>
    </figure>
  );
}

/** Horizontal share bars (spend by product, by model…). */
export function ShareBars({
  rows,
}: {
  rows: { key: string; label: ReactNode; value: number; display: ReactNode; sub?: ReactNode }[];
}) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="shrink-0 font-medium tabular-nums">{r.display}</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${max > 0 ? Math.max(r.value > 0 ? 2 : 0, (r.value / max) * 100) : 0}%` }}
            />
          </div>
          {r.sub && <div className="mt-1 text-xs text-muted">{r.sub}</div>}
        </li>
      ))}
    </ul>
  );
}

export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Badge tone={tone} dot>
      {children}
    </Badge>
  );
}
