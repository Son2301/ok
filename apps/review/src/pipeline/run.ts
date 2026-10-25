import { chatJson, type LlmClient, type Usage } from '@ok/llm';
import type { Logger } from '@ok/shared';
import { type RepoConfig, SEVERITY_RANK, type Severity } from '../config';
import { type Batch, buildBatches, type ReviewUnit } from '../diff/chunk';
import { anchorToDiff, commentableLines } from '../diff/lines';
import type { DiffFile } from '../diff/types';
import {
  buildCriticMessages,
  type CriticItem,
  type CriticVerdict,
  criticResponseSchema,
} from '../prompts/critic';
import { buildReviewerMessages, type ReviewerFinding, reviewerResponseSchema } from '../prompts/reviewer';
import { errorMessage, isPaymentError, mapLimit } from '../util';
import { codeLinesAt, nearestHunk, renderExcerpt, renderHunk } from './excerpt';
import { type FingerprintRef, fingerprint, matchesRef, snippetHash, titleSimilarity } from './fingerprint';
import { emptyUsage, type Finding, type UsageTotals, type Verdict } from './types';

export interface PipelineOptions {
  maxBatchChars: number;
  maxBatches: number;
  /** Parallel LLM calls per review. */
  concurrency: number;
  /** Findings per Critic call. */
  criticBatchSize: number;
  /** Lines of code around the cited lines shown to the Critic. */
  criticExcerptLines: number;
  /** How far (in lines) a finding may sit outside a hunk and still be moved into it. */
  anchorTolerance: number;
  maxCandidatesPerBatch: number;
  /** Plausible findings below this Reviewer confidence are dropped. */
  minPlausibleConfidence: number;
  /** Per-severity caps on inline comments (in addition to config.maxComments). */
  severityCaps: Record<Exclude<Severity, 'low'>, number>;
  maxGeneral: number;
  maxDigest: number;
}

export const DEFAULT_PIPELINE_OPTIONS: PipelineOptions = {
  maxBatchChars: 48_000,
  maxBatches: 12,
  concurrency: 3,
  criticBatchSize: 6,
  criticExcerptLines: 15,
  anchorTolerance: 5,
  maxCandidatesPerBatch: 25,
  minPlausibleConfidence: 0.5,
  severityCaps: { critical: 50, high: 10, medium: 6 },
  maxGeneral: 8,
  maxDigest: 10,
};

export interface PipelineInput {
  llm: LlmClient;
  config: RepoConfig;
  /** Files to review, in priority order, with the hunks to show. */
  units: ReviewUnit[];
  /** Every file of the full PR diff, keyed by path — inline comments must anchor here. */
  diffFiles: Map<string, DiffFile>;
  /** Full new-file contents keyed by path (when fetched). */
  contents: Map<string, string>;
  fileMap?: string;
  pr?: { title: string; body?: string | null };
  mode: 'full' | 'incremental';
  /** Findings already posted on this PR and still open — never repost them. */
  previous?: FingerprintRef[];
  /** Findings the team dismissed (reply or 👎) — never raise them again. */
  suppressed?: FingerprintRef[];
  options?: Partial<PipelineOptions>;
  logger?: Logger;
}

export interface PipelineResult {
  findings: Finding[];
  batches: number;
  /** Paths that did not fit into the batch cap and were not reviewed. */
  overflow: string[];
  usage: UsageTotals;
  /** Non-fatal problems (failed batch, unknown path…), surfaced in the summary. */
  warnings: string[];
}

const rank = (f: Pick<Finding, 'severity' | 'verdict' | 'confidence'>) =>
  SEVERITY_RANK[f.severity] * 10 +
  (f.verdict === 'confirmed' ? 2 : f.verdict === 'plausible' ? 1 : 0) +
  f.confidence;

/**
 * Two-pass review:
 *  1. Reviewer (one call per batch of files) proposes candidate findings.
 *  2. Critic (batched) tries to refute each one against the exact code.
 *  3. Deterministic post-filters: verdicts, threshold, anchoring to commentable
 *     lines, dedupe, already-posted/suppressed fingerprints, per-severity caps.
 */
export async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const opts = { ...DEFAULT_PIPELINE_OPTIONS, ...input.options };
  const { config } = input;
  const usage = emptyUsage();
  const warnings: string[] = [];
  const addUsage = (u: Usage) => {
    usage.calls++;
    usage.promptTokens += u.prompt_tokens;
    usage.completionTokens += u.completion_tokens;
    usage.costMicros += u.cost_micros ?? 0;
  };

  const { batches, overflow } = buildBatches(input.units, {
    maxBatchChars: opts.maxBatchChars,
    contextLines: config.limits.contextLines,
    maxBatches: opts.maxBatches,
  });
  if (overflow.length)
    warnings.push(`${overflow.length} file(s) did not fit into the review budget and were not reviewed.`);

  // ---------------------------------------------------------------- pass 1
  type Raw = { batch: Batch; f: ReviewerFinding; path: string };
  const raw: Raw[] = [];
  let failedBatches = 0;
  let lastError: unknown;
  await mapLimit(batches, opts.concurrency, async (batch, idx) => {
    const messages = buildReviewerMessages({
      batch,
      batchIndex: idx,
      batchCount: batches.length,
      language: config.language,
      mode: input.mode,
      instructions: config.instructions,
      fileMap: input.fileMap,
      pr: input.pr,
    });
    try {
      const { data, usage: u } = await chatJson(
        input.llm,
        { model: config.models.reviewer, messages, temperature: 0.2, max_tokens: 6000 },
        reviewerResponseSchema,
      );
      addUsage(u);
      if (data.dropped)
        warnings.push(`Reviewer batch ${batch.id}: ${data.dropped} malformed finding(s) ignored.`);
      for (const f of data.findings.slice(0, opts.maxCandidatesPerBatch)) {
        const path = resolvePath(f.path, batch);
        if (!path) {
          warnings.push(`Reviewer cited a file outside its batch (${f.path}); finding ignored.`);
          continue;
        }
        raw.push({ batch, f, path });
      }
    } catch (err) {
      if (isPaymentError(err)) throw err;
      failedBatches++;
      lastError = err;
      warnings.push(`Reviewer batch ${batch.id} failed: ${errorMessage(err)}`);
      input.logger?.warn('reviewer batch failed', { batch: batch.id, err: errorMessage(err) });
    }
  });
  // Nothing reviewed at all → surface the error so the job can be retried.
  if (batches.length > 0 && failedBatches === batches.length) throw lastError;

  // Deterministic ids regardless of completion order.
  raw.sort(
    (a, b) =>
      a.batch.id.localeCompare(b.batch.id, undefined, { numeric: true }) ||
      a.path.localeCompare(b.path) ||
      a.f.line - b.f.line,
  );
  const findings: Finding[] = raw.map(({ batch, f, path }, i) => ({
    id: `F${i + 1}`,
    batchId: batch.id,
    path,
    line: f.line,
    endLine: f.endLine && f.endLine > f.line ? f.endLine : null,
    originalLine: f.line,
    originalEndLine: f.endLine ?? null,
    severity: f.severity,
    originalSeverity: f.severity,
    category: f.category,
    title: f.title,
    body: f.body,
    failureScenario: f.failureScenario,
    suggestion: f.suggestion ?? null,
    replacement: f.replacement ?? null,
    confidence: f.confidence,
    verdict: 'plausible',
    criticReason: null,
    lineCorrected: false,
    anchored: false,
    moved: false,
    rangeChanged: false,
    status: 'filtered',
    statusReason: null,
    fingerprint: '',
    snippetHash: '',
    codeLines: [],
  }));

  // ---------------------------------------------------------------- pass 2
  const groups: Finding[][] = [];
  for (let i = 0; i < findings.length; i += opts.criticBatchSize)
    groups.push(findings.slice(i, i + opts.criticBatchSize));
  await mapLimit(groups, opts.concurrency, async (group) => {
    const items: CriticItem[] = group.map((f) => toCriticItem(f, input, opts.criticExcerptLines));
    let verdicts = new Map<string, CriticVerdict>();
    let failure: string | null = null;
    try {
      const { data, usage: u } = await chatJson(
        input.llm,
        {
          model: config.models.critic,
          messages: buildCriticMessages(items, config.language),
          temperature: 0,
          max_tokens: 3000,
        },
        criticResponseSchema,
      );
      addUsage(u);
      verdicts = new Map(data.verdicts.map((v) => [v.id, v]));
    } catch (err) {
      if (isPaymentError(err)) throw err;
      failure = errorMessage(err);
      warnings.push(`Critic call failed for ${group.map((f) => f.id).join(', ')}: ${failure}`);
    }
    for (const f of group) applyVerdict(f, verdicts.get(f.id), failure, input.diffFiles.get(f.path));
  });

  // ---------------------------------------------------------------- post-filters
  const threshold = SEVERITY_RANK[config.severityThreshold];
  for (const f of findings) {
    if (f.verdict === 'rejected') {
      f.status = 'rejected';
      continue;
    }
    if (f.verdict === 'plausible' && !config.keepPlausible) {
      f.status = 'filtered';
      f.statusReason = 'plausible findings are disabled (keepPlausible: false)';
      continue;
    }
    if (f.verdict === 'plausible' && f.confidence < opts.minPlausibleConfidence) {
      f.status = 'filtered';
      f.statusReason = `low confidence (${f.confidence.toFixed(2)}) and not confirmed by the Critic`;
      continue;
    }
    if (SEVERITY_RANK[f.severity] < threshold) {
      f.status = 'filtered';
      f.statusReason = `below severityThreshold (${config.severityThreshold})`;
      continue;
    }
    f.status = 'posted'; // provisional; placement decided below
  }

  // Anchor + fingerprint every finding (rejected ones too, for transparency).
  for (const f of findings) {
    const file = input.diffFiles.get(f.path);
    const anchor = file ? anchorToDiff(file, f.line, f.endLine, opts.anchorTolerance) : null;
    if (anchor) {
      f.anchored = true;
      f.moved = anchor.moved;
      f.rangeChanged = f.rangeChanged || anchor.rangeChanged;
      f.line = anchor.line;
      f.endLine = anchor.endLine ?? null;
    }
    f.codeLines = codeLinesAt(file, input.contents.get(f.path), f.line, f.endLine);
    f.snippetHash = snippetHash(f.codeLines);
    f.fingerprint = fingerprint(f.path, f.title, f.snippetHash);
  }

  const survivors = findings
    .filter((f) => f.status === 'posted')
    .sort((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id));

  // Dedupe near-duplicates (same path, overlapping lines, similar title or same code+category).
  const kept: Finding[] = [];
  for (const f of survivors) {
    const dup = kept.find((k) => isNearDuplicate(k, f));
    if (dup) {
      f.status = 'duplicate';
      f.statusReason = `duplicate of ${dup.id}`;
    } else kept.push(f);
  }

  // Never repost or re-raise.
  const remaining: Finding[] = [];
  for (const f of kept) {
    const sup = matchesRef(f, input.suppressed ?? []);
    if (sup) {
      f.status = 'suppressed';
      f.statusReason = 'dismissed by the team on an earlier review';
      continue;
    }
    const prev = matchesRef(f, input.previous ?? []);
    if (prev) {
      f.status = 'already_posted';
      f.statusReason = 'already reported on this pull request';
      continue;
    }
    remaining.push(f);
  }

  // Placement + caps (remaining is already sorted by rank).
  let inline = 0;
  let general = 0;
  let digest = 0;
  const perSeverity: Record<string, number> = {};
  for (const f of remaining) {
    if (f.severity === 'low') {
      if (digest < opts.maxDigest) {
        f.status = 'digest';
        digest++;
      } else capped(f, 'digest limit reached');
      continue;
    }
    if (!f.anchored) {
      if (general < opts.maxGeneral) {
        f.status = 'general';
        f.statusReason = input.diffFiles.has(f.path)
          ? 'line is not part of the diff'
          : 'file is not part of the diff';
        general++;
      } else capped(f, 'general findings limit reached');
      continue;
    }
    const sevCap = opts.severityCaps[f.severity];
    const used = perSeverity[f.severity] ?? 0;
    if (inline >= config.maxComments) capped(f, `maxComments (${config.maxComments}) reached`);
    else if (used >= sevCap) capped(f, `${f.severity} cap (${sevCap}) reached`);
    else {
      f.status = 'posted';
      inline++;
      perSeverity[f.severity] = used + 1;
    }
  }

  return { findings, batches: batches.length, overflow: overflow.map((u) => u.file.path), usage, warnings };
}

function capped(f: Finding, reason: string) {
  f.status = 'capped';
  f.statusReason = reason;
}

function isNearDuplicate(a: Finding, b: Finding): boolean {
  if (a.path !== b.path) return false;
  const slack = 2;
  const aEnd = a.endLine ?? a.line;
  const bEnd = b.endLine ?? b.line;
  const overlap = a.line - slack <= bEnd && b.line - slack <= aEnd;
  if (!overlap) return false;
  return (
    titleSimilarity(a.title, b.title) >= 0.5 || (a.snippetHash === b.snippetHash && a.category === b.category)
  );
}

/** Map the Reviewer's path to a file of its batch (exact, case-insensitive, a/ b/ prefixes, unique suffix). */
function resolvePath(cited: string, batch: Batch): string | null {
  const paths = batch.files.map((f) => f.path);
  const clean = cited
    .trim()
    .replace(/^\.\//, '')
    .replace(/^[ab]\//, '');
  if (paths.includes(cited)) return cited;
  if (paths.includes(clean)) return clean;
  const ci = paths.filter((p) => p.toLowerCase() === clean.toLowerCase());
  if (ci.length === 1) return ci[0]!;
  const suffix = paths.filter((p) => p.endsWith(`/${clean}`) || clean.endsWith(`/${p}`));
  return suffix.length === 1 ? suffix[0]! : null;
}

function toCriticItem(f: Finding, input: PipelineInput, around: number): CriticItem {
  const file = input.diffFiles.get(f.path);
  const content = input.contents.get(f.path);
  const end = f.endLine ?? f.line;
  const hunk = file ? nearestHunk(file, f.line) : undefined;
  return {
    id: f.id,
    path: f.path,
    line: f.line,
    endLine: f.endLine,
    severity: f.severity,
    category: f.category,
    title: f.title,
    body: f.body,
    failureScenario: f.failureScenario,
    suggestion: f.suggestion,
    excerpt: renderExcerpt(file, content, f.line - around, end + around) || '(code not available)',
    hunk: hunk ? renderHunk(hunk) : '(the cited file is not part of this diff)',
  };
}

function applyVerdict(
  f: Finding,
  v: CriticVerdict | undefined,
  failure: string | null,
  file: DiffFile | undefined,
) {
  if (!v) {
    // Unverified findings are treated as plausible: kept only if keepPlausible and confident enough.
    f.verdict = 'plausible';
    f.criticReason = failure
      ? `Critic unavailable (${failure}); not verified.`
      : 'The Critic returned no verdict; not verified.';
    return;
  }
  f.verdict = v.verdict as Verdict;
  f.criticReason = v.reason || null;
  if (v.verdict === 'rejected') return;
  if (v.correctedSeverity) f.severity = v.correctedSeverity;
  const corrected = v.correctedLine;
  if (corrected && corrected !== f.line) {
    // Only accept corrections onto commentable lines of the same file.
    if (file && commentableLines(file).has(corrected)) {
      const span = f.endLine ? f.endLine - f.line : 0;
      f.line = corrected;
      f.endLine = span > 0 ? corrected + span : null;
      f.lineCorrected = true;
      f.rangeChanged = true;
    } else {
      f.criticReason =
        `${f.criticReason ?? ''} (line correction to ${corrected} ignored: not a commentable line)`.trim();
    }
  }
}
