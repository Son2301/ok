import { sha256Hex } from '../util';

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'to',
  'for',
  'is',
  'are',
  'and',
  'or',
  'with',
  'when',
  'may',
  'can',
  'could',
  'be',
  'not',
  'no',
  'via',
  'by',
  'from',
  'at',
  'as',
  'it',
  'its',
  'this',
  'that',
  'without',
  'possible',
  'potential',
  'missing',
  'của',
  'trong',
  'khi',
  'và',
  'là',
  'có',
  'không',
  'được',
  'bị',
  'cho',
  'với',
]);

/** Lowercase, strip punctuation/backticks, collapse whitespace (Unicode-aware for Vietnamese). */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function titleTokens(title: string): Set<string> {
  return new Set(
    normalizeTitle(title)
      .split(' ')
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

/** Jaccard similarity of the meaningful words of two titles (0..1). */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (!ta.size || !tb.size) return normalizeTitle(a) === normalizeTitle(b) ? 1 : 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Hash of the commented code, whitespace-insensitive, so re-indentation does not change it. */
export function snippetHash(lines: readonly string[]): string {
  return sha256Hex(lines.map((l) => l.trim().replace(/\s+/g, ' ')).join('\n')).slice(0, 16);
}

/** Stable identity of a finding across reviews: path + normalised title + code snippet hash. */
export function fingerprint(path: string, title: string, snippet: string): string {
  return sha256Hex(`${path}\n${normalizeTitle(title)}\n${snippet}`).slice(0, 32);
}

export interface FingerprintRef {
  fingerprint: string;
  path: string;
  snippetHash: string;
  title: string;
}

/**
 * Same issue as a previously recorded one? Exact fingerprint, or the same code on
 * the same path with a similarly worded title (LLM phrasing varies run to run).
 */
export function matchesRef(f: FingerprintRef, refs: readonly FingerprintRef[]): FingerprintRef | undefined {
  return refs.find(
    (r) =>
      r.fingerprint === f.fingerprint ||
      (r.path === f.path && r.snippetHash === f.snippetHash && titleSimilarity(r.title, f.title) >= 0.5),
  );
}
