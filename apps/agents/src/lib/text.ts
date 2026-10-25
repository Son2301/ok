/**
 * Text utilities for the knowledge base: Vietnamese-aware normalisation,
 * token estimation, chunking and plain-text extraction.
 */

/** Lowercase and strip diacritics (`Đổi trả` → `doi tra`) so "không dấu" queries match. */
export function normalizeVi(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

/**
 * Rough token estimate (no tokenizer dependency): ~4 chars/token for ASCII,
 * non-ASCII characters (Vietnamese diacritics, CJK) count double.
 */
export function estimateTokens(s: string): number {
  if (!s) return 0;
  let nonAscii = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) nonAscii++;
  return Math.ceil((s.length + nonAscii) / 4);
}

export interface TextChunk {
  ordinal: number;
  content: string;
  tokens: number;
}

export interface ChunkOptions {
  /** Target maximum tokens per chunk. */
  maxTokens?: number;
  /** Tokens repeated from the end of the previous chunk. */
  overlapTokens?: number;
}

const HEADING_RE = /^#{1,6}\s+\S/;

/** Split a block that is too large into sentences, then hard slices at word boundaries. */
function splitLarge(block: string, maxTokens: number): string[] {
  if (estimateTokens(block) <= maxTokens) return [block];
  const sentences = block.split(/(?<=[.!?…。])\s+|\n+/).filter((s) => s.trim());
  const out: string[] = [];
  for (const sentence of sentences) {
    if (estimateTokens(sentence) <= maxTokens) {
      out.push(sentence);
      continue;
    }
    // Hard split by words.
    let cur = '';
    for (const word of sentence.split(/\s+/)) {
      const next = cur ? `${cur} ${word}` : word;
      if (estimateTokens(next) > maxTokens && cur) {
        out.push(cur);
        cur = word;
      } else {
        cur = next;
      }
      // A single "word" longer than the limit (e.g. a base64 blob): slice it.
      while (estimateTokens(cur) > maxTokens) {
        const cut = Math.max(1, Math.floor(cur.length / 2));
        out.push(cur.slice(0, cut));
        cur = cur.slice(cut);
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Tail of `text` worth about `tokens` tokens, starting at a word boundary. */
function tailOf(text: string, tokens: number): string {
  if (tokens <= 0) return '';
  if (estimateTokens(text) <= tokens) return text;
  const approxChars = tokens * 4;
  let tail = text.slice(-approxChars);
  const space = tail.search(/\s/);
  if (space > 0 && space < tail.length / 2) tail = tail.slice(space + 1);
  while (estimateTokens(tail) > tokens && tail.length > 1) tail = tail.slice(Math.ceil(tail.length * 0.1));
  return tail;
}

/**
 * Split text into ~`maxTokens` chunks along paragraph/sentence boundaries,
 * repeating ~`overlapTokens` from the previous chunk. Markdown headings are
 * carried into chunks that start mid-section so each chunk keeps its context.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): TextChunk[] {
  const maxTokens = opts.maxTokens ?? 800;
  const overlapTokens = Math.min(opts.overlapTokens ?? 100, Math.floor(maxTokens / 2));
  const clean = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (!clean) return [];

  // Units: paragraphs (split further if large), each tagged with the heading in effect.
  const units: { text: string; heading: string | null }[] = [];
  let heading: string | null = null;
  for (const para of clean.split(/\n{2,}/)) {
    const p = para.trim();
    if (!p) continue;
    const firstLine = p.split('\n', 1)[0]!;
    if (HEADING_RE.test(firstLine)) heading = firstLine.trim();
    for (const piece of splitLarge(p, maxTokens - overlapTokens)) units.push({ text: piece, heading });
  }

  const chunks: TextChunk[] = [];
  let parts: string[] = [];
  let partsHeading: string | null = null;
  const flush = () => {
    if (!parts.length) return;
    let content = parts.join('\n\n');
    if (partsHeading && !content.startsWith(partsHeading)) content = `${partsHeading}\n${content}`;
    chunks.push({ ordinal: chunks.length, content, tokens: estimateTokens(content) });
  };

  for (const unit of units) {
    const candidate = [...parts, unit.text].join('\n\n');
    const headingCost =
      unit.heading && !candidate.startsWith(unit.heading) ? estimateTokens(unit.heading) + 1 : 0;
    if (parts.length && estimateTokens(candidate) + headingCost > maxTokens) {
      const prev = parts.join('\n\n');
      flush();
      const overlap = tailOf(prev, overlapTokens);
      parts = overlap && overlap !== unit.text ? [overlap, unit.text] : [unit.text];
      partsHeading = unit.heading;
      if (estimateTokens(parts.join('\n\n')) > maxTokens) parts = [unit.text];
    } else {
      if (!parts.length) partsHeading = unit.heading;
      parts.push(unit.text);
    }
  }
  flush();
  return chunks;
}

// ---------------------------------------------------------------- extraction

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1]?.toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Plain text from HTML: drops scripts/styles, keeps block structure as newlines. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(
        /<\/(p|div|section|article|header|footer|li|ul|ol|table|tr|h[1-6]|blockquote|pre)\s*>/gi,
        '\n\n',
      )
      .replace(/<(td|th)\b[^>]*>/gi, ' | ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** RFC 4180-style CSV parser (quotes, escaped quotes, newlines inside quotes). */
export function parseCsv(input: string, delimiter?: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.split('\n', 1)[0] ?? '';
  const delim =
    delimiter ??
    ([',', ';', '\t'] as const).reduce(
      (best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best),
      ',',
    );
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') inQuotes = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/** CSV → one line per row, `header: value; header: value`, which searches and reads well. */
export function csvToText(csv: string): string {
  const rows = parseCsv(csv);
  if (!rows.length) return '';
  const [header, ...body] = rows;
  if (!body.length) return header!.join(', ');
  return body
    .map((r) =>
      header!
        .map((h, i) => (r[i]?.trim() ? `${h.trim() || `col${i + 1}`}: ${r[i]!.trim()}` : ''))
        .filter(Boolean)
        .join('; '),
    )
    .filter(Boolean)
    .join('\n');
}

export type SupportedKind = 'text' | 'markdown' | 'csv' | 'html';

export function detectKind(filename?: string | null, mimeType?: string | null): SupportedKind | null {
  const ext = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const mime = mimeType?.toLowerCase().split(';')[0]?.trim();
  if (ext === 'md' || ext === 'markdown' || mime === 'text/markdown') return 'markdown';
  if (ext === 'csv' || mime === 'text/csv') return 'csv';
  if (ext === 'html' || ext === 'htm' || mime === 'text/html') return 'html';
  if (ext === 'txt' || mime === 'text/plain' || (!ext && (!mime || mime.startsWith('text/')))) return 'text';
  return null;
}

/** Extract indexable plain text from an uploaded text-like document. */
export function extractText(content: string, kind: SupportedKind): string {
  switch (kind) {
    case 'html':
      return htmlToText(content);
    case 'csv':
      return csvToText(content);
    default:
      return content.replace(/^﻿/, '');
  }
}

/** Truncate for display/LLM context with a visible marker. */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}
