import Link from 'next/link';
import { cx } from '@/lib/cx';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cx('size-7 shrink-0', className)}>
      <rect width="32" height="32" rx="8" className="fill-accent" />
      <circle cx="13" cy="16" r="6.25" fill="none" strokeWidth="3" className="stroke-accent-fg" />
      <path
        d="M21.5 10v12M21.5 16.5l4.5-6.5M22.5 15.5l4 6.5"
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-accent-fg"
      />
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
