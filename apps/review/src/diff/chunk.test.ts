import { describe, expect, it } from 'vitest';
import { buildBatches, buildFileMap, renderFileForReview } from './chunk';
import { parseUnifiedDiff } from './parse';

const content = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');
const DIFF = `diff --git a/f.ts b/f.ts
--- a/f.ts
+++ b/f.ts
@@ -10,3 +10,3 @@ fn
 line 10
-old 11
+line 11
 line 12
@@ -16,3 +16,3 @@
 line 16
-old 17
+line 17
 line 18
@@ -50,2 +50,2 @@
-old 50
+line 50
 line 51
`;
const file = parseUnifiedDiff(DIFF)[0]!;

describe('renderFileForReview', () => {
  it('shows hunks with line numbers and merges surrounding context windows', () => {
    const out = renderFileForReview({ file, hunks: file.hunks, content }, 3);
    const lines = out.split('\n');
    expect(lines[0]).toBe('=== FILE: f.ts (modified, +3 -3) ===');
    expect(out).toContain('11 + line 11');
    expect(out).toContain('   - old 11');
    expect(out).toContain(' 7 · line 7'); // context before first hunk
    expect(out).toContain('13 · line 13');
    // Windows of hunk 1 (7..15) and hunk 2 (13..21) overlap → no gap marker between them.
    const between = out.slice(out.indexOf('11 + line 11'), out.indexOf('17 + line 17'));
    expect(between).not.toContain('⋮');
    // Lines are never printed twice.
    expect(lines.filter((l) => l.includes('line 14'))).toHaveLength(1);
    // Gap before the far-away third hunk.
    expect(out.slice(out.indexOf('17 + line 17'), out.indexOf('50 + line 50'))).toContain('⋮');
    expect(out).toContain('54 · line 54');
    expect(out).not.toContain('55 · line 55');
  });

  it('renders hunks only when the file content is unavailable', () => {
    const out = renderFileForReview({ file, hunks: file.hunks, content: null }, 3);
    expect(out).not.toContain('·');
    expect(out).toContain('@@ -16,3 +16,3 @@');
  });
});

describe('buildBatches', () => {
  const mk = (path: string, n: number) => {
    const body = Array.from({ length: n }, (_, i) => `+added ${i} ${'x'.repeat(40)}`).join('\n');
    return parseUnifiedDiff(`--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${n} @@\n${body}\n`)[0]!;
  };

  it('packs files into batches under the char budget, in order', () => {
    const files = [mk('a.ts', 10), mk('b.ts', 10), mk('c.ts', 10)];
    const { batches, overflow } = buildBatches(
      files.map((f) => ({ file: f, hunks: f.hunks })),
      { maxBatchChars: 1300, contextLines: 0, maxBatches: 10 },
    );
    expect(batches.map((b) => b.files.map((f) => f.path))).toEqual([['a.ts', 'b.ts'], ['c.ts']]);
    expect(batches.every((b) => b.chars <= 1300)).toBe(true);
    expect(overflow).toEqual([]);
  });

  it('splits an oversized file by hunks and reports overflow past maxBatches', () => {
    const multi = parseUnifiedDiff(
      `--- a/m.ts\n+++ b/m.ts\n${Array.from({ length: 4 }, (_, k) => `@@ -${k * 100 + 1},1 +${k * 100 + 1},1 @@\n-o\n+${'y'.repeat(300)}`).join('\n')}\n`,
    )[0]!;
    const { batches } = buildBatches([{ file: multi, hunks: multi.hunks }], {
      maxBatchChars: 800,
      contextLines: 0,
      maxBatches: 10,
    });
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((b) => b.files.flatMap((f) => f.hunks)).length).toBe(4);

    const { batches: capped, overflow } = buildBatches(
      [mk('a.ts', 10), mk('b.ts', 10), mk('c.ts', 10)].map((f) => ({ file: f, hunks: f.hunks })),
      { maxBatchChars: 700, contextLines: 0, maxBatches: 2 },
    );
    expect(capped).toHaveLength(2);
    expect(overflow.map((u) => u.file.path)).toEqual(['c.ts']);
  });
});

describe('buildFileMap', () => {
  it('lists nearby files first, marks changed files and caps entries', () => {
    const map = buildFileMap(['src/auth/a.ts', 'src/auth/b.ts', 'docs/x.md', 'z/y.ts'], ['src/auth/a.ts'], 3);
    expect(map).toContain('* src/auth/a.ts');
    expect(map).toContain('  src/auth/b.ts');
    expect(map).toContain('… and 1 more files');
    expect(buildFileMap([], ['a'])).toBe('');
  });
});
