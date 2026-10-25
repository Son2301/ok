import 'server-only';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { DEFAULT_LOCALE, type Dict, getDictionary, isLocale, LOCALE_COOKIE, type Locale } from './index';

/** Vietnamese unless the visitor chose English (cookie set by the language toggle). */
export const getLocale = cache(async (): Promise<Locale> => {
  const v = (await cookies()).get(LOCALE_COOKIE)?.value;
  return isLocale(v) ? v : DEFAULT_LOCALE;
});

export async function getI18n(): Promise<{ locale: Locale; t: Dict }> {
  const locale = await getLocale();
  return { locale, t: getDictionary(locale) };
}

export type Theme = 'light' | 'dark' | 'system';
export const THEME_COOKIE = 'theme';

export async function getTheme(): Promise<Theme> {
  const v = (await cookies()).get(THEME_COOKIE)?.value;
  return v === 'light' || v === 'dark' ? v : 'system';
}
