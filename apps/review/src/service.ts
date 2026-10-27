import type { LlmClient } from '@minh/llm';
import { AppError, type Logger, newId } from '@minh/shared';
import type { Billing, BillingDecision } from './billing';
import { CONFIG_FILENAMES, type RepoConfig, resolveRepoConfig } from './config';
import { buildFileMap, type ReviewUnit, splitLines } from './diff/chunk';
import { filterFiles, type SkippedFile } from './diff/filter';
import { touchedNewLines, trackRange } from './diff/lines';
import { parseUnifiedDiff } from './diff/parse';
import { prioritize } from './diff/prioritize';
import type { DiffFile, DiffHunk } from './diff/types';
import {
  checkConclusion,
  checkTitle,
  formatConfigErrorComment,
  formatInsufficientBalanceComment,
  formatNotLinkedComment,
  formatQuotaExceededComment,
  formatSummary,
  type ResolvedRef,
  toReviewComment,
} from './github/format';
import type { GitHubApp, InstallationClient, PullComment, PullRequestInfo } from './github/types';
import type { ReviewJobPayload } from './github/webhook';
import { type FingerprintRef, snippetHash } from './pipeline/fingerprint';
import { type PipelineOptions, type PipelineResult, runPipeline } from './pipeline/run';
import type { Finding } from './pipeline/types';
import type { FindingRow, InstallationRow, Store } from './store';
import { errorMessage, isPaymentError, mapLimit, sha256Hex } from './util';

export interface ReviewServiceOptions {
  /** Create/update a `Review` check run (needs checks:write). */
  checkRuns: boolean;
  /** Console base URL used in comments (link account, top up). */
  consoleUrl: string;
  /** Skip fetching full content for files larger than this (bytes). */
  maxFileBytes: number;
  contentConcurrency: number;
  fileMapEntries: number;
  pipeline?: Partial<PipelineOptions>;
}

export const DEFAULT_SERVICE_OPTIONS: ReviewServiceOptions = {
  checkRuns: true,
  consoleUrl: 'http://localhost:3000',
  maxFileBytes: 512 * 1024,
  contentConcurrency: 5,
  fileMapEntries: 300,
};

export interface ReviewServiceDeps {
  store: Store;
  github: GitHubApp | null;
  billing: Billing;
  /** LLM client billed to `orgId` (gateway with x-org-id + x-minh-product: review). */
  llmFor: (orgId: string) => LlmClient;
  logger: Logger;
  options?: Partial<ReviewServiceOptions>;
  now?: () => number;
}

export type ReviewOutcome =
  | { status: 'skipped'; reason: string; reviewId?: string }
  | { status: 'completed'; reviewId: string; posted: number; general: number; githubReviewId: number | null }
  | { status: 'quota_exceeded' | 'insufficient_balance' | 'not_linked'; reviewId: string };

/** Replies that dismiss a finding ("won't fix", "false positive", …). Matched case-insensitively. */
const DISMISS_ANYWHERE =
  /\b(won'?t fix|wontfix|false positive|not a bug|not an issue|by design|as designed|works? as intended|working as intended|not applicable)\b|không phải lỗi|không sửa|cố ý|^\s*\/(dismiss|ignore)\b/i;
const DISMISS_LEADING = /^\s*(this is |that'?s |it'?s )?(intended|intentional|expected( behaviou?r)?)\b/i;
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const EMPTY_SNIPPET = snippetHash([]);

/**
 * Find the line where a `span+1`-line snippet with hash `hash` starts, nearest to
 * `near`. Returns null when the code no longer exists in the file.
 */
function relocate(content: string, hash: string, span: number, near: number): number | null {
  const lines = splitLines(content);
  let best: number | null = null;
  for (let i = 0; i + span < lines.length; i++) {
    if (snippetHash(lines.slice(i, i + span + 1)) !== hash) continue;
    const line = i + 1;
    if (best === null || Math.abs(line - near) < Math.abs(best - near)) best = line;
  }
  return best;
}

const hunkTouches = (h: DiffHunk, touched: Set<number>) => {
  const start = h.newLines > 0 ? h.newStart : h.newStart + 1;
  const end = h.newStart + Math.max(h.newLines, 1) - 1;
  for (let n = start - 1; n <= end + 1; n++) if (touched.has(n)) return true;
  return false;
};

/**
 * Runs one review job end to end: config → diff (full or incremental) → filters
 * and budget → billing → Reviewer/Critic pipeline → one GitHub review with inline
 * comments + summary → persistence (findings, fingerprints, resolution) → check run.
 */
export class ReviewService {
  private readonly opts: ReviewServiceOptions;
  private readonly now: () => number;

  constructor(private readonly deps: ReviewServiceDeps) {
    this.opts = { ...DEFAULT_SERVICE_OPTIONS, ...deps.options };
    this.now = deps.now ?? Date.now;
  }

  async run(job: ReviewJobPayload): Promise<ReviewOutcome> {
    const { store, github, logger } = this.deps;
    if (!github) throw new AppError('bad_request', 'GitHub App is not configured');
    const started = this.now();
    const log = logger.child({ repo: `${job.owner}/${job.repo}`, pr: job.number, trigger: job.trigger });

    // 1. Installation + repo rows (create placeholders if their webhooks were missed).
    let inst = await store.getInstallation(job.installationId);
    if (!inst) inst = await store.ensureInstallation(job.installationId, job.owner);
    if (inst.status !== 'active') return { status: 'skipped', reason: `installation is ${inst.status}` };
    if (!(await store.getRepo(job.repoId))) {
      await store.upsertRepos(inst.id, [
        { id: job.repoId, fullName: `${job.owner}/${job.repo}`, private: false },
      ]);
    }
    const gh = github.installation(inst.id);
    const explicit = job.trigger === 'command' || job.trigger === 'api';
    if (job.commentId)
      await this.soft(log, 'reaction', () => gh.addReaction(job.owner, job.repo, job.commentId!, 'eyes'));

    // 2. Pull request + config.
    const pr = await gh.getPullRequest(job.owner, job.repo, job.number);
    if (pr.state !== 'open') return { status: 'skipped', reason: 'pull request is closed' };
    const { config, error: configError } = await this.loadConfig(gh, job, pr);
    if (pr.draft && !config.reviewDrafts && !explicit)
      return { status: 'skipped', reason: 'draft pull request (reviewDrafts: false)' };

    const last = await store.lastCompletedReview(job.repoId, job.number);
    if (last?.headSha === pr.headSha && !explicit)
      return { status: 'skipped', reason: 'this head commit was already reviewed' };

    if (
      configError &&
      (await store.claimNotice(job.repoId, job.number, 'config_error', sha256Hex(configError).slice(0, 16)))
    ) {
      await this.soft(log, 'config comment', () =>
        gh.createIssueComment(
          job.owner,
          job.repo,
          job.number,
          formatConfigErrorComment(configError, config.language),
        ),
      );
    }

    // 3. Diff: full PR diff (anchoring target) and, for new pushes, the delta since the last review.
    const fullFiles = parseUnifiedDiff(await gh.getPullRequestDiff(job.owner, job.repo, job.number));
    const diffFiles = new Map(fullFiles.map((f) => [f.path, f]));
    let mode: 'full' | 'incremental' = 'full';
    let fromSha: string | null = null;
    let delta: DiffFile[] | null = null;
    if (job.mode !== 'full' && config.incremental && last?.headSha && last.headSha !== pr.headSha) {
      const cmp = await gh.compareCommits(job.owner, job.repo, last.headSha, pr.headSha);
      // Diverged (force-push/rebase) or truncated comparisons fall back to a full review;
      // already-posted fingerprints still prevent duplicate comments.
      if (cmp && cmp.status === 'ahead' && !cmp.truncated) {
        mode = 'incremental';
        fromSha = last.headSha;
        delta = parseUnifiedDiff(cmp.diff);
      }
    }

    // 4. Filters, incremental focus, budget.
    const { kept, skipped: filtered } = filterFiles(fullFiles, {
      ...config.paths,
      maxFileChangedLines: config.limits.maxFileChangedLines,
    });
    let units: ReviewUnit[] = kept.map((file) => ({ file, hunks: file.hunks }));
    if (delta) {
      const byPath = new Map<string, DiffFile>();
      for (const d of delta) if (d.newPath) byPath.set(d.newPath, d);
      units = units.flatMap((u) => {
        const d = byPath.get(u.file.path);
        if (!d) return [];
        const touched = touchedNewLines(d);
        const hunks = u.file.hunks.filter((h) => hunkTouches(h, touched));
        return hunks.length ? [{ ...u, hunks }] : [];
      });
    }
    if (!units.length) {
      // Nothing reviewable changed (e.g. only lockfiles, or a push touching only skipped files): stay silent.
      return {
        status: 'skipped',
        reason: mode === 'incremental' ? 'push changes no reviewable lines' : 'no reviewable files',
      };
    }
    const pri = prioritize(
      units.map((u) => u.file),
      { maxFiles: config.limits.maxFiles, maxChangedLines: config.limits.maxChangedLines },
    );
    const byFile = new Map(units.map((u) => [u.file.path, u]));
    const selected: ReviewUnit[] = pri.selected.map((s) => ({ ...byFile.get(s.file.path)!, risk: s.risk }));
    const skipped: SkippedFile[] = [
      ...filtered,
      ...pri.deferred.map((d) => ({ path: d.file.path, reason: 'budget' as const })),
    ];

    // 5. Billing.
    const decision = await this.deps.billing.authorize(inst);
    const reviewBase = {
      installationId: inst.id,
      repoId: job.repoId,
      repoFullName: `${job.owner}/${job.repo}`,
      prNumber: job.number,
      prTitle: pr.title,
      headSha: pr.headSha,
      baseSha: pr.baseSha,
      fromSha,
      mode,
      trigger: job.trigger,
      configError: configError ?? null,
      models: config.models,
    };
    if (!decision.ok) return this.handleBillingRefusal(gh, job, inst, decision, reviewBase, config);

    const review = await store.createReview({
      id: newId('rev'),
      ...reviewBase,
      status: 'running',
      billedOrgId: decision.orgId,
      billedTo: decision.billedTo,
    });
    const checkRunId = this.opts.checkRuns
      ? await this.soft(
          log,
          'check run',
          async () =>
            (
              await gh.createCheckRun(job.owner, job.repo, {
                name: 'Review',
                headSha: pr.headSha,
                status: 'in_progress',
                title: 'Reviewing…',
                summary: 'Two-pass review (Reviewer + Critic) in progress.',
              })
            ).id,
        )
      : null;

    let githubReviewId: number | null = null;
    try {
      // 6. Context: full file contents, repo map, earlier findings, dismissals.
      const contents = await this.fetchContents(gh, job, pr, selected);
      const allPaths =
        (await this.soft(log, 'file map', () => gh.listFiles(job.owner, job.repo, pr.headSha))) ?? [];
      const fileMap = buildFileMap(
        allPaths,
        selected.map((u) => u.file.path),
        this.opts.fileMapEntries,
      );

      const open = await store.openFindings(job.repoId, job.number);
      const dismissed = await this.detectDismissals(gh, job, pr, open, log);
      const stillOpen = open.filter((r) => !dismissed.has(r.id));
      const { resolved, remaining, moves } = this.trackOpenFindings(stillOpen, {
        delta,
        contents,
        diffPaths: new Set(diffFiles.keys()),
        headSha: pr.headSha,
      });
      const previous: FingerprintRef[] = remaining.map((r) => ({
        fingerprint: r.fingerprint,
        path: r.path,
        snippetHash: r.snippetHash,
        title: r.title,
      }));
      const suppressed = await store.listSuppressions(job.repoId);

      // 7. Two-pass pipeline.
      const result = await runPipeline({
        llm: this.deps.llmFor(decision.orgId),
        config,
        units: selected,
        diffFiles,
        contents,
        fileMap,
        pr: { title: pr.title, body: pr.body },
        mode,
        previous,
        suppressed,
        options: this.opts.pipeline,
        logger: log,
      });
      for (const p of result.overflow) skipped.push({ path: p, reason: 'budget' });
      const reviewedCount = selected.length - result.overflow.length;

      // 8. Post one review (inline comments + summary). Always post when a run happens,
      //    including "No verified issues", so the author knows it ran.
      const resolvedRefs: ResolvedRef[] = resolved.map((r) => ({
        title: r.title,
        path: r.path,
        line: r.trackedLine,
      }));
      const summaryInput = {
        language: config.language,
        mode,
        fromSha,
        headSha: pr.headSha,
        findings: result.findings,
        filesReviewed: reviewedCount,
        skipped,
        resolved: resolvedRefs,
        stillOpen: remaining.length,
        durationMs: this.now() - started,
        costMicros: result.usage.costMicros,
        models: config.models,
        warnings: result.warnings,
        configError,
      };
      const posted = result.findings.filter((f) => f.status === 'posted');
      let inlineFallback = false;
      try {
        githubReviewId = (
          await gh.createReview(job.owner, job.repo, job.number, {
            commitId: pr.headSha,
            body: formatSummary(summaryInput),
            event: 'COMMENT',
            comments: posted.map((f) => toReviewComment(f, config.language)),
          })
        ).id;
      } catch (err) {
        // 422 = a comment GitHub could not place on the diff. Keep the findings by moving them into the body.
        if ((err as { status?: number }).status !== 422 || !posted.length) throw err;
        inlineFallback = true;
        log.warn('inline comments rejected, posting summary only', { err: errorMessage(err) });
        githubReviewId = (
          await gh.createReview(job.owner, job.repo, job.number, {
            commitId: pr.headSha,
            body: formatSummary({ ...summaryInput, inlineFallback: true }),
            event: 'COMMENT',
            comments: [],
          })
        ).id;
      }

      // From here on the review is visible on GitHub: never rethrow (a retry would post it twice).
      await this.finish(log, async () => {
        const commentIds = inlineFallback
          ? new Map<string, number>()
          : await this.matchCommentIds(gh, job, githubReviewId!, posted, log);
        await store.insertFindings(review.id, job.repoId, job.number, result.findings, {
          headSha: pr.headSha,
          commentIds,
        });
        await store.resolveFindings(
          resolved.map((r) => r.id),
          review.id,
        );
        for (const m of moves) await store.trackFinding(m.id, m.line, m.endLine, pr.headSha);
        if (checkRunId) {
          await this.soft(log, 'check run update', () =>
            gh.updateCheckRun(job.owner, job.repo, checkRunId, {
              name: 'Review',
              headSha: pr.headSha,
              status: 'completed',
              conclusion: checkConclusion(result.findings, config.failOn),
              title: checkTitle(result.findings, config.language),
              summary: formatSummary(summaryInput).slice(0, 60_000),
            }),
          );
        }
        await store.updateReview(
          review.id,
          this.completedPatch(result, {
            started,
            reviewedCount,
            skipped,
            resolved: resolved.length,
            stillOpen: remaining.length,
            githubReviewId,
            checkRunId,
            inlineFallback,
          }),
        );
      });
      log.info('review completed', {
        reviewId: review.id,
        posted: posted.length,
        cost: result.usage.costMicros,
      });
      return {
        status: 'completed',
        reviewId: review.id,
        posted: inlineFallback ? 0 : posted.length,
        general: result.findings.filter((f) => f.status === 'general').length,
        githubReviewId,
      };
    } catch (err) {
      const durationMs = this.now() - started;
      if (isPaymentError(err)) {
        await store.updateReview(review.id, {
          status: 'insufficient_balance',
          statusReason: errorMessage(err),
          durationMs,
          completedAt: new Date(),
        });
        await this.notice(
          gh,
          job,
          'insufficient_balance',
          new Date(this.now()).toISOString().slice(0, 10),
          () =>
            formatInsufficientBalanceComment({
              topUpUrl: `${this.opts.consoleUrl}/billing`,
              language: config.language,
            }),
        );
        if (checkRunId)
          await this.completeCheck(gh, job, pr, checkRunId, 'Review skipped: insufficient balance', log);
        return { status: 'insufficient_balance', reviewId: review.id };
      }
      await store.updateReview(review.id, {
        status: 'failed',
        error: errorMessage(err).slice(0, 2000),
        durationMs,
        completedAt: new Date(),
      });
      await this.deps.billing.release(inst.id, decision).catch(() => {});
      if (checkRunId)
        await this.completeCheck(
          gh,
          job,
          pr,
          checkRunId,
          `Review failed: ${errorMessage(err).slice(0, 200)}`,
          log,
        );
      throw err;
    }
  }

  // ------------------------------------------------------------------ helpers

  private async loadConfig(
    gh: InstallationClient,
    job: ReviewJobPayload,
    pr: PullRequestInfo,
  ): Promise<{ config: RepoConfig; error?: string }> {
    // Fork PRs read the config from the base commit so an outside contributor cannot change
    // the models, instructions or limits used (and billed) for their own PR.
    const isFork =
      !pr.headRepoFullName || pr.headRepoFullName.toLowerCase() !== pr.baseRepoFullName.toLowerCase();
    const ref = isFork ? pr.baseSha : pr.headSha;
    let text: string | null = null;
    for (const name of CONFIG_FILENAMES) {
      text = await gh.getFileContent(job.owner, job.repo, name, ref);
      if (text !== null) break;
    }
    const override = await this.deps.store.getRepoSettings(job.repoId);
    return resolveRepoConfig(text, override);
  }

  private async fetchContents(
    gh: InstallationClient,
    job: ReviewJobPayload,
    pr: PullRequestInfo,
    units: ReviewUnit[],
  ) {
    const contents = new Map<string, string>();
    await mapLimit(units, this.opts.contentConcurrency, async (u) => {
      try {
        const text = await gh.getFileContent(job.owner, job.repo, u.file.path, pr.headSha);
        if (text !== null && Buffer.byteLength(text) <= this.opts.maxFileBytes) {
          contents.set(u.file.path, text);
          u.content = text;
        }
      } catch (err) {
        this.deps.logger.warn('could not fetch file content', { path: u.file.path, err: errorMessage(err) });
      }
    });
    return contents;
  }

  /**
   * Findings whose comment thread a maintainer (or the PR author) dismissed with a
   * reply like "won't fix"/"false positive", or that got a 👎, become suppressed
   * fingerprints for the repository and are never raised again.
   */
  private async detectDismissals(
    gh: InstallationClient,
    job: ReviewJobPayload,
    pr: PullRequestInfo,
    open: FindingRow[],
    log: Logger,
  ) {
    const dismissed = new Set<string>();
    const withComments = open.filter((r) => r.githubCommentId);
    if (!withComments.length) return dismissed;
    const comments = await this.soft(log, 'list comments', () =>
      gh.listPullComments(job.owner, job.repo, job.number),
    );
    if (!comments) return dismissed;
    const byId = new Map<number, PullComment>(comments.map((c) => [c.id, c]));
    for (const row of withComments) {
      const own = byId.get(row.githubCommentId!);
      let reason: string | null = null;
      if (own && own.thumbsDown > 0) reason = '👎 reaction';
      const reply = comments.find(
        (c) =>
          c.inReplyToId === row.githubCommentId &&
          c.authorType !== 'Bot' &&
          (TRUSTED.has(c.authorAssociation) || c.authorLogin === pr.authorLogin) &&
          (DISMISS_ANYWHERE.test(c.body) || DISMISS_LEADING.test(c.body)),
      );
      if (reply) reason = `dismissed by @${reply.authorLogin}: "${reply.body.slice(0, 120)}"`;
      if (reason) {
        await this.deps.store.dismissFinding(row, reason);
        dismissed.add(row.id);
      }
    }
    return dismissed;
  }

  /**
   * Follow open findings to the new head.
   *  - Incremental (delta known): map the tracked range through the delta diff; a
   *    range whose lines were modified/deleted is resolved, otherwise shifted.
   *  - Full review of a different head (force-push, `/review full`): re-locate the
   *    flagged code by its snippet hash in the new file; gone → resolved; file no
   *    longer changed by the PR → resolved; unknown → position cleared.
   */
  private trackOpenFindings(
    open: FindingRow[],
    ctx: { delta: DiffFile[] | null; contents: Map<string, string>; diffPaths: Set<string>; headSha: string },
  ) {
    const moves: { id: string; line: number | null; endLine: number | null }[] = [];
    const resolved: FindingRow[] = [];
    const remaining: FindingRow[] = [];
    const { delta } = ctx;
    if (!delta) {
      for (const row of open) {
        if (row.trackedSha === ctx.headSha || row.trackedLine === null) {
          remaining.push(row);
          continue;
        }
        if (!ctx.diffPaths.has(row.path)) {
          resolved.push(row);
          continue;
        }
        const content = ctx.contents.get(row.path);
        const span = (row.trackedEndLine ?? row.trackedLine) - row.trackedLine;
        const found =
          content !== undefined && row.snippetHash !== EMPTY_SNIPPET
            ? relocate(content, row.snippetHash, span, row.trackedLine)
            : undefined;
        if (found === null) resolved.push(row);
        else {
          remaining.push(row);
          moves.push(
            found === undefined
              ? { id: row.id, line: null, endLine: null }
              : { id: row.id, line: found, endLine: span ? found + span : null },
          );
        }
      }
      return { resolved, remaining, moves };
    }
    const byOldPath = new Map<string, DiffFile>();
    for (const d of delta) if (d.oldPath) byOldPath.set(d.oldPath, d);
    for (const row of open) {
      const d = byOldPath.get(row.path);
      if (!d) {
        remaining.push(row);
        continue;
      }
      if (d.status === 'deleted' || row.trackedLine === null) {
        if (d.status === 'deleted') resolved.push(row);
        else remaining.push(row);
        continue;
      }
      const tr = trackRange(d, row.trackedLine, row.trackedEndLine ?? row.trackedLine);
      if (tr.changed) resolved.push(row);
      else {
        remaining.push(row);
        if (tr.line !== row.trackedLine)
          moves.push({ id: row.id, line: tr.line, endLine: row.trackedEndLine ? tr.endLine : null });
      }
    }
    // Pure: positions are persisted only after the review is posted, so a failed
    // run (retried from the same base commit) never shifts lines twice.
    return { resolved, remaining, moves };
  }

  private async matchCommentIds(
    gh: InstallationClient,
    job: ReviewJobPayload,
    reviewId: number,
    posted: Finding[],
    log: Logger,
  ) {
    const ids = new Map<string, number>();
    if (!posted.length) return ids;
    const comments = await this.soft(log, 'list review comments', () =>
      gh.listReviewComments(job.owner, job.repo, job.number, reviewId),
    );
    if (!comments) return ids;
    const pool = [...comments];
    for (const f of posted) {
      const line = f.endLine ?? f.line;
      const idx = pool.findIndex(
        (c) => c.path === f.path && c.line === line && c.body.includes(f.title.slice(0, 60)),
      );
      const fallback = idx === -1 ? pool.findIndex((c) => c.path === f.path && c.line === line) : idx;
      if (fallback !== -1) {
        ids.set(f.id, pool[fallback]!.id);
        pool.splice(fallback, 1);
      }
    }
    return ids;
  }

  private completedPatch(
    result: PipelineResult,
    x: {
      started: number;
      reviewedCount: number;
      skipped: SkippedFile[];
      resolved: number;
      stillOpen: number;
      githubReviewId: number | null;
      checkRunId: number | null;
      inlineFallback: boolean;
    },
  ) {
    const visible = result.findings.filter(
      (f) => f.status === 'posted' || f.status === 'general' || f.status === 'digest',
    );
    const counts = { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>;
    for (const f of visible) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    const verdicts = (v: Finding['verdict']) => result.findings.filter((f) => f.verdict === v).length;
    return {
      status: 'completed',
      stats: {
        filesReviewed: x.reviewedCount,
        skipped: x.skipped,
        candidates: result.findings.length,
        confirmed: verdicts('confirmed'),
        plausible: verdicts('plausible'),
        rejected: verdicts('rejected'),
        batches: result.batches,
        resolved: x.resolved,
        stillOpen: x.stillOpen,
        warnings: result.warnings,
        inlineFallback: x.inlineFallback,
      },
      counts,
      findingsCount: visible.length,
      costMicros: result.usage.costMicros,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      llmCalls: result.usage.calls,
      durationMs: this.now() - x.started,
      githubReviewId: x.githubReviewId,
      checkRunId: x.checkRunId,
      completedAt: new Date(),
    };
  }

  private async handleBillingRefusal(
    gh: InstallationClient,
    job: ReviewJobPayload,
    inst: InstallationRow,
    decision: Exclude<BillingDecision, { ok: true }>,
    base: Omit<Parameters<Store['createReview']>[0], 'id' | 'status'>,
    config: RepoConfig,
  ): Promise<ReviewOutcome> {
    const review = await this.deps.store.createReview({
      id: newId('rev'),
      ...base,
      status: decision.status,
      completedAt: new Date(),
    });
    const linkUrl = `${this.opts.consoleUrl}/review/link?installation_id=${inst.id}`;
    if (decision.status === 'quota_exceeded') {
      await this.notice(gh, job, 'quota_exceeded', decision.period, () =>
        formatQuotaExceededComment({ limit: decision.limit, linkUrl, language: config.language }),
      );
    } else if (decision.status === 'not_linked') {
      await this.notice(gh, job, 'not_linked', 'once', () =>
        formatNotLinkedComment({ linkUrl, language: config.language }),
      );
    } else {
      await this.notice(
        gh,
        job,
        'insufficient_balance',
        new Date(this.now()).toISOString().slice(0, 10),
        () =>
          formatInsufficientBalanceComment({
            topUpUrl: `${this.opts.consoleUrl}/billing`,
            language: config.language,
          }),
      );
    }
    this.deps.logger.info('review not billed', { status: decision.status, installation: inst.id });
    return { status: decision.status, reviewId: review.id };
  }

  /** Post a one-off PR comment at most once per (PR, kind, key). */
  private async notice(
    gh: InstallationClient,
    job: ReviewJobPayload,
    kind: string,
    key: string,
    body: () => string,
  ) {
    if (!(await this.deps.store.claimNotice(job.repoId, job.number, kind, key))) return;
    await this.soft(this.deps.logger, `${kind} comment`, () =>
      gh.createIssueComment(job.owner, job.repo, job.number, body()),
    );
  }

  private async completeCheck(
    gh: InstallationClient,
    job: ReviewJobPayload,
    pr: PullRequestInfo,
    id: number,
    title: string,
    log: Logger,
  ) {
    await this.soft(log, 'check run update', () =>
      gh.updateCheckRun(job.owner, job.repo, id, {
        name: 'Review',
        headSha: pr.headSha,
        status: 'completed',
        conclusion: 'neutral',
        title,
        summary: title,
      }),
    );
  }

  /** Best-effort side effect: log and continue on failure. */
  private async soft<T>(log: Logger, what: string, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      log.warn(`${what} failed`, { err: errorMessage(err) });
      return null;
    }
  }

  private async finish(log: Logger, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      log.error('post-review bookkeeping failed (review already posted; not retrying)', {
        err: errorMessage(err),
      });
    }
  }
}
