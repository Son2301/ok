import Link from 'next/link';
import { cx } from '@/lib/cx';

/**
 * 明 (minh) is written with the sun 日 and the moon 月: "bright, clear". The mark
 * is a sun and a crescent moon side by side.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cx('size-7 shrink-0', className)}>
      <rect width="32" height="32" rx="8" className="fill-accent" />
      <circle cx="11" cy="16" r="5" className="fill-accent-fg" />
      <circle cx="21.5" cy="16" r="6" className="fill-accent-fg" />
      <circle cx="24.5" cy="13.5" r="5.25" className="fill-accent" />
    </svg>
  );
}

export function Logo({ brand, href = '/', className }: { brand: string; href?: string; className?: string }) {
  return (
    <Link
      href={href}
      className={cx('flex items-center gap-2 rounded-md font-semibold tracking-tight', className)}
    >
      <LogoMark />
      <span className="text-[1.05rem] whitespace-nowrap">{brand}</span>
    </Link>
  );
}
