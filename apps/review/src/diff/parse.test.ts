import { describe, expect, it } from 'vitest';
import { cQuoteUnescape, parseGitHeaderPaths, parseUnifiedDiff } from './parse';

const MODIFY = `diff --git a/src/app.ts b/src/app.ts
index 83db48f..bf269f4 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,6 @@ import x
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 function f() {
   return a + b;
 }
@@ -20,4 +21,3 @@ function g() {
 line20
-line21
-line22
+line21b
 line23
`;

describe('parseUnifiedDiff', () => {
  it('parses a modified file with multiple hunks and line numbers', () => {
    const [f, ...rest] = parseUnifiedDiff(MODIFY);
    expect(rest).toHaveLength(0);
    expect(f).toMatchObject({
      path: 'src/app.ts',
      oldPath: 'src/app.ts',
      newPath: 'src/app.ts',
      status: 'modified',
      additions: 3,
      deletions: 3,
    });
    expect(f!.hunks).toHaveLength(2);
    const [h1, h2] = f!.hunks;
    expect(h1).toMatchObject({ oldStart: 1, oldLines: 5, newStart: 1, newLines: 6, section: 'import x' });
    expect(h1!.lines.map((l) => [l.type, l.oldLine, l.newLine])).toEqual([
      ['context', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['context', 3, 4],
      ['context', 4, 5],
      ['context', 5, 6],
    ]);
    expect(h2!.lines.map((l) => [l.type, l.oldLine, l.newLine, l.content])).toEqual([
      ['context', 20, 21, 'line20'],
      ['del', 21, null, 'line21'],
      ['del', 22, null, 'line22'],
      ['add', null, 22, 'line21b'],
      ['context', 23, 23, 'line23'],
    ]);
  });

  it('parses added and deleted files', () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+export const y = 2;
diff --git a/old.ts b/old.ts
deleted file mode 100644
index e69de29..0000000
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-also gone
`;
    const [added, deleted] = parseUnifiedDiff(diff);
    expect(added).toMatchObject({
      status: 'added',
      oldPath: null,
      newPath: 'new.ts',
      path: 'new.ts',
      additions: 2,
      newMode: '100644',
    });
    expect(added!.hunks[0]!.lines.map((l) => l.newLine)).toEqual([1, 2]);
    expect(deleted).toMatchObject({
      status: 'deleted',
      oldPath: 'old.ts',
      newPath: null,
      path: 'old.ts',
      deletions: 2,
    });
    expect(deleted!.hunks[0]!.lines.map((l) => l.oldLine)).toEqual([1, 2]);
  });

  it('parses pure renames and renames with edits', () => {
    const diff = `diff --git a/lib/a.ts b/lib/b.ts
similarity index 100%
rename from lib/a.ts
rename to lib/b.ts
diff --git a/src/x.ts b/src/y.ts
similarity index 88%
rename from src/x.ts
rename to src/y.ts
index 1111111..2222222 100644
--- a/src/x.ts
+++ b/src/y.ts
@@ -3,3 +3,3 @@
 keep
-old
+new
 keep2
`;
    const [pure, edited] = parseUnifiedDiff(diff);
    expect(pure).toMatchObject({
      status: 'renamed',
      oldPath: 'lib/a.ts',
      newPath: 'lib/b.ts',
      similarity: 100,
      hunks: [],
    });
    expect(edited).toMatchObject({
      status: 'renamed',
      oldPath: 'src/x.ts',
      newPath: 'src/y.ts',
      path: 'src/y.ts',
      similarity: 88,
      additions: 1,
      deletions: 1,
    });
  });

  it('handles "\\ No newline at end of file" on both sides', () => {
    const diff = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 one
-two
\\ No newline at end of file
+two!
\\ No newline at end of file
`;
    const [f] = parseUnifiedDiff(diff);
    const lines = f!.hunks[0]!.lines;
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatchObject({ type: 'del', content: 'two', noNewlineAtEof: true });
    expect(lines[2]).toMatchObject({ type: 'add', content: 'two!', newLine: 2, noNewlineAtEof: true });
  });

  it('does not mistake content lines that look like headers for file boundaries', () => {
    const diff = `diff --git a/q.sql b/q.sql
--- a/q.sql
+++ b/q.sql
@@ -1,3 +1,3 @@
--- a comment that starts with dashes
+++ plus plus content
 SELECT 1;
-diff --git looks like a header
+@@ not a hunk @@
diff --git a/z.ts b/z.ts
--- a/z.ts
+++ b/z.ts
@@ -1 +1 @@
-a
+b
`;
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(['q.sql', 'z.ts']);
    expect(files[0]!.hunks[0]!.lines.map((l) => [l.type, l.content])).toEqual([
      ['del', '-- a comment that starts with dashes'],
      ['add', '++ plus plus content'],
      ['context', 'SELECT 1;'],
      ['del', 'diff --git looks like a header'],
      ['add', '@@ not a hunk @@'],
    ]);
    // `@@ -1 +1 @@` omits counts, which default to 1.
    expect(files[1]!.hunks[0]).toMatchObject({ oldLines: 1, newLines: 1 });
  });

  it('parses binary files, mode changes and quoted/space paths', () => {
    const diff = `diff --git a/img/logo.png b/img/logo.png
new file mode 100644
index 0000000..abcdef0
Binary files /dev/null and b/img/logo.png differ
diff --git a/bin/run b/bin/run
old mode 100644
new mode 100755
diff --git a/docs/my file.md b/docs/my file.md
--- a/docs/my file.md\t
+++ b/docs/my file.md\t
@@ -1 +1 @@
-x
+y
diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"
--- "a/caf\\303\\251.txt"
+++ "b/caf\\303\\251.txt"
@@ -1 +1 @@
-a
+b
`;
    const [bin, mode, spaced, quoted] = parseUnifiedDiff(diff);
    expect(bin).toMatchObject({ path: 'img/logo.png', binary: true, status: 'added', hunks: [] });
    expect(mode).toMatchObject({
      path: 'bin/run',
      status: 'modified',
      oldMode: '100644',
      newMode: '100755',
      hunks: [],
    });
    expect(spaced).toMatchObject({ path: 'docs/my file.md', status: 'modified' });
    expect(quoted).toMatchObject({ path: 'café.txt', status: 'modified' });
  });

  it('skips GIT binary patch payloads and parses plain diff -u output', () => {
    const diff = `diff --git a/a.bin b/a.bin
index 1..2 100644
GIT binary patch
literal 10
zcmV+--- not a header

literal 0
HcmV?d00001

--- a.txt\t2024-01-01 00:00:00.000000000 +0000
+++ a.txt\t2024-01-02 00:00:00.000000000 +0000
@@ -1 +1,2 @@
 x
+y
`;
    const files = parseUnifiedDiff(diff);
    expect(files[0]).toMatchObject({ path: 'a.bin', binary: true });
    // The plain diff after a binary patch is only reachable via a new `diff --git`; it is skipped.
    expect(files).toHaveLength(1);
    const plain = parseUnifiedDiff(diff.slice(diff.indexOf('--- a.txt')));
    expect(plain[0]).toMatchObject({ path: 'a.txt', status: 'modified', additions: 1 });
  });

  it('tolerates CRLF, empty context lines and empty input', () => {
    const diff =
      'diff --git a/w.txt b/w.txt\r\n--- a/w.txt\r\n+++ b/w.txt\r\n@@ -1,3 +1,3 @@\r\n a\r\n\r\n-b\r\n+c\r\n';
    const [f] = parseUnifiedDiff(diff);
    expect(f!.hunks[0]!.lines.map((l) => [l.type, l.content, l.newLine])).toEqual([
      ['context', 'a', 1],
      ['context', '', 2],
      ['del', 'b', null],
      ['add', 'c', 3],
    ]);
    expect(parseUnifiedDiff('')).toEqual([]);
  });

  it('stops a truncated hunk instead of swallowing the next file', () => {
    const diff = `diff --git a/a b/a
--- a/a
+++ b/a
@@ -1,5 +1,5 @@
 one
diff --git a/b b/b
--- a/b
+++ b/b
@@ -1 +1 @@
-x
+y
`;
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(['a', 'b']);
    expect(files[1]!.additions).toBe(1);
  });
});

describe('path helpers', () => {
  it('splits git header paths with spaces and quotes', () => {
    expect(parseGitHeaderPaths('a/x y.ts b/x y.ts')).toEqual({ oldPath: 'a/x y.ts', newPath: 'b/x y.ts' });
    expect(parseGitHeaderPaths('a/old.ts b/new.ts')).toEqual({ oldPath: 'a/old.ts', newPath: 'b/new.ts' });
    expect(parseGitHeaderPaths('"a/t\\tab" "b/t\\tab"')).toEqual({ oldPath: 'a/t\tab', newPath: 'b/t\tab' });
  });
  it('unescapes C-quoted names', () => {
    expect(cQuoteUnescape('caf\\303\\251 \\"q\\" \\\\')).toBe('café "q" \\');
  });
});
