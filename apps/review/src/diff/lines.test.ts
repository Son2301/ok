import { describe, expect, it } from 'vitest';
import {
  addedLines,
  anchorToDiff,
  commentableLines,
  mapOldLineToNew,
  touchedNewLines,
  trackRange,
} from './lines';
import { parseUnifiedDiff } from './parse';

// Two hunks: new lines 10..16 and 40..43.
const DIFF = `diff --git a/s.ts b/s.ts
--- a/s.ts
+++ b/s.ts
@@ -10,6 +10,7 @@
 c10
 c11
-d12
+a12
+a13
 c14
 c15
 c16
@@ -40,5 +41,3 @@
 c41
-d41
-d42
-d43
+a42
 c43
`;
const file = parseUnifiedDiff(DIFF)[0]!;

describe('commentable lines', () => {
  it('contains exactly the added and context RIGHT-side lines inside hunks', () => {
    expect([...commentableLines(file)].sort((a, b) => a - b)).toEqual([
      10, 11, 12, 13, 14, 15, 16, 41, 42, 43,
    ]);
    expect([...addedLines(file)]).toEqual([12, 13, 42]);
  });
});

describe('anchorToDiff', () => {
  it('keeps commentable lines and multi-line ranges inside one hunk', () => {
    expect(anchorToDiff(file, 12)).toEqual({
      line: 12,
      endLine: undefined,
      moved: false,
      rangeChanged: false,
    });
    expect(anchorToDiff(file, 12, 14)).toEqual({ line: 12, endLine: 14, moved: false, rangeChanged: false });
  });
  it('clamps a range that spills past the hunk end and swaps reversed ranges', () => {
    expect(anchorToDiff(file, 15, 30)).toMatchObject({
      line: 15,
      endLine: 16,
      moved: false,
      rangeChanged: true,
    });
    expect(anchorToDiff(file, 14, 12)).toMatchObject({ line: 12, endLine: 14, rangeChanged: false });
  });
  it('moves a nearby non-commentable line to the closest hunk line', () => {
    expect(anchorToDiff(file, 18)).toMatchObject({ line: 16, moved: true });
    expect(anchorToDiff(file, 38)).toMatchObject({ line: 41, moved: true });
  });
  it('returns null when no hunk is within tolerance or input is invalid', () => {
    expect(anchorToDiff(file, 28)).toBeNull();
    expect(anchorToDiff(file, 0)).toBeNull();
    expect(anchorToDiff(file, 2.5)).toBeNull();
    expect(anchorToDiff({ ...file, hunks: [] }, 12)).toBeNull();
  });
});

describe('mapOldLineToNew / trackRange', () => {
  it('maps lines before, inside and after hunks', () => {
    expect(mapOldLineToNew(file, 5)).toBe(5);
    expect(mapOldLineToNew(file, 11)).toBe(11);
    expect(mapOldLineToNew(file, 12)).toBeNull(); // deleted
    expect(mapOldLineToNew(file, 13)).toBe(14);
    expect(mapOldLineToNew(file, 30)).toBe(31); // +1 after first hunk
    expect(mapOldLineToNew(file, 42)).toBeNull();
    expect(mapOldLineToNew(file, 44)).toBe(43);
    expect(mapOldLineToNew(file, 100)).toBe(99); // +1 -2
  });
  it('handles pure insertion and pure deletion hunks', () => {
    const ins = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -5,0 +6,2 @@\n+n1\n+n2\n')[0]!;
    expect(mapOldLineToNew(ins, 5)).toBe(5);
    expect(mapOldLineToNew(ins, 6)).toBe(8);
    const del = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -5,2 +4,0 @@\n-o5\n-o6\n')[0]!;
    expect(mapOldLineToNew(del, 4)).toBe(4);
    expect(mapOldLineToNew(del, 5)).toBeNull();
    expect(mapOldLineToNew(del, 7)).toBe(5);
  });
  it('reports a range as changed when a line inside it changed or lines were inserted', () => {
    expect(trackRange(file, 30, 32)).toEqual({ changed: false, line: 31, endLine: 33 });
    expect(trackRange(file, 11, 13)).toEqual({ changed: true });
    const ins = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -5,0 +6,1 @@\n+mid\n')[0]!;
    expect(trackRange(ins, 4, 7)).toEqual({ changed: true });
  });
});

describe('touchedNewLines', () => {
  it('includes added lines and the neighbour of pure deletions', () => {
    const d = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,4 +1,3 @@\n c1\n-gone\n c3\n c4\n')[0]!;
    expect([...touchedNewLines(d)]).toEqual([2]);
    expect([...touchedNewLines(file)].sort((a, b) => a - b)).toEqual([12, 13, 42]);
  });
});
