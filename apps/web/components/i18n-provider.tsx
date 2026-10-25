'use client';

import { createContext, type ReactNode, useContext } from 'react';
import type { Locale } from '@/lib/format';
import type { Dict } from '@/lib/i18n';

const I18nContext = createContext<{ locale: Locale; t: Dict } | null>(null);

export function I18nProvider({ locale, t, children }: { locale: Locale; t: Dict; children: ReactNode }) {
  return <I18nContext.Provider value={{ locale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}
