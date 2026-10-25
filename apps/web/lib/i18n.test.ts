import { describe, expect, it } from 'vitest';
import { dictionaries, fmt, getDictionary, isLocale, plural } from './i18n';

type Tree = { [k: string]: unknown };

function leaves(obj: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Tree)) {
      for (const [lk, lv] of leaves(v, prefix ? `${prefix}.${k}` : k)) out.set(lk, lv);
    }
  } else {
    out.set(prefix, obj);
  }
  return out;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('dictionaries', () => {
  const vi = leaves(dictionaries.vi);
  const en = leaves(dictionaries.en);

  it('have exactly the same keys', () => {
    expect([...en.keys()].sort()).toEqual([...vi.keys()].sort());
  });

  it('use the same placeholders in both languages', () => {
    for (const [key, v] of vi) {
      if (typeof v !== 'string') continue;
      expect({ key, p: placeholders(en.get(key) as string) }).toEqual({ key, p: placeholders(v) });
    }
  });

  it('have no empty strings except deliberate blanks', () => {
    const allowedEmpty = /templates\.blank\.(name|role|jd)$|stop_reason\.final$/;
    for (const [key, v] of [...vi, ...en]) {
      if (typeof v === 'string' && !allowedEmpty.test(key))
        expect({ key, empty: v.trim() === '' }).toEqual({ key, empty: false });
    }
  });

  it('never call a low scam-check result "safe"', () => {
    const { headline, headlineMedia } = dictionaries.vi.safe;
    for (const text of [...Object.values(headline), ...Object.values(headlineMedia)]) {
      expect(text.toLowerCase()).not.toMatch(/an toàn/);
    }
    for (const text of [
      ...Object.values(dictionaries.en.safe.headline),
      ...Object.values(dictionaries.en.safe.headlineMedia),
    ]) {
      expect(text.toLowerCase()).not.toMatch(/\bsafe\b/);
    }
  });

  it('address the reader as "bạn", not "quý khách"', () => {
    for (const [, v] of vi) if (typeof v === 'string') expect(v.toLowerCase()).not.toContain('quý khách');
  });
});

describe('fmt / plural', () => {
  it('fills placeholders and leaves unknown ones visible', () => {
    expect(fmt('Đủ dùng khoảng {n} ngày', { n: 4 })).toBe('Đủ dùng khoảng 4 ngày');
    expect(fmt('{a} và {b}', { a: 'x' })).toBe('x và {b}');
  });

  it('picks English plural forms', () => {
    expect(plural(1, { one: '{n} key', other: '{n} keys' })).toBe('1 key');
    expect(plural(3, { one: '{n} key', other: '{n} keys' })).toBe('3 keys');
  });

  it('validates locales and falls back to Vietnamese', () => {
    expect(isLocale('en')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(getDictionary('vi').common.signIn).toBe('Đăng nhập');
  });
});
