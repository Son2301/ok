import { splitLines } from '../diff/chunk';
import { hunkContaining, hunkNewRange, newLinesFromDiff } from '../diff/lines';
import type { DiffFile, DiffHunk } from '../diff/types';

/**
 * Numbered excerpt of the new file around [from, to] with diff markers, used to
 * give the Critic the exact code behind a claim. Deleted lines are shown in place.
 */
export function renderExcerpt(
  file: DiffFile | undefined,
  content: string | null | undefined,
  from: number,
  to: number,
): string {
  const lines = content != null ? splitLines(content) : null;
  const types = new Map<number, 'add' | 'context'>();
  const deletedBefore = new Map<number, string[]>();
  const trailingDeletes: string[] = [];
  if (file) {
    for (const h of file.hunks) {
      let pending: string[] = [];
      for (const l of h.lines) {
        if (l.type === 'del') pending.push(l.content);
        else if (l.newLine !== null) {
          types.set(l.newLine, l.type === 'add' ? 'add' : 'context');
          if (pending.length) {
            deletedBefore.set(l.newLine, [...(deletedBefore.get(l.newLine) ?? []), ...pending]);
            pending = [];
          }
        }
      }
      if (pending.length) {
        // For a pure-deletion hunk (`+N,0`) newStart is the line *before* the deletion.
        const after = h.newLines > 0 ? h.newStart + h.newLines : h.newStart + 1;
        if (lines && after <= lines.length)
          deletedBefore.set(after, [...(deletedBefore.get(after) ?? []), ...pending]);
        else trailingDeletes.push(...pending);
      }
    }
  }
  const diffText = file ? newLinesFromDiff(file) : new Map<number, string>();
  const last = lines ? Math.min(to, lines.length) : to;
  const width = String(last).length;
  const out: string[] = [];
  let gap = false;
  for (let n = Math.max(1, from); n <= last; n++) {
    const text = lines ? lines[n - 1] : diffText.get(n);
    for (const d of deletedBefore.get(n) ?? []) out.push(`${''.padStart(width)} - ${d}`);
    if (text === undefined) {
      if (!gap) out.push(`${''.padStart(width)} ⋮`);
      gap = true;
      continue;
    }
    gap = false;
    const t = types.get(n);
    out.push(`${String(n).padStart(width)} ${t === 'add' ? '+' : t === 'context' ? ' ' : '·'} ${text}`);
  }
  if (lines && last >= lines.length)
    for (const d of trailingDeletes) out.push(`${''.padStart(width)} - ${d}`);
  return out.join('\n');
}

/** The hunk containing `line`, or the nearest one. */
export function nearestHunk(file: DiffFile, line: number): DiffHunk | undefined {
  const inside = hunkContaining(file, line);
  if (inside) return inside;
  let best: { h: DiffHunk; d: number } | undefined;
  for (const h of file.hunks) {
    const r = hunkNewRange(h) ?? [h.newStart, h.newStart];
    const d = line < r[0] ? r[0] - line : line - r[1];
    if (!best || d < best.d) best = { h, d };
  }
  return best?.h;
}

export function renderHunk(h: DiffHunk, maxLines = 120): string {
  const out = [
    `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.section ? ` ${h.section}` : ''}`,
  ];
  const width = String(h.newStart + h.newLines).length;
  for (const l of h.lines.slice(0, maxLines)) {
    const marker = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
    out.push(`${(l.newLine === null ? '' : String(l.newLine)).padStart(width)} ${marker} ${l.content}`);
  }
  if (h.lines.length > maxLines) out.push(`… (${h.lines.length - maxLines} more lines)`);
  return out.join('\n');
}

/** Text of RIGHT-side lines [line..endLine] from the full file, falling back to the diff. */
export function codeLinesAt(
  file: DiffFile | undefined,
  content: string | null | undefined,
  line: number,
  endLine?: number | null,
): string[] {
  const end = endLine && endLine > line ? endLine : line;
  if (content != null) {
    const lines = splitLines(content);
    return lines.slice(line - 1, end);
  }
  if (!file) return [];
  const map = newLinesFromDiff(file);
  const out: string[] = [];
  for (let n = line; n <= end; n++) {
    const t = map.get(n);
    if (t !== undefined) out.push(t);
  }
  return out;
}
