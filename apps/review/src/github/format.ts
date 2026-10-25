import { BRAND } from '@ok/shared';
import { type Language, type RepoConfig, SEVERITY_RANK, type Severity } from '../config';
import { SKIP_REASON_TEXT, type SkippedFile } from '../diff/filter';
import type { Finding } from '../pipeline/types';
import { formatCost, formatDuration, truncate } from '../util';
import type { CheckConclusion, ReviewCommentInput } from './types';

export const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
};

const STRINGS = {
  en: {
    severity: { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' },
    category: {
      correctness: 'Correctness',
      security: 'Security',
      concurrency: 'Concurrency',
      performance: 'Performance',
      api: 'API',
      'error-handling': 'Error handling',
      'data-loss': 'Data loss',
      other: 'Other',
    },
    failureScenario: 'Failure scenario',
    suggestedFix: 'Suggested fix',
    why: 'Why this was flagged',
    verdict: {
      confirmed: 'Confirmed by the Critic',
      plausible: 'Rated plausible by the Critic',
      rejected: 'Rejected by the Critic',
    },
    confidence: 'Reviewer confidence',
    footer: 'two-pass review (Reviewer + Critic)',
    rerun: 'comment `/review` to re-run',
    title: (n: number) => (n === 1 ? '1 issue found' : `${n} issues found`),
    noIssues: 'No verified issues',
    noIssuesRejected: (n: number) =>
      `No verified issues (${n} candidate finding${n === 1 ? '' : 's'} rejected by the Critic).`,
    noIssuesNone: 'No issues found in the changed code.',
    tableSeverity: 'Severity',
    tableCount: 'Count',
    scope: 'Scope',
    scopeFull: 'Full review',
    scopeIncremental: (from: string, to: string) => `Incremental review of \`${from}..${to}\``,
    filesReviewed: (n: number) => `${n} file${n === 1 ? '' : 's'} reviewed`,
    filesSkipped: (n: number) => `${n} skipped`,
    checkedFor: 'Checked for',
    checkedList: 'correctness, security, concurrency, performance, API contracts, error handling, data loss',
    twoPass: 'Two-pass',
    twoPassLine: (c: number, conf: number, pl: number, rej: number) =>
      `${c} candidate${c === 1 ? '' : 's'} from the Reviewer → Critic confirmed ${conf}, plausible ${pl}, rejected ${rej}`,
    general: 'Findings not tied to a commentable line',
    inline: 'Findings',
    inlineFallback: 'Inline comments could not be placed on the diff, so all findings are listed here.',
    digest: (n: number) => `Minor notes (${n})`,
    resolved: (n: number) => `Resolved since the last review (${n})`,
    resolvedNote: 'the flagged code was changed',
    stillOpen: (n: number) => `${n} earlier finding${n === 1 ? ' is' : 's are'} still open (not repeated).`,
    capped: (n: number) => `${n} more finding${n === 1 ? '' : 's'} not shown (comment limits).`,
    skipped: (n: number) => `Files skipped (${n})`,
    file: 'File',
    reason: 'Reason',
    notes: 'Notes',
    configError: (e: string) => `\`.okreview.yml\` is invalid (${e}); defaults were used.`,
    cost: 'cost',
    truncated: '… (summary truncated)',
  },
  vi: {
    severity: { critical: 'Nghiêm trọng', high: 'Cao', medium: 'Trung bình', low: 'Thấp' },
    category: {
      correctness: 'Tính đúng đắn',
      security: 'Bảo mật',
      concurrency: 'Đồng thời',
      performance: 'Hiệu năng',
      api: 'API',
      'error-handling': 'Xử lý lỗi',
      'data-loss': 'Mất dữ liệu',
      other: 'Khác',
    },
    failureScenario: 'Kịch bản lỗi',
    suggestedFix: 'Đề xuất sửa',
    why: 'Vì sao bị gắn cờ',
    verdict: {
      confirmed: 'Critic đã xác nhận',
      plausible: 'Critic đánh giá là có khả năng',
      rejected: 'Critic đã bác bỏ',
    },
    confidence: 'Độ tin cậy của Reviewer',
    footer: 'review hai lượt (Reviewer + Critic)',
    rerun: 'bình luận `/review` để chạy lại',
    title: (n: number) => `Phát hiện ${n} vấn đề`,
    noIssues: 'Không có vấn đề đã xác minh',
    noIssuesRejected: (n: number) =>
      `Không có vấn đề đã xác minh (${n} phát hiện ứng viên bị Critic bác bỏ).`,
    noIssuesNone: 'Không tìm thấy vấn đề trong phần mã thay đổi.',
    tableSeverity: 'Mức độ',
    tableCount: 'Số lượng',
    scope: 'Phạm vi',
    scopeFull: 'Review toàn bộ',
    scopeIncremental: (from: string, to: string) => `Review tăng dần \`${from}..${to}\``,
    filesReviewed: (n: number) => `đã review ${n} tệp`,
    filesSkipped: (n: number) => `bỏ qua ${n}`,
    checkedFor: 'Đã kiểm tra',
    checkedList: 'tính đúng đắn, bảo mật, đồng thời, hiệu năng, hợp đồng API, xử lý lỗi, mất dữ liệu',
    twoPass: 'Hai lượt',
    twoPassLine: (c: number, conf: number, pl: number, rej: number) =>
      `${c} ứng viên từ Reviewer → Critic xác nhận ${conf}, có khả năng ${pl}, bác bỏ ${rej}`,
    general: 'Phát hiện không gắn được vào dòng thay đổi',
    inline: 'Các phát hiện',
    inlineFallback: 'Không thể đặt bình luận vào diff nên tất cả phát hiện được liệt kê ở đây.',
    digest: (n: number) => `Ghi chú nhỏ (${n})`,
    resolved: (n: number) => `Đã được xử lý kể từ lần review trước (${n})`,
    resolvedNote: 'đoạn mã bị gắn cờ đã thay đổi',
    stillOpen: (n: number) => `${n} phát hiện trước đó vẫn còn mở (không lặp lại).`,
    capped: (n: number) => `${n} phát hiện khác không hiển thị (giới hạn bình luận).`,
    skipped: (n: number) => `Tệp bị bỏ qua (${n})`,
    file: 'Tệp',
    reason: 'Lý do',
    notes: 'Ghi chú',
    configError: (e: string) => `\`.okreview.yml\` không hợp lệ (${e}); đã dùng cấu hình mặc định.`,
    cost: 'chi phí',
    truncated: '… (đã rút gọn)',
  },
} as const;

export const strings = (lang: Language) => STRINGS[lang];

const productName = () => `${BRAND.name} ${BRAND.products.review}`;

/** Defuse @mentions (they would notify people/teams) in model-written text. */
export function sanitizeText(s: string): string {
  return s.replace(/(^|[^\w`])@(?=[A-Za-z0-9])/g, '$1@​');
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  mjs: 'js',
  cjs: 'js',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  swift: 'swift',
  scala: 'scala',
  sql: 'sql',
  sh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  tf: 'hcl',
  vue: 'vue',
  svelte: 'svelte',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
};
const langOf = (path: string) => LANG_BY_EXT[path.split('.').pop()?.toLowerCase() ?? ''] ?? '';

const normCode = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();

/**
 * A GitHub ```suggestion block replaces exactly the commented lines, so only use
 * one when the Reviewer's replacement targets exactly the final anchored range
 * (not moved/clamped/corrected), the change is small, and it is not a no-op.
 */
export function canUseSuggestionBlock(f: Finding): boolean {
  if (!f.replacement || !f.anchored || f.moved || f.rangeChanged || f.lineCorrected) return false;
  const span = (f.endLine ?? f.line) - f.line + 1;
  const repl = f.replacement.replace(/\r/g, '').replace(/\n+$/, '');
  if (!repl.trim() || repl.includes('```')) return false;
  if (span > 8 || repl.split('\n').length > 12) return false;
  if (f.codeLines.length !== span) return false;
  return normCode(repl) !== normCode(f.codeLines.join('\n'));
}

export function formatInlineComment(f: Finding, language: Language): string {
  const t = strings(language);
  const parts: string[] = [];
  parts.push(
    `${SEVERITY_EMOJI[f.severity]} **${t.severity[f.severity]} · ${t.category[f.category]}** — ${sanitizeText(f.title)}`,
  );
  parts.push(sanitizeText(f.body));
  parts.push(`**${t.failureScenario}:** ${sanitizeText(f.failureScenario)}`);
  const fix: string[] = [];
  if (f.suggestion) fix.push(`**${t.suggestedFix}:** ${sanitizeText(f.suggestion)}`);
  if (f.replacement?.trim()) {
    const repl = f.replacement.replace(/\r/g, '').replace(/\n+$/, '');
    if (canUseSuggestionBlock(f)) {
      if (!f.suggestion) fix.push(`**${t.suggestedFix}:**`);
      fix.push(`\`\`\`suggestion\n${repl}\n\`\`\``);
    } else if (!repl.includes('```')) {
      if (!f.suggestion) fix.push(`**${t.suggestedFix}:**`);
      fix.push(`\`\`\`${langOf(f.path)}\n${repl}\n\`\`\``);
    }
  }
  if (fix.length) parts.push(fix.join('\n\n'));
  const why = [
    `${t.verdict[f.verdict]}${f.criticReason ? `: ${sanitizeText(f.criticReason)}` : '.'}`,
    `${t.confidence}: ${f.confidence.toFixed(2)}`,
  ];
  parts.push(`<details><summary>${t.why}</summary>\n\n${why.join('\n\n')}\n\n</details>`);
  parts.push(`<sub>${productName()} · ${t.footer} · ${t.rerun}</sub>`);
  return truncate(parts.join('\n\n'), 60_000);
}

/** GitHub review comment payload; multi-line ranges use start_line/line on the RIGHT side. */
export function toReviewComment(f: Finding, language: Language): ReviewCommentInput {
  const body = formatInlineComment(f, language);
  if (f.endLine && f.endLine > f.line)
    return { path: f.path, start_line: f.line, start_side: 'RIGHT', line: f.endLine, side: 'RIGHT', body };
  return { path: f.path, line: f.line, side: 'RIGHT', body };
}

export interface ResolvedRef {
  title: string;
  path: string;
  line: number | null;
}

export interface SummaryInput {
  language: Language;
  mode: 'full' | 'incremental';
  fromSha?: string | null;
  headSha: string;
  findings: Finding[];
  filesReviewed: number;
  skipped: SkippedFile[];
  resolved: ResolvedRef[];
  stillOpen: number;
  durationMs: number;
  costMicros: number;
  models: RepoConfig['models'];
  warnings: string[];
  configError?: string | null;
  /** Inline comments were rejected by GitHub; list posted findings in the body instead. */
  inlineFallback?: boolean;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const loc = (f: { path: string; line: number | null; endLine?: number | null }) =>
  `\`${f.path}${f.line ? `:${f.line}${f.endLine && f.endLine > f.line ? `-${f.endLine}` : ''}` : ''}\``;

function compactFinding(f: Finding, language: Language, detailed = false): string {
  const t = strings(language);
  const head = `- ${SEVERITY_EMOJI[f.severity]} **${sanitizeText(f.title)}** — ${loc(f)}`;
  if (!detailed) return `${head}\n  ${sanitizeText(truncate(f.body, 400))}`;
  return `${head}\n  ${sanitizeText(f.body)}\n  _${t.failureScenario}:_ ${sanitizeText(f.failureScenario)}${
    f.suggestion ? `\n  _${t.suggestedFix}:_ ${sanitizeText(f.suggestion)}` : ''
  }`;
}

export function formatSummary(s: SummaryInput): string {
  const t = strings(s.language);
  const visible = s.findings.filter(
    (f) => f.status === 'posted' || f.status === 'general' || f.status === 'digest',
  );
  const posted = s.findings.filter((f) => f.status === 'posted');
  const general = s.findings.filter((f) => f.status === 'general');
  const digest = s.findings.filter((f) => f.status === 'digest');
  const capped = s.findings.filter((f) => f.status === 'capped').length;
  const verdictCount = (v: Finding['verdict']) => s.findings.filter((f) => f.verdict === v).length;
  const rejected = verdictCount('rejected');
  const out: string[] = [];

  const headline = visible.length ? t.title(visible.length) : t.noIssues;
  out.push(`### ${visible.length ? '🔎' : '✅'} ${productName()} — ${headline}`);

  if (visible.length) {
    const rows = (['critical', 'high', 'medium', 'low'] as const).map(
      (sev) =>
        `| ${SEVERITY_EMOJI[sev]} ${t.severity[sev]} | ${visible.filter((f) => f.severity === sev).length} |`,
    );
    out.push([`| ${t.tableSeverity} | ${t.tableCount} |`, '|---|---:|', ...rows].join('\n'));
  } else {
    out.push(rejected > 0 ? t.noIssuesRejected(rejected) : t.noIssuesNone);
  }

  const scope =
    s.mode === 'incremental' && s.fromSha
      ? t.scopeIncremental(s.fromSha.slice(0, 7), s.headSha.slice(0, 7))
      : t.scopeFull;
  const meta = [
    `**${t.scope}:** ${scope} · ${t.filesReviewed(s.filesReviewed)}${s.skipped.length ? ` · ${t.filesSkipped(s.skipped.length)}` : ''}`,
    `**${t.checkedFor}:** ${t.checkedList}`,
  ];
  if (s.findings.length) {
    meta.push(
      `**${t.twoPass}:** ${t.twoPassLine(s.findings.length, verdictCount('confirmed'), verdictCount('plausible'), rejected)}`,
    );
  }
  out.push(meta.join('  \n'));

  if (s.inlineFallback && posted.length) {
    out.push(
      `#### ${t.inline}\n${t.inlineFallback}\n\n${posted.map((f) => compactFinding(f, s.language, true)).join('\n')}`,
    );
  }
  if (general.length)
    out.push(`#### ${t.general}\n${general.map((f) => compactFinding(f, s.language, true)).join('\n')}`);
  if (digest.length) {
    out.push(
      `<details><summary>${SEVERITY_EMOJI.low} ${t.digest(digest.length)}</summary>\n\n${digest.map((f) => compactFinding(f, s.language)).join('\n')}\n\n</details>`,
    );
  }
  if (s.resolved.length) {
    out.push(
      `#### ✅ ${t.resolved(s.resolved.length)}\n${s.resolved
        .map((r) => `- ~~${sanitizeText(r.title)}~~ — \`${r.path}\` (${t.resolvedNote})`)
        .join('\n')}`,
    );
  }
  const tail: string[] = [];
  if (s.stillOpen) tail.push(t.stillOpen(s.stillOpen));
  if (capped) tail.push(t.capped(capped));
  if (tail.length) out.push(tail.join(' '));

  if (s.skipped.length) {
    const rows = s.skipped
      .slice(0, 50)
      .map((f) => `| \`${cell(f.path)}\` | ${SKIP_REASON_TEXT[f.reason][s.language]} |`);
    if (s.skipped.length > 50) rows.push(`| … | +${s.skipped.length - 50} |`);
    out.push(
      `<details><summary>${t.skipped(s.skipped.length)}</summary>\n\n| ${t.file} | ${t.reason} |\n|---|---|\n${rows.join('\n')}\n\n</details>`,
    );
  }
  const notes = [...(s.configError ? [t.configError(s.configError)] : []), ...s.warnings.slice(0, 5)];
  if (notes.length)
    out.push(`> ⚠️ **${t.notes}:**\n${notes.map((n) => `> - ${sanitizeText(truncate(n, 300))}`).join('\n')}`);

  out.push(
    `<sub>⏱ ${formatDuration(s.durationMs)} · 💰 ${formatCost(s.costMicros)} · models: \`${s.models.reviewer}\` → \`${s.models.critic}\` · ${productName()} · ${t.footer} · ${t.rerun}</sub>`,
  );
  const body = out.join('\n\n');
  return body.length > 60_000 ? `${body.slice(0, 59_000)}\n\n${t.truncated}` : body;
}

export function checkConclusion(findings: Finding[], failOn: RepoConfig['failOn']): CheckConclusion {
  const visible = findings.filter(
    (f) => f.status === 'posted' || f.status === 'general' || f.status === 'digest',
  );
  if (failOn !== 'none' && visible.some((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[failOn]))
    return 'failure';
  return visible.length ? 'neutral' : 'success';
}

export function checkTitle(findings: Finding[], language: Language): string {
  const t = strings(language);
  const visible = findings.filter(
    (f) => f.status === 'posted' || f.status === 'general' || f.status === 'digest',
  );
  if (!visible.length) return t.noIssues;
  const parts = (['critical', 'high', 'medium', 'low'] as const)
    .map((sev) => [sev, visible.filter((f) => f.severity === sev).length] as const)
    .filter(([, n]) => n > 0)
    .map(([sev, n]) => `${n} ${t.severity[sev].toLowerCase()}`);
  return `${t.title(visible.length)} (${parts.join(', ')})`;
}

// ------------------------------------------------------------ standalone comments

export function formatConfigErrorComment(error: string, language: Language): string {
  return language === 'vi'
    ? `⚠️ **${productName()}**: tệp \`.okreview.yml\` không hợp lệ — ${sanitizeText(error)}.\n\nLần review này dùng cấu hình mặc định. Hãy sửa tệp cấu hình (xem tài liệu tham khảo \`.okreview.yml\`).`
    : `⚠️ **${productName()}**: \`.okreview.yml\` is invalid — ${sanitizeText(error)}.\n\nThis review used the default settings. Please fix the file (see the \`.okreview.yml\` reference in the docs).`;
}

export function formatQuotaExceededComment(opts: {
  limit: number;
  linkUrl: string;
  language: Language;
}): string {
  return opts.language === 'vi'
    ? `👋 **${productName()}**: cài đặt GitHub này đã dùng hết ${opts.limit} lượt review miễn phí của tháng. Hãy liên kết cài đặt với tài khoản ${BRAND.name} để tiếp tục: ${opts.linkUrl}`
    : `👋 **${productName()}**: this GitHub installation has used its ${opts.limit} free reviews for this month. Link it to a ${BRAND.name} account to keep getting reviews: ${opts.linkUrl}`;
}

export function formatNotLinkedComment(opts: { linkUrl: string; language: Language }): string {
  return opts.language === 'vi'
    ? `👋 **${productName()}**: cài đặt GitHub này chưa được liên kết với tài khoản ${BRAND.name}. Liên kết tại đây để bật review: ${opts.linkUrl}`
    : `👋 **${productName()}**: this GitHub installation is not linked to a ${BRAND.name} account yet. Link it here to enable reviews: ${opts.linkUrl}`;
}

export function formatInsufficientBalanceComment(opts: { topUpUrl: string; language: Language }): string {
  return opts.language === 'vi'
    ? `💳 **${productName()}**: số dư ví của tổ chức không đủ để chạy review này. Vui lòng nạp thêm tại ${opts.topUpUrl} rồi bình luận \`/review\` để chạy lại.`
    : `💳 **${productName()}**: the organization's wallet balance is too low to run this review. Please top up at ${opts.topUpUrl}, then comment \`/review\` to run it again.`;
}
