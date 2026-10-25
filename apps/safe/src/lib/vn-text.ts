/**
 * Vietnamese-aware text normalization for pattern matching.
 *
 * Scam messages arrive with and without diacritics ("tài khoản" / "tai khoan"), in teencode
 * ("ck vào stk", "ko", "j"), with leetspeak ("nh4n qu4", "0TP") and split letters to dodge
 * filters ("T.R.Ú.N.G T.H.Ư.Ở.N.G"). `normalizeForMatch` folds all of these into one canonical
 * lowercase ASCII form while keeping an index map back to the original, so rule hits can quote
 * the exact words the user received.
 */

/** Remove Vietnamese diacritics: "Đường dây nóng" → "Duong day nong". */
export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

/** Simple fold used for comparisons: NFKC, no diacritics, lowercase, single spaces. */
export function fold(s: string): string {
  return stripDiacritics(s.normalize('NFKC'))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Token-level teencode / abbreviation expansions (applied to whole tokens only). */
const TEENCODE: Record<string, string> = {
  ko: 'khong',
  k: 'khong',
  hok: 'khong',
  khog: 'khong',
  kog: 'khong',
  hem: 'khong',
  dc: 'duoc',
  j: 'gi',
  ck: 'chuyen khoan',
  stk: 'so tai khoan',
  tk: 'tai khoan',
  tkhoan: 'tai khoan',
  hh: 'hoa hong',
  sdt: 'so dien thoai',
  dt: 'dien thoai',
  ctv: 'cong tac vien',
  ib: 'nhan tin',
  inbox: 'nhan tin',
  cskh: 'cham soc khach hang',
  vs: 'voi',
  ng: 'nguoi',
  tr: 'trieu',
  lm: 'lam',
  mn: 'moi nguoi',
  bh: 'bao gio',
  dky: 'dang ky',
  dki: 'dang ky',
  fb: 'facebook',
  tele: 'telegram',
  ad: 'admin',
};

/** Leetspeak digits inside words: "nh4n" → "nhan", "0tp" → "otp", "c0ng" → "cong". */
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' };

/** Tokens that are amounts/units and must not be leet-decoded ("500k", "30tr", "4g", "24h"). */
const NUMBER_UNIT = /^\d+([.,]\d+)?(k|tr|trieu|ty|d|vnd|h|g|m|p|ph|usd|usdt|x)?\d*$/;

export interface NormalizedText {
  /** Canonical form: lowercase ASCII letters/digits separated by single spaces. */
  text: string;
  /** `map[i]` = index in `source` of the character that produced `text[i]`. */
  map: number[];
  /** The NFKC-normalized original that `map` points into. */
  source: string;
}

interface Tok {
  text: string;
  map: number[];
}

const isAlnum = (c: string) => /[a-z0-9]/.test(c);
const isLetter = (c: string | undefined) => c !== undefined && /[a-z]/.test(c);
const isDigit = (c: string | undefined) => c !== undefined && /[0-9]/.test(c);

export function normalizeForMatch(input: string): NormalizedText {
  const source = input.normalize('NFKC');

  // 1) Per-character fold (1:1 with source thanks to NFKC + per-char stripping).
  const chars: string[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    let f = stripDiacritics(ch).toLowerCase();
    if (f.length !== 1) f = f.charAt(0) || ' ';
    if (f === '@') f = 'a';
    chars.push(isAlnum(f) ? f : f === '$' ? 's' : sepKind(ch));
  }

  // 2) Join split-letter obfuscation: ≥4 single letters separated by the same separator.
  //    "t.r.u.n.g" / "t r u n g" → "trung".
  const out: { c: string; i: number }[] = [];
  for (let i = 0; i < chars.length; ) {
    const sep = chars[i + 1];
    if (isLetter(chars[i]) && !isAlnum(chars[i - 1] ?? ' ') && sep !== undefined && !isAlnum(sep)) {
      const run = [i];
      let k = i;
      while (chars[k + 1] === sep && isLetter(chars[k + 2]) && !isAlnum(chars[k + 3] ?? ' ')) {
        k += 2;
        run.push(k);
      }
      if (run.length >= 4) {
        for (const idx of run) out.push({ c: chars[idx]!, i: idx });
        i = k + 1;
        continue;
      }
    }
    out.push({ c: chars[i]!, i });
    i++;
  }

  // 3) Tokenize on separators.
  const tokens: Tok[] = [];
  let cur: Tok = { text: '', map: [] };
  for (const { c, i } of out) {
    if (isAlnum(c)) {
      cur.text += c;
      cur.map.push(i);
    } else if (cur.text) {
      tokens.push(cur);
      cur = { text: '', map: [] };
    }
  }
  if (cur.text) tokens.push(cur);

  // 4) Leetspeak + teencode per token.
  const parts: Tok[] = tokens.map((t) => {
    let text = t.text;
    if (/[a-z]/.test(text) && /[0-9]/.test(text) && !NUMBER_UNIT.test(text)) {
      const cs = text.split('');
      for (let k = 0; k < cs.length; k++) {
        const c = cs[k]!;
        if (!LEET[c]) continue;
        const runLen1 = !isDigit(cs[k - 1]) && !isDigit(cs[k + 1]);
        const between = isLetter(cs[k - 1]) && isLetter(cs[k + 1]);
        const leading = k === 0 && cs.slice(1).every((x) => isLetter(x));
        // "qu4", "c0": a short word ending in a vowel-like digit. Longer tokens ("iphone5") are left alone.
        const trailing =
          k === cs.length - 1 &&
          cs.length <= 5 &&
          '043'.includes(c) &&
          cs.slice(0, k).every((x) => isLetter(x));
        if (runLen1 && (between || leading || trailing)) cs[k] = LEET[c]!;
      }
      text = cs.join('');
    }
    const exp = TEENCODE[text];
    if (exp) {
      const first = t.map[0]!;
      const last = t.map[t.map.length - 1]!;
      return { text: exp, map: exp.split('').map((_, idx) => (idx === exp.length - 1 ? last : first)) };
    }
    return { text, map: t.map };
  });

  // 5) Join with single spaces.
  let text = '';
  const map: number[] = [];
  parts.forEach((p, idx) => {
    if (idx > 0) {
      text += ' ';
      map.push(p.map[0]!);
    }
    text += p.text;
    map.push(...p.map);
  });
  return { text, map, source };
}

/** Separator chars that commonly glue split letters together get a stable marker per kind. */
function sepKind(ch: string): string {
  if (ch === ' ' || ch === ' ') return ' ';
  if ('.-_*·•/|+'.includes(ch)) return ch;
  return ' ';
}

/** Recover the original text span for a match in normalized text, expanded to whole words. */
export function originalSpan(n: NormalizedText, start: number, end: number, maxLen = 120): string {
  if (!n.map.length) return '';
  const s = n.map[Math.max(0, Math.min(start, n.map.length - 1))]!;
  const e = n.map[Math.max(0, Math.min(end - 1, n.map.length - 1))]!;
  let a = s;
  let b = e + 1;
  while (a > 0 && /[\p{L}\p{N}]/u.test(n.source[a - 1]!)) a--;
  while (b < n.source.length && /[\p{L}\p{N}]/u.test(n.source[b]!)) b++;
  let span = n.source.slice(a, b).replace(/\s+/g, ' ').trim();
  if (span.length > maxLen) span = `${span.slice(0, maxLen - 1)}…`;
  return span;
}

/**
 * Compile a rule phrase into a regex over normalized text. Spaces become optional (` ?`) so
 * "tai khoan" also matches run-together "taikhoan"; the whole thing is word-bounded.
 */
export function phrase(src: string): RegExp {
  return new RegExp(`(?<![a-z0-9])(?:${src.replace(/ /g, ' ?')})(?![a-z0-9])`, 'g');
}

const NEGATIONS =
  /(?:khong|dung|chua|cam|never|not|dont|do not|khong bao gio|tuyet doi khong|khong duoc|nghiem cam|khong nen|khong can)\s*(?:\S+\s*){0,3}$/;

/** True if the words just before `index` negate the match ("tuyệt đối không cung cấp mã OTP"). */
export function isNegated(normalized: string, index: number): boolean {
  const before = normalized.slice(Math.max(0, index - 32), index);
  return NEGATIONS.test(before);
}
