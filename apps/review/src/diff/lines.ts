import type { DiffFile, DiffHunk } from './types';

/** First and last RIGHT-side line of a hunk, or null when the hunk only deletes lines. */
export function hunkNewRange(h: DiffHunk): [number, number] | null {
  if (h.newLines <= 0) return null;
  return [h.newStart, h.newStart + h.newLines - 1];
}

/**
 * RIGHT-side lines GitHub accepts for review comments (`side: RIGHT`): every added
 * or context line inside a hunk. Lines outside hunks cannot be commented on.
 */
export function commentableLines(file: DiffFile): Set<number> {
  const set = new Set<number>();
  for (const h of file.hunks) {
    for (const l of h.lines) if (l.newLine !== null) set.add(l.newLine);
  }
  return set;
}

/** Lines added by the change (RIGHT side). */
export function addedLines(file: DiffFile): Set<number> {
  const set = new Set<number>();
  for (const h of file.hunks)
    for (const l of h.lines) if (l.type === 'add' && l.newLine !== null) set.add(l.newLine);
  return set;
}

export function hunkContaining(file: DiffFile, newLine: number): DiffHunk | undefined {
  return file.hunks.find((h) => {
    const r = hunkNewRange(h);
    return r !== null && newLine >= r[0] && newLine <= r[1];
  });
}

export interface Anchor {
  /** First commented line (RIGHT side). */
  line: number;
  /** Last commented line when the comment spans several lines (always > line, same hunk). */
  endLine?: number;
  /** True when the start line had to be moved to reach a commentable line. */
  moved: boolean;
  /** True when the anchored range differs from the requested one (moved or clamped). */
  rangeChanged: boolean;
}

/**
 * Anchor a (possibly multi-line) finding to the diff. The start line must be a
 * commentable RIGHT-side line; if it is not, it moves to the nearest commentable
 * line of the closest hunk, but only when that hunk is within `tolerance` lines.
 * Multi-line ranges are clamped to the start line's hunk (GitHub rejects ranges
 * spanning hunks). Returns null when the finding cannot be anchored.
 */
export function anchorToDiff(
  file: DiffFile,
  line: number,
  endLine?: number | null,
  tolerance = 5,
): Anchor | null {
  if (!Number.isInteger(line) || line < 1) return null;
  let start = line;
  let end = endLine != null && Number.isInteger(endLine) ? endLine : line;
  if (end < start) [start, end] = [end, start];
  const requestedStart = start;
  const requestedEnd = end;

  let hunk = hunkContaining(file, start);
  let moved = false;
  if (!hunk) {
    let best: { h: DiffHunk; dist: number } | null = null;
    for (const h of file.hunks) {
      const r = hunkNewRange(h);
      if (!r) continue;
      const dist = start < r[0] ? r[0] - start : start - r[1];
      if (!best || dist < best.dist) best = { h, dist };
    }
    if (!best || best.dist > tolerance) return null;
    hunk = best.h;
    const r = hunkNewRange(hunk)!;
    const clamped = Math.min(Math.max(start, r[0]), r[1]);
    // Keep the span's length when we only shift it into the hunk.
    end = end + (clamped - start);
    start = clamped;
    moved = true;
  }
  const r = hunkNewRange(hunk)!;
  if (end > r[1]) end = r[1];
  if (end < start) end = start;
  return {
    line: start,
    endLine: end > start ? end : undefined,
    moved,
    rangeChanged: moved || start !== requestedStart || end !== requestedEnd,
  };
}

/**
 * Map a LEFT-side (old) line number through a file diff to its RIGHT-side (new)
 * number. Returns null when that line was deleted or modified by the diff.
 */
export function mapOldLineToNew(file: DiffFile, oldLine: number): number | null {
  let offset = 0;
  for (const h of file.hunks) {
    if (h.oldLines === 0) {
      // Pure insertion after old line `oldStart`.
      if (oldLine > h.oldStart) {
        offset += h.newLines;
        continue;
      }
      break;
    }
    const oldEnd = h.oldStart + h.oldLines - 1;
    if (oldLine < h.oldStart) break;
    if (oldLine > oldEnd) {
      offset += h.newLines - h.oldLines;
      continue;
    }
    for (const l of h.lines) {
      if (l.oldLine === oldLine) return l.type === 'context' ? l.newLine : null;
    }
    return null;
  }
  return oldLine + offset;
}

/**
 * Follow a previously reported range [line, endLine] (old numbering) through a
 * diff. `changed` is true when any line in the range was deleted/modified or when
 * lines were inserted inside it; otherwise the shifted range is returned.
 */
export function trackRange(
  file: DiffFile,
  line: number,
  endLine: number = line,
): { changed: true } | { changed: false; line: number; endLine: number } {
  const mapped: number[] = [];
  for (let n = line; n <= endLine; n++) {
    const m = mapOldLineToNew(file, n);
    if (m === null) return { changed: true };
    mapped.push(m);
  }
  const first = mapped[0]!;
  const last = mapped[mapped.length - 1]!;
  if (last - first !== endLine - line) return { changed: true };
  return { changed: false, line: first, endLine: last };
}

/**
 * RIGHT-side lines touched by a diff: added lines, plus — for pure deletions — the
 * new line right after (or before, at EOF) the deletion point so the spot stays visible.
 */
export function touchedNewLines(file: DiffFile): Set<number> {
  const set = new Set<number>();
  for (const h of file.hunks) {
    let lastNew: number | null = null;
    let pendingDeletion = false;
    for (const l of h.lines) {
      if (l.type === 'add' && l.newLine !== null) {
        set.add(l.newLine);
        pendingDeletion = false;
      } else if (l.type === 'del') {
        pendingDeletion = true;
      } else if (l.newLine !== null) {
        if (pendingDeletion) set.add(l.newLine);
        pendingDeletion = false;
      }
      if (l.newLine !== null) lastNew = l.newLine;
    }
    if (pendingDeletion) set.add(lastNew ?? Math.max(1, h.newStart));
  }
  return set;
}

/** Map of RIGHT-side line number → text, from the diff alone (context + added lines). */
export function newLinesFromDiff(file: DiffFile): Map<number, string> {
  const map = new Map<number, string>();
  for (const h of file.hunks) for (const l of h.lines) if (l.newLine !== null) map.set(l.newLine, l.content);
  return map;
}
