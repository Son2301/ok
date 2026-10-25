import type { Locale } from '../format';
import { en } from './en';
import { type Dict, vi } from './vi';

export type { Dict, Locale };

export const LOCALES: Locale[] = ['vi', 'en'];
export const DEFAULT_LOCALE: Locale = 'vi';
export const LOCALE_COOKIE = 'lang';

export const dictionaries: Record<Locale, Dict> = { vi, en };

export function isLocale(v: unknown): v is Locale {
  return v === 'vi' || v === 'en';
}

export function getDictionary(locale: Locale): Dict {
  return dictionaries[locale] ?? vi;
}

/**
 * Fill `{name}` placeholders. Unknown placeholders are left visible so a
 * missing variable is noticed in review rather than silently dropped.
 */
export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** English needs plural forms; Vietnamese doesn't. Pass `{ one, other }` with `{n}` placeholders. */
export function plural(
  n: number,
  forms: { one: string; other: string },
  vars: Record<string, string | number> = {},
) {
  return fmt(n === 1 ? forms.one : forms.other, { n, ...vars });
}
