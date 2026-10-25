/**
 * Lookalike detection helpers: Unicode confusable "skeletons" (UTS #39 inspired, curated subset
 * for Latin lookalikes) and Damerau–Levenshtein distance.
 */

/** Non-Latin characters that render like Latin letters. */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  ӏ: 'l',
  һ: 'h',
  ɡ: 'g',
  ү: 'y',
  ꙇ: 'i',
  ь: 'b',
  // Greek
  α: 'a',
  β: 'b',
  ε: 'e',
  η: 'n',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ω: 'w',
  ϲ: 'c',
  γ: 'y',
  // Latin lookalikes / IPA
  ı: 'i',
  ȷ: 'j',
  ł: 'l',
  ƚ: 'l',
  ɩ: 'i',
  ɑ: 'a',
  ɒ: 'a',
  ɢ: 'g',
  ʜ: 'h',
  ɪ: 'i',
  ʟ: 'l',
  ɴ: 'n',
  ᴏ: 'o',
  ʀ: 'r',
  ꜱ: 's',
  ᴜ: 'u',
  ᴠ: 'v',
  ᴡ: 'w',
  ʏ: 'y',
  ᴢ: 'z',
  ð: 'd',
  þ: 'p',
  ø: 'o',
  œ: 'oe',
  æ: 'ae',
  ß: 'ss',
};

const DIGIT_LOOKALIKE: Record<string, string> = {
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '5': 's',
  '8': 'b',
  '9': 'g',
  '4': 'a',
};

/**
 * Collapse a string to its visual skeleton so `vietcоmbank` (Cyrillic о), `vietcornbank`
 * (rn→m), `vietc0mbank` (zero) and `vietcombank` compare equal.
 */
export function skeleton(input: string): string {
  let s = '';
  for (const ch of input.normalize('NFKC').toLowerCase()) {
    const mapped = CONFUSABLES[ch];
    if (mapped) {
      s += mapped;
      continue;
    }
    // Strip diacritics (Vietnamese ạ, ư, đ… and accented Latin).
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '').replace('đ', 'd');
    s += DIGIT_LOOKALIKE[base] ?? base;
  }
  return s
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/[il|]/g, 'l')
    .replace(/[^a-z0-9]/g, '');
}

export type Script = 'latin' | 'cyrillic' | 'greek' | 'armenian' | 'cjk' | 'other';

export function scriptOf(ch: string): Script | null {
  const c = ch.codePointAt(0)!;
  if (/[0-9\-_.]/.test(ch)) return null;
  if (
    (c >= 0x41 && c <= 0x5a) ||
    (c >= 0x61 && c <= 0x7a) ||
    (c >= 0xc0 && c <= 0x24f) ||
    (c >= 0x1e00 && c <= 0x1eff)
  )
    return 'latin';
  if (c >= 0x400 && c <= 0x52f) return 'cyrillic';
  if (c >= 0x370 && c <= 0x3ff) return 'greek';
  if (c >= 0x530 && c <= 0x58f) return 'armenian';
  if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af))
    return 'cjk';
  return 'other';
}

/** Scripts used by letters in a label (digits and hyphens ignored). */
export function scriptsIn(label: string): Set<Script> {
  const set = new Set<Script>();
  for (const ch of label) {
    const sc = scriptOf(ch);
    if (sc) set.add(sc);
  }
  return set;
}

/** Optimal-string-alignment Damerau–Levenshtein distance (adjacent transpositions count as 1). */
export function editDistance(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length;
  const m = b.length;
  let prev2 = new Array<number>(m + 1).fill(0);
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = new Array<number>(m + 1).fill(0);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m]!;
}

/** Allowed typo distance for a keyword of this length (short names would collide with real words). */
export function typoBudget(len: number): number {
  if (len >= 9) return 2;
  if (len >= 6) return 1;
  return 0;
}

/**
 * Real words / brands that sit within typo distance of protected names and must not be flagged
 * as lookalikes on their own (e.g. "finance" vs "binance", "apply" vs "apple").
 */
export const LOOKALIKE_SAFE_WORDS = new Set([
  'finance',
  'apply',
  'goggle',
  'googly',
  'shopper',
  'shoppe',
  'viettell',
  'tiktak',
  'paypa',
  'facebox',
  'agribusiness',
  'micro',
  'outlook',
  'youtuber',
  'vinaphones',
  'techcom',
  'vietcom',
  'vietin',
  'lazadas',
]);

/**
 * Find a window of `haystack` within `budget` edits of `needle` (both already skeletonized).
 * With `anchorStart`, only windows starting at index 0 are considered (used for short names, so
 * "mbank" inside "vietcombank" is not read as a typo of "mbbank").
 * Returns the best distance, or null if none fits.
 */
export function fuzzyContains(
  haystack: string,
  needle: string,
  budget: number,
  opts: { anchorStart?: boolean } = {},
): { distance: number; match: string; index: number } | null {
  if (budget <= 0) return null;
  let best: { distance: number; match: string; index: number } | null = null;
  for (let len = needle.length - budget; len <= needle.length + budget; len++) {
    if (len <= 0 || len > haystack.length) continue;
    const lastStart = opts.anchorStart ? 0 : haystack.length - len;
    for (let i = 0; i <= lastStart; i++) {
      const win = haystack.slice(i, i + len);
      const d = editDistance(win, needle, budget);
      if (d <= budget && (!best || d < best.distance)) best = { distance: d, match: win, index: i };
      if (best?.distance === 0) return best;
    }
  }
  return best;
}
