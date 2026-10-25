import type { DiffFile, DiffHunk, DiffLine, FileStatus } from './types';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

interface Building {
  oldPath: string | null;
  newPath: string | null;
  explicitStatus: FileStatus | null;
  binary: boolean;
  similarity: number | null;
  oldMode: string | null;
  newMode: string | null;
  hunks: DiffHunk[];
  /** `---`/`+++` already consumed for this file. */
  headerDone: boolean;
  /** Paths came from a `diff --git a/… b/…` header (so `---`/`+++` paths carry a/ b/ prefixes). */
  prefixed: boolean;
}

/**
 * Parse a unified diff (as produced by `git diff`, GitHub's `application/vnd.github.diff`
 * media type, or plain `diff -u`) into files and hunks with old/new line numbers.
 *
 * Hunk bodies are consumed by the line counts in the `@@` header rather than by
 * prefix sniffing, so content lines such as `--- comment` (a deleted SQL comment)
 * or `+++` inside a hunk are never mistaken for file headers.
 */
export function parseUnifiedDiff(input: string): DiffFile[] {
  const lines = input.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const files: DiffFile[] = [];
  let cur: Building | null = null;
  /** Skip everything until the next `diff --git` (binary patches, combined diffs). */
  let skipping = false;

  const flush = () => {
    if (cur) files.push(finalize(cur));
    cur = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith('diff --git ')) {
      flush();
      skipping = false;
      const { oldPath, newPath } = parseGitHeaderPaths(line.slice('diff --git '.length));
      const prefixed = (oldPath?.startsWith('a/') ?? false) && (newPath?.startsWith('b/') ?? false);
      cur = newBuilding(
        prefixed ? oldPath!.slice(2) : oldPath,
        prefixed ? newPath!.slice(2) : newPath,
        prefixed,
      );
      i++;
      continue;
    }
    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      flush();
      skipping = true;
      i++;
      continue;
    }
    if (skipping) {
      i++;
      continue;
    }

    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const building: Building | null = cur;
      if (!building || building.headerDone || building.hunks.length > 0) {
        // Plain `diff -u` output (no `diff --git` line) or several files concatenated.
        flush();
        cur = newBuilding(null, null, false);
      }
      const target = cur as Building;
      const rawOld = parsePathToken(line.slice(4));
      const rawNew = parsePathToken(lines[i + 1]!.slice(4));
      const stripOld =
        target.prefixed || (rawOld?.startsWith('a/') && (rawNew === null || rawNew.startsWith('b/')));
      const stripNew =
        target.prefixed || (rawNew?.startsWith('b/') && (rawOld === null || rawOld.startsWith('a/')));
      target.oldPath =
        rawOld === null ? null : stripOld && rawOld.startsWith('a/') ? rawOld.slice(2) : rawOld;
      target.newPath =
        rawNew === null ? null : stripNew && rawNew.startsWith('b/') ? rawNew.slice(2) : rawNew;
      target.headerDone = true;
      i += 2;
      continue;
    }

    const hunkMatch = HUNK_RE.exec(line);
    if (hunkMatch) {
      if (!cur) cur = newBuilding(null, null, false);
      const hunk: DiffHunk = {
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        section: hunkMatch[5]?.trim() ?? '',
        lines: [],
      };
      (cur as Building).hunks.push(hunk);
      i = consumeHunk(lines, i + 1, hunk);
      continue;
    }

    if (cur)
      applyHeaderLine(cur, line, () => {
        skipping = true;
      });
    i++;
  }
  flush();
  return files;
}

function newBuilding(oldPath: string | null, newPath: string | null, prefixed: boolean): Building {
  return {
    oldPath,
    newPath,
    explicitStatus: null,
    binary: false,
    similarity: null,
    oldMode: null,
    newMode: null,
    hunks: [],
    headerDone: false,
    prefixed,
  };
}

/** Consume hunk body lines starting at `start`; returns the index of the first line after the hunk. */
function consumeHunk(lines: string[], start: number, hunk: DiffHunk): number {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  let oldRemaining = hunk.oldLines;
  let newRemaining = hunk.newLines;
  let i = start;
  const markNoNewline = () => {
    const last = hunk.lines[hunk.lines.length - 1];
    if (last) last.noNewlineAtEof = true;
  };
  while (i < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
    const l = lines[i]!;
    const c = l[0];
    let entry: DiffLine | null = null;
    if (c === '\\') {
      markNoNewline();
      i++;
      continue;
    }
    if (c === '+' && newRemaining > 0) {
      entry = { type: 'add', content: l.slice(1), oldLine: null, newLine: newNo++ };
      newRemaining--;
    } else if (c === '-' && oldRemaining > 0) {
      entry = { type: 'del', content: l.slice(1), oldLine: oldNo++, newLine: null };
      oldRemaining--;
    } else if ((c === ' ' || l === '') && oldRemaining > 0 && newRemaining > 0) {
      // Some tools strip the single space of empty context lines.
      entry = { type: 'context', content: l.slice(1), oldLine: oldNo++, newLine: newNo++ };
      oldRemaining--;
      newRemaining--;
    } else {
      break; // Malformed or truncated hunk: stop here rather than swallowing the next file.
    }
    hunk.lines.push(entry);
    i++;
  }
  // `\ No newline at end of file` may follow the last counted line.
  while (i < lines.length && lines[i]!.startsWith('\\ ')) {
    markNoNewline();
    i++;
  }
  return i;
}

function applyHeaderLine(f: Building, line: string, startSkipping: () => void) {
  if (line.startsWith('new file mode ')) {
    f.explicitStatus = 'added';
    f.newMode = line.slice('new file mode '.length).trim();
    f.oldPath = null;
  } else if (line.startsWith('deleted file mode ')) {
    f.explicitStatus = 'deleted';
    f.oldMode = line.slice('deleted file mode '.length).trim();
    f.newPath = null;
  } else if (line.startsWith('old mode ')) {
    f.oldMode = line.slice('old mode '.length).trim();
  } else if (line.startsWith('new mode ')) {
    f.newMode = line.slice('new mode '.length).trim();
  } else if (line.startsWith('similarity index ') || line.startsWith('dissimilarity index ')) {
    const n = Number.parseInt(line.replace(/^(dis)?similarity index /, ''), 10);
    f.similarity = Number.isFinite(n) ? n : null;
  } else if (line.startsWith('rename from ')) {
    f.explicitStatus = 'renamed';
    f.oldPath = parsePathToken(line.slice('rename from '.length), false);
  } else if (line.startsWith('rename to ')) {
    f.explicitStatus = 'renamed';
    f.newPath = parsePathToken(line.slice('rename to '.length), false);
  } else if (line.startsWith('copy from ')) {
    f.explicitStatus = 'copied';
    f.oldPath = parsePathToken(line.slice('copy from '.length), false);
  } else if (line.startsWith('copy to ')) {
    f.explicitStatus = 'copied';
    f.newPath = parsePathToken(line.slice('copy to '.length), false);
  } else if (line.startsWith('Binary files ') && line.endsWith(' differ')) {
    f.binary = true;
    const m = /^Binary files (.+) and (.+) differ$/.exec(line);
    if (m && f.oldPath === null && f.newPath === null) {
      const o = parsePathToken(m[1]!);
      const n = parsePathToken(m[2]!);
      f.oldPath = o?.startsWith('a/') ? o.slice(2) : o;
      f.newPath = n?.startsWith('b/') ? n.slice(2) : n;
    }
  } else if (line === 'GIT binary patch') {
    f.binary = true;
    startSkipping();
  }
}

function finalize(f: Building): DiffFile {
  let status: FileStatus;
  if (f.explicitStatus) status = f.explicitStatus;
  else if (f.oldPath === null && f.newPath !== null) status = 'added';
  else if (f.newPath === null && f.oldPath !== null) status = 'deleted';
  else if (f.oldPath !== null && f.newPath !== null && f.oldPath !== f.newPath) status = 'renamed';
  else status = 'modified';

  if (status === 'added') f.oldPath = null;
  if (status === 'deleted') f.newPath = null;

  let additions = 0;
  let deletions = 0;
  for (const h of f.hunks) {
    for (const l of h.lines) {
      if (l.type === 'add') additions++;
      else if (l.type === 'del') deletions++;
    }
  }
  return {
    oldPath: f.oldPath,
    newPath: f.newPath,
    path: f.newPath ?? f.oldPath ?? '',
    status,
    binary: f.binary,
    similarity: f.similarity,
    oldMode: f.oldMode,
    newMode: f.newMode,
    hunks: f.hunks,
    additions,
    deletions,
  };
}

/**
 * Parse a path from a `---`/`+++`/`rename from` line. Returns null for /dev/null.
 * Git C-quotes names with special characters and appends a TAB to unquoted names
 * containing spaces; plain `diff -u` appends `\t<timestamp>`.
 */
function parsePathToken(raw: string, cutAtTab = true): string | null {
  let s = raw;
  if (s.startsWith('"')) {
    const end = closingQuote(s, 0);
    s = end === -1 ? s.slice(1) : cQuoteUnescape(s.slice(1, end));
  } else if (cutAtTab) {
    const tab = s.indexOf('\t');
    if (tab !== -1) s = s.slice(0, tab);
  }
  return s === '/dev/null' ? null : s;
}

/** Split the remainder of a `diff --git` line into its two (still prefixed) paths. */
export function parseGitHeaderPaths(rest: string): { oldPath: string | null; newPath: string | null } {
  if (rest.startsWith('"')) {
    const end = closingQuote(rest, 0);
    if (end !== -1) {
      const first = cQuoteUnescape(rest.slice(1, end));
      const second = rest.slice(end + 2);
      return { oldPath: first, newPath: second.startsWith('"') ? parsePathToken(second) : second };
    }
  }
  if (rest.endsWith('"')) {
    const start = rest.lastIndexOf(' "');
    if (start !== -1)
      return { oldPath: rest.slice(0, start), newPath: parsePathToken(rest.slice(start + 1)) };
  }
  // Unquoted names may contain spaces: `a/x y b/x y`. When old == new (the common
  // case) the line splits exactly in half.
  if ((rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2;
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (rest[half] === ' ' && a.replace(/^a\//, '') === b.replace(/^b\//, ''))
      return { oldPath: a, newPath: b };
  }
  const idx = rest.indexOf(' b/');
  if (idx !== -1) return { oldPath: rest.slice(0, idx), newPath: rest.slice(idx + 1) };
  const sp = rest.indexOf(' ');
  if (sp !== -1) return { oldPath: rest.slice(0, sp), newPath: rest.slice(sp + 1) };
  return { oldPath: rest, newPath: rest };
}

function closingQuote(s: string, openIdx: number): number {
  for (let i = openIdx + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return i;
  }
  return -1;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '"': '"',
  '\\': '\\',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
};

/** Undo git's C-style quoting, including octal-escaped UTF-8 bytes (`\303\251` → `é`). */
export function cQuoteUnescape(s: string): string {
  const chunks: Buffer[] = [];
  let last = 0;
  const re = /\\([0-7]{3}|.)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) chunks.push(Buffer.from(s.slice(last, m.index), 'utf8'));
    const esc = m[1]!;
    if (/^[0-7]{3}$/.test(esc)) chunks.push(Buffer.from([Number.parseInt(esc, 8) & 0xff]));
    else chunks.push(Buffer.from(SIMPLE_ESCAPES[esc] ?? esc, 'utf8'));
    last = m.index + m[0].length;
  }
  if (last < s.length) chunks.push(Buffer.from(s.slice(last), 'utf8'));
  return Buffer.concat(chunks).toString('utf8');
}
