'use client';

import { Check, Copy, Monitor, Moon, Sun } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState, useTransition } from 'react';
import { useFormStatus } from 'react-dom';
import { setLocaleAction } from '@/app/actions';
import { cx } from '@/lib/cx';
import { formatDateTime, formatRelative, type Locale } from '@/lib/format';
import { useI18n } from './i18n-provider';
import { buttonClass } from './ui';

/** Copy-to-clipboard with a visible + announced confirmation. */
export function CopyButton({
  value,
  label,
  className,
  size = 'sm',
  variant = 'secondary',
  iconOnly,
}: {
  value: string;
  label?: string;
  className?: string;
  size?: 'sm' | 'md';
  variant?: 'secondary' | 'ghost' | 'primary' | 'subtle';
  iconOnly?: boolean;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback for non-secure contexts (plain http on a LAN IP).
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  }

  const text = copied ? t.common.copied : (label ?? t.common.copy);
  return (
    <button
      type="button"
      onClick={copy}
      className={buttonClass(variant, size, cx(iconOnly && 'px-2', className))}
      aria-label={iconOnly ? text : undefined}
      title={iconOnly ? text : undefined}
    >
      {copied ? <Check className="size-4 text-ok" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {!iconOnly && <span>{text}</span>}
      <span className="sr-only" aria-live="polite">
        {copied ? t.common.copied : ''}
      </span>
    </button>
  );
}

/** Submit button that shows a pending label while its form's server action runs. */
export function SubmitButton({
  children,
  pendingLabel,
  variant = 'primary',
  size = 'md',
  className,
  disabled,
  name,
  value,
}: {
  children: ReactNode;
  pendingLabel?: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'subtle';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  disabled?: boolean;
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending || disabled}
      aria-disabled={pending || disabled}
      className={buttonClass(variant, size, className)}
    >
      {pending && (
        <span
          aria-hidden
          className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
        />
      )}
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}

const THEMES = ['system', 'light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

/** Cycles system → light → dark. Stored in a cookie so the server renders the right theme (no flash). */
export function ThemeToggle({ initial, className }: { initial: Theme; className?: string }) {
  const { t } = useI18n();
  const [theme, setTheme] = useState<Theme>(initial);
  const next = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;
  const label = { system: t.common.themeSystem, light: t.common.themeLight, dark: t.common.themeDark };
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;

  function apply() {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    // biome-ignore lint/suspicious/noDocumentCookie: tiny preference cookie, no library needed
    document.cookie = `theme=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  }

  return (
    <button
      type="button"
      onClick={apply}
      className={buttonClass('ghost', 'sm', cx('px-2', className))}
      aria-label={`${t.common.theme}: ${label[theme]}`}
      title={`${t.common.theme}: ${label[theme]}`}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

/** VI / EN switch. A server action sets the cookie and the page re-renders in the new language. */
export function LanguageToggle({ className }: { className?: string }) {
  const { locale, t } = useI18n();
  const [pending, start] = useTransition();
  const set = (l: Locale) => start(() => setLocaleAction(l));
  return (
    <div className={className}>
      <fieldset
        className={cx(
          'inline-flex rounded-lg border border-line p-0.5 text-xs font-medium',
          pending && 'opacity-60',
        )}
      >
        <legend className="sr-only">{t.common.language}</legend>
        {(['vi', 'en'] as const).map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => set(l)}
            aria-pressed={locale === l}
            className={cx(
              'rounded-md px-2 py-1 uppercase transition-colors',
              locale === l ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg',
            )}
          >
            {l}
          </button>
        ))}
      </fieldset>
    </div>
  );
}

/** Button that asks for confirmation in an accessible dialog before running `onConfirm`. */
export function ConfirmButton({
  children,
  title,
  body,
  confirmLabel,
  onConfirm,
  variant = 'secondary',
  confirmVariant = 'danger',
  size = 'sm',
  className,
}: {
  children: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel: ReactNode;
  onConfirm: () => void | Promise<void>;
  variant?: 'secondary' | 'ghost' | 'danger' | 'subtle';
  confirmVariant?: 'danger' | 'primary';
  size?: 'sm' | 'md';
  className?: string;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <button
        type="button"
        className={buttonClass(variant, size, className)}
        onClick={() => ref.current?.showModal()}
      >
        {children}
      </button>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click is a mouse convenience; <dialog> closes on Escape natively */}
      <dialog
        ref={ref}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-0 text-fg shadow-pop backdrop:bg-black/40"
        onClick={(e) => {
          if (e.target === ref.current) ref.current?.close();
        }}
      >
        <div className="p-5">
          <h2 className="text-base font-semibold">{title}</h2>
          {body && <div className="mt-2 text-sm text-muted">{body}</div>}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              className={buttonClass('secondary', 'sm')}
              onClick={() => ref.current?.close()}
            >
              {t.common.cancel}
            </button>
            <button
              type="button"
              disabled={pending}
              className={buttonClass(confirmVariant, 'sm')}
              onClick={() =>
                start(async () => {
                  await onConfirm();
                  ref.current?.close();
                })
              }
            >
              {pending && (
                <span
                  aria-hidden
                  className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
                />
              )}
              {confirmLabel}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}

/** Live relative time that refreshes every 30s ("3 phút trước"). */
export function RelativeTime({ date, className }: { date: string | Date; className?: string }) {
  const { locale } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const d = typeof date === 'string' ? new Date(date) : date;
  return (
    <time
      dateTime={d.toISOString()}
      title={formatDateTime(d, locale)}
      className={className}
      suppressHydrationWarning
    >
      {formatRelative(d, locale, now)}
    </time>
  );
}
