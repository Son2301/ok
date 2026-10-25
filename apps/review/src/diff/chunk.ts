import type { RiskAssessment } from './prioritize';
import type { DiffFile, DiffHunk } from './types';

export interface ReviewUnit {
  /** The file as it appears in the full PR diff (used for anchoring). */
  file: DiffFile;
  /** Hunks to show the reviewer (all hunks, or only those touched by new commits). */
  hunks: DiffHunk[];
  /** Full content of the new file at the head commit, when available. */
  content?: string | null;
  risk?: RiskAssessment;
}

export interface BatchFile {
  path: string;
  hunks: DiffHunk[];
  rendered: string;
}

export interface Batch {
  id: string;
  files: BatchFile[];
  chars: number;
}

export interface ChunkOptions {
  /** Approximate prompt budget per reviewer call, in characters (~4 chars/token). */
  maxBatchChars: number;
  /** Lines of surrounding code (outside the diff) shown around each hunk. */
  contextLines: number;
  /** Hard cap on the number of batches (LLM calls) per review. */
  maxBatches: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxBatchChars: 48_000,
  contextLines: 10,
  maxBatches: 12,
};

const MAX_LINE_CHARS = 400;

export function splitLines(content: string): string[] {
  const lines = content.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const clip = (s: string) => (s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS)}…` : s);

/** First RIGHT-side line a hunk occupies, and its last (equal to newStart for pure deletions). */
function hunkSpan(h: DiffHunk): { first: number; last: number } {
  const first = h.newLines > 0 ? h.newStart : h.newStart + 1;
  return { first, last: first + h.newLines - 1 };
}

/**
 * Render one file for the reviewer: hunks with RIGHT-side line numbers plus
 * `contextLines` of surrounding code from the full new file (marked `·`, not
 * commentable). Overlapping context windows are merged; gaps are shown as `⋮`.
 *
 *   41 + added line
 *   42   unchanged line inside the diff
 *      - deleted line (no new line number)
 *   43 · surrounding code outside the diff
 */
export function renderFileForReview(unit: ReviewUnit, contextLines: number): string {
  const { file } = unit;
  const hunks = [...unit.hunks].sort((a, b) => a.newStart - b.newStart);
  const content = unit.content != null ? splitLines(unit.content) : null;
  const total = content?.length ?? 0;
  const maxLineNo = Math.max(total, ...hunks.map((h) => h.newStart + h.newLines));
  const width = String(maxLineNo).length;
  const num = (n: number | null) => (n === null ? ''.padStart(width) : String(n).padStart(width));
  const out: string[] = [];

  const renamed = file.status === 'renamed' && file.oldPath ? `, renamed from ${file.oldPath}` : '';
  out.push(`=== FILE: ${file.path} (${file.status}${renamed}, +${file.additions} -${file.deletions}) ===`);

  let cursor = 0; // last RIGHT-side line already printed
  const emitContext = (from: number, to: number) => {
    if (!content) return;
    for (let n = Math.max(from, 1); n <= Math.min(to, total); n++)
      out.push(`${num(n)} · ${clip(content[n - 1] ?? '')}`);
  };

  hunks.forEach((h, idx) => {
    const { first, last } = hunkSpan(h);
    const from = Math.max(cursor + 1, first - contextLines, 1);
    if (cursor > 0 && from > cursor + 1) out.push(`${''.padStart(width)} ⋮`);
    else if (cursor === 0 && from > 1 && content) out.push(`${''.padStart(width)} ⋮`);
    emitContext(from, first - 1);
    out.push(
      `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section ? ` ${h.section}` : ''}`,
    );
    for (const l of h.lines) {
      const marker = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      out.push(
        `${num(l.newLine)} ${marker} ${clip(l.content)}${l.noNewlineAtEof ? '  ⟨no newline at EOF⟩' : ''}`,
      );
    }
    cursor = Math.max(cursor, last);
    const next = hunks[idx + 1];
    const nextFirst = next ? hunkSpan(next).first : Number.POSITIVE_INFINITY;
    const to = Math.min(cursor + contextLines, nextFirst - 1);
    emitContext(cursor + 1, to);
    if (content) cursor = Math.max(cursor, Math.min(to, total));
  });
  if (content && cursor < total && hunks.length) out.push(`${''.padStart(width)} ⋮`);
  return out.join('\n');
}

/**
 * Pack files into LLM-sized batches in the given (priority) order. A file whose
 * rendering alone exceeds the budget is split by hunks; a single oversized hunk
 * is truncated. Units that do not fit in `maxBatches` are returned as overflow.
 */
export function buildBatches(
  units: ReviewUnit[],
  opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): { batches: Batch[]; overflow: ReviewUnit[] } {
  const parts: BatchFile[] = [];
  const partOwner: ReviewUnit[] = [];
  for (const unit of units) {
    if (!unit.hunks.length) continue;
    for (const part of splitUnit(unit, opts)) {
      parts.push(part);
      partOwner.push(unit);
    }
  }

  const batches: Batch[] = [];
  const overflow = new Set<ReviewUnit>();
  let current: Batch | null = null;
  parts.forEach((part, i) => {
    const owner = partOwner[i]!;
    const size = part.rendered.length + 2;
    if (!current || (current.chars + size > opts.maxBatchChars && current.files.length > 0)) {
      if (batches.length >= opts.maxBatches) {
        overflow.add(owner);
        return;
      }
      current = { id: `B${batches.length + 1}`, files: [], chars: 0 };
      batches.push(current);
    }
    current.files.push(part);
    current.chars += size;
  });
  return { batches, overflow: [...overflow] };
}

function splitUnit(unit: ReviewUnit, opts: ChunkOptions): BatchFile[] {
  const whole = renderFileForReview(unit, opts.contextLines);
  if (whole.length <= opts.maxBatchChars)
    return [{ path: unit.file.path, hunks: unit.hunks, rendered: whole }];

  const parts: BatchFile[] = [];
  let group: DiffHunk[] = [];
  const flush = () => {
    if (!group.length) return;
    const rendered = renderFileForReview({ ...unit, hunks: group }, opts.contextLines);
    parts.push({ path: unit.file.path, hunks: group, rendered: truncate(rendered, opts.maxBatchChars) });
    group = [];
  };
  for (const h of unit.hunks) {
    const candidate = [...group, h];
    const size = renderFileForReview({ ...unit, hunks: candidate }, opts.contextLines).length;
    if (size > opts.maxBatchChars && group.length) flush();
    group.push(h);
  }
  flush();
  return parts;
}

function truncate(rendered: string, max: number): string {
  if (rendered.length <= max) return rendered;
  const lines = rendered.split('\n');
  const out: string[] = [];
  let size = 0;
  for (const l of lines) {
    if (size + l.length + 1 > max - 80) break;
    out.push(l);
    size += l.length + 1;
  }
  out.push(`… (${lines.length - out.length} more lines truncated to fit the review budget)`);
  return out.join('\n');
}

/**
 * A compact repository map for orientation: paths near the changed files first,
 * changed files marked with `*`, capped at `maxEntries`.
 */
export function buildFileMap(allPaths: string[], changed: string[], maxEntries = 300): string {
  if (!allPaths.length) return '';
  const changedSet = new Set(changed);
  const changedDirs = changed.map((p) => p.split('/').slice(0, -1));
  const affinity = (path: string) => {
    const segs = path.split('/').slice(0, -1);
    let best = 0;
    for (const dir of changedDirs) {
      let n = 0;
      while (n < dir.length && n < segs.length && dir[n] === segs[n]) n++;
      if (n > best) best = n;
    }
    return changedSet.has(path) ? 1000 : best;
  };
  const ranked = [...new Set(allPaths)]
    .map((p) => ({ p, a: affinity(p) }))
    .sort((x, y) => y.a - x.a || x.p.localeCompare(y.p));
  const shown = ranked.slice(0, maxEntries).sort((x, y) => x.p.localeCompare(y.p));
  const lines = shown.map(({ p }) => `${changedSet.has(p) ? '*' : ' '} ${p}`);
  if (ranked.length > shown.length) lines.push(`  … and ${ranked.length - shown.length} more files`);
  return lines.join('\n');
}
