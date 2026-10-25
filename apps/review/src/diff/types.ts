export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';
export type LineType = 'add' | 'del' | 'context';

export interface DiffLine {
  type: LineType;
  content: string;
  /** Line number in the old (LEFT) file, null for added lines. */
  oldLine: number | null;
  /** Line number in the new (RIGHT) file, null for deleted lines. */
  newLine: number | null;
  /** Set when the diff says `\ No newline at end of file` right after this line. */
  noNewlineAtEof?: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second `@@` (usually the enclosing function/section). */
  section: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** Path before the change; null when the file was added. */
  oldPath: string | null;
  /** Path after the change; null when the file was deleted. */
  newPath: string | null;
  /** `newPath ?? oldPath` — the path comments are anchored to. */
  path: string;
  status: FileStatus;
  binary: boolean;
  /** Rename/copy similarity in percent, when git reports it. */
  similarity: number | null;
  oldMode: string | null;
  newMode: string | null;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}
