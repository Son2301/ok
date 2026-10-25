import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { cx } from '@/lib/cx';

// ------------------------------------------------------------------ buttons

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover shadow-card',
  secondary: 'bg-surface text-fg border border-line-strong hover:bg-surface-2 shadow-card',
  ghost: 'text-fg hover:bg-surface-2',
  subtle: 'bg-surface-2 text-fg hover:bg-surface-3',
  danger: 'bg-danger text-white hover:opacity-90 shadow-card',
};
const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5',
  md: 'h-10 px-4 text-[0.9375rem] gap-2',
  lg: 'h-12 px-5 text-base gap-2',
};

export function buttonClass(variant: Variant = 'primary', size: Size = 'md', extra?: string) {
  return cx(
    'inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap transition-colors',
    'disabled:opacity-55 disabled:cursor-not-allowed select-none',
    VARIANTS[variant],
    SIZES[size],
    extra,
  );
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ComponentProps<'button'> & { variant?: Variant; size?: Size }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}

export function ButtonLink({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}

// -------------------------------------------------------------------- cards

export function Card({ className, children, ...rest }: ComponentProps<'section'>) {
  return (
    <section className={cx('rounded-xl border border-line bg-surface shadow-card', className)} {...rest}>
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <div className={cx('flex flex-wrap items-start justify-between gap-3 px-5 pt-5', className)}>
      <div className="min-w-0">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('p-5', className)}>{children}</div>;
}

// -------------------------------------------------------------------- badges

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'orange' | 'danger' | 'info';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted border-line',
  accent: 'bg-accent-soft text-accent-ink border-transparent',
  ok: 'bg-ok-soft text-ok-ink border-transparent',
  warn: 'bg-warn-soft text-warn-ink border-transparent',
  orange: 'bg-orange-soft text-orange-ink border-transparent',
  danger: 'bg-danger-soft text-danger-ink border-transparent',
  info: 'bg-info-soft text-info-ink border-transparent',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
  title,
  dot,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
  dot?: boolean;
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {dot && <span aria-hidden className="size-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}

// -------------------------------------------------------------------- layout

export function PageHeader({
  title,
  description,
  action,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0 max-w-3xl">
        {eyebrow && <div className="mb-1 text-sm text-muted">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight sm:text-[1.75rem]">{title}</h1>
        {description && <p className="mt-1.5 text-[0.9375rem] text-muted">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
    </header>
  );
}

export function Notice({
  tone = 'info',
  title,
  children,
  icon,
  action,
  className,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cx('flex gap-3 rounded-xl border px-4 py-3 text-sm', TONES[tone], className)}
    >
      {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
      <div className="min-w-0 flex-1">
        {title && <div className="font-medium">{title}</div>}
        {children && <div className={cx(title ? 'mt-0.5' : '', 'opacity-90')}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex flex-col items-center px-6 py-10 text-center', className)}>
      {icon && (
        <div className="mb-3 grid size-11 place-items-center rounded-full bg-surface-2 text-muted">
          {icon}
        </div>
      )}
      <h3 className="font-medium">{title}</h3>
      {children && <div className="mt-1.5 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('skeleton h-4', className)} />;
}

export function Stat({
  label,
  value,
  hint,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('min-w-0', className)}>
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums tracking-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

// --------------------------------------------------------------------- forms

export function Field({
  label,
  htmlFor,
  hint,
  error,
  optionalLabel,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  error?: ReactNode;
  optionalLabel?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
        {optionalLabel && <span className="ml-1 font-normal text-muted">({optionalLabel})</span>}
      </label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------------- tables

export function Table({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <div className={cx('-mx-px overflow-x-auto', className)}>
      <table aria-label={label} className="w-full border-collapse text-sm">
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  className,
  align,
}: {
  children?: ReactNode;
  className?: string;
  align?: 'right';
}) {
  return (
    <th
      scope="col"
      className={cx(
        'border-b border-line px-4 py-2.5 text-left text-xs font-medium tracking-wide text-muted whitespace-nowrap first:pl-5 last:pr-5',
        align === 'right' && 'text-right',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  align,
  colSpan,
}: {
  children?: ReactNode;
  className?: string;
  align?: 'right';
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cx(
        'border-b border-line px-4 py-3 align-top first:pl-5 last:pr-5',
        align === 'right' && 'text-right tabular-nums',
        className,
      )}
    >
      {children}
    </td>
  );
}

// ----------------------------------------------------------------------- misc

export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code className={cx('rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em]', className)}>
      {children}
    </code>
  );
}

export function Dl({
  items,
  className,
}: {
  items: { label: ReactNode; value: ReactNode }[];
  className?: string;
}) {
  return (
    <dl className={cx('divide-y divide-line', className)}>
      {items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static list
        <div key={i} className="grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-[11rem_1fr] sm:gap-4">
          <dt className="text-sm text-muted">{it.label}</dt>
          <dd className="min-w-0 text-sm break-words">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Meter({
  value,
  max,
  tone = 'accent',
  label,
}: {
  value: number;
  max: number;
  tone?: Tone;
  label: string;
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const bar: Record<Tone, string> = {
    neutral: 'bg-faint',
    accent: 'bg-accent',
    ok: 'bg-ok',
    warn: 'bg-warn',
    orange: 'bg-orange',
    danger: 'bg-danger',
    info: 'bg-info',
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: native <meter> can't be themed consistently across browsers; the ARIA role carries the semantics
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className="h-2 w-full overflow-hidden rounded-full bg-surface-3"
    >
      <div className={cx('h-full rounded-full', bar[tone])} style={{ width: `${pct}%` }} />
    </div>
  );
}
