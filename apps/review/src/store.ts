import type { Db, DbHandle } from '@minh/db';
import { migrate } from '@minh/db';
import { AppError, newId } from '@minh/shared';
import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { reviewMigrations } from './db/migrations';
import {
  findings,
  installations,
  jobs,
  prNotices,
  quotaUsage,
  repoSettings,
  repos,
  reviews,
  suppressions,
} from './db/schema';
import type { FingerprintRef } from './pipeline/fingerprint';
import type { Finding } from './pipeline/types';

export type InstallationRow = typeof installations.$inferSelect;
export type RepoRow = typeof repos.$inferSelect;
export type ReviewRow = typeof reviews.$inferSelect;
export type FindingRow = typeof findings.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;

/** All SQL for the `review` schema. */
export class Store {
  readonly db: Db;
  constructor(private readonly handle: DbHandle) {
    this.db = handle.db;
  }

  migrate() {
    return migrate(this.handle, 'review', reviewMigrations);
  }

  // ------------------------------------------------------------ installations

  /**
   * Insert or refresh an installation. Pass `eventAt` only for owner-triggered
   * installation webhooks (or GitHub's own created_at); it opens the link window.
   */
  async upsertInstallation(input: {
    id: number;
    accountLogin: string;
    accountType: string;
    accountId?: number | null;
    status?: string;
    eventAt?: Date | null;
  }) {
    const [row] = await this.db
      .insert(installations)
      .values({
        id: input.id,
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        accountId: input.accountId ?? null,
        status: input.status ?? 'active',
        lastEventAt: input.eventAt ?? null,
      })
      .onConflictDoUpdate({
        target: installations.id,
        set: {
          accountLogin: input.accountLogin,
          accountType: input.accountType,
          ...(input.accountId ? { accountId: input.accountId } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.eventAt ? { lastEventAt: input.eventAt } : {}),
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  }

  /** Insert a placeholder for an installation we only learned about from a PR event (no link window). */
  async ensureInstallation(id: number, accountLogin: string): Promise<InstallationRow> {
    await this.db
      .insert(installations)
      .values({ id, accountLogin, accountType: 'Organization' })
      .onConflictDoNothing();
    return (await this.getInstallation(id))!;
  }

  async setInstallationStatus(
    id: number,
    status: 'active' | 'suspended' | 'deleted',
    eventAt: Date = new Date(),
  ) {
    await this.db
      .update(installations)
      .set({ status, lastEventAt: eventAt, updatedAt: new Date() })
      .where(eq(installations.id, id));
  }

  async getInstallation(id: number): Promise<InstallationRow | null> {
    const [row] = await this.db.select().from(installations).where(eq(installations.id, id));
    return row ?? null;
  }

  /** Link an installation to an org. Refuses (conflict) if it is linked to a different org. */
  async linkInstallation(id: number, orgId: string): Promise<InstallationRow> {
    const [row] = await this.db
      .update(installations)
      .set({ orgId, linkedAt: new Date() })
      .where(and(eq(installations.id, id), or(isNull(installations.orgId), eq(installations.orgId, orgId))))
      .returning();
    if (row) return row;
    const existing = await this.getInstallation(id);
    if (!existing) throw new AppError('not_found', 'Unknown installation');
    throw new AppError('conflict', 'This installation is already linked to another organization');
  }

  async unlinkInstallation(id: number, orgId: string): Promise<void> {
    const res = await this.db
      .update(installations)
      .set({ orgId: null, linkedAt: null })
      .where(and(eq(installations.id, id), eq(installations.orgId, orgId)))
      .returning({ id: installations.id });
    if (!res.length) throw new AppError('not_found', 'Installation not found');
  }

  listInstallationsForOrg(orgId: string): Promise<InstallationRow[]> {
    return this.db
      .select()
      .from(installations)
      .where(eq(installations.orgId, orgId))
      .orderBy(installations.accountLogin);
  }

  // ------------------------------------------------------------------ repos

  async upsertRepos(installationId: number, list: { id: number; fullName: string; private: boolean }[]) {
    for (const r of list) {
      await this.db
        .insert(repos)
        .values({ id: r.id, installationId, fullName: r.fullName, private: r.private, active: true })
        .onConflictDoUpdate({
          target: repos.id,
          set: {
            installationId,
            fullName: r.fullName,
            private: r.private,
            active: true,
            updatedAt: new Date(),
          },
        });
    }
  }

  async deactivateRepos(ids: number[]) {
    if (!ids.length) return;
    await this.db.update(repos).set({ active: false, updatedAt: new Date() }).where(inArray(repos.id, ids));
  }

  async getRepo(id: number): Promise<RepoRow | null> {
    const [row] = await this.db.select().from(repos).where(eq(repos.id, id));
    return row ?? null;
  }

  async findRepoForOrg(orgId: string, fullName: string): Promise<(RepoRow & { orgId: string }) | null> {
    const [row] = await this.db
      .select({ repo: repos, orgId: installations.orgId })
      .from(repos)
      .innerJoin(installations, eq(installations.id, repos.installationId))
      .where(and(eq(installations.orgId, orgId), sql`lower(${repos.fullName}) = ${fullName.toLowerCase()}`));
    return row ? { ...row.repo, orgId: row.orgId! } : null;
  }

  async listReposForOrg(orgId: string) {
    return this.db
      .select({ repo: repos, settings: repoSettings.settings, installationStatus: installations.status })
      .from(repos)
      .innerJoin(installations, eq(installations.id, repos.installationId))
      .leftJoin(repoSettings, eq(repoSettings.repoId, repos.id))
      .where(eq(installations.orgId, orgId))
      .orderBy(repos.fullName);
  }

  // --------------------------------------------------------------- settings

  async getRepoSettings(repoId: number): Promise<Record<string, unknown> | null> {
    const [row] = await this.db.select().from(repoSettings).where(eq(repoSettings.repoId, repoId));
    return row?.settings ?? null;
  }

  async setRepoSettings(repoId: number, settings: Record<string, unknown>, updatedBy: string | null) {
    await this.db
      .insert(repoSettings)
      .values({ repoId, settings, updatedBy })
      .onConflictDoUpdate({
        target: repoSettings.repoId,
        set: { settings, updatedBy, updatedAt: new Date() },
      });
  }

  // ---------------------------------------------------------------- reviews

  async createReview(input: typeof reviews.$inferInsert): Promise<ReviewRow> {
    const [row] = await this.db.insert(reviews).values(input).returning();
    return row!;
  }

  async updateReview(id: string, patch: Partial<typeof reviews.$inferInsert>) {
    await this.db.update(reviews).set(patch).where(eq(reviews.id, id));
  }

  /** Latest completed review of a PR (the base for incremental reviews). */
  async lastCompletedReview(repoId: number, prNumber: number): Promise<ReviewRow | null> {
    const [row] = await this.db
      .select()
      .from(reviews)
      .where(and(eq(reviews.repoId, repoId), eq(reviews.prNumber, prNumber), eq(reviews.status, 'completed')))
      .orderBy(desc(reviews.createdAt))
      .limit(1);
    return row ?? null;
  }

  async listReviewsForOrg(
    orgId: string,
    opts: { repo?: string; prNumber?: number; status?: string; limit?: number; before?: Date } = {},
  ) {
    const conditions = [eq(installations.orgId, orgId)];
    if (opts.repo) conditions.push(sql`lower(${reviews.repoFullName}) = ${opts.repo.toLowerCase()}`);
    if (opts.prNumber) conditions.push(eq(reviews.prNumber, opts.prNumber));
    if (opts.status) conditions.push(eq(reviews.status, opts.status));
    if (opts.before) conditions.push(lt(reviews.createdAt, opts.before));
    const rows = await this.db
      .select({ review: reviews })
      .from(reviews)
      .innerJoin(installations, eq(installations.id, reviews.installationId))
      .where(and(...conditions))
      .orderBy(desc(reviews.createdAt))
      .limit(Math.min(opts.limit ?? 50, 200));
    return rows.map((r) => r.review);
  }

  /** Completed-review count and LLM cost for the org's installations since `since`. */
  async usageForOrg(orgId: string, since: Date): Promise<{ reviews: number; costMicros: number }> {
    const [row] = await this.db
      .select({ reviews: sql<string>`count(*)`, cost: sql<string>`coalesce(sum(${reviews.costMicros}), 0)` })
      .from(reviews)
      .innerJoin(installations, eq(installations.id, reviews.installationId))
      .where(
        and(eq(installations.orgId, orgId), eq(reviews.status, 'completed'), gte(reviews.createdAt, since)),
      );
    return { reviews: Number(row?.reviews ?? 0), costMicros: Number(row?.cost ?? 0) };
  }

  async getReviewForOrg(orgId: string, id: string): Promise<ReviewRow | null> {
    const [row] = await this.db
      .select({ review: reviews })
      .from(reviews)
      .innerJoin(installations, eq(installations.id, reviews.installationId))
      .where(and(eq(reviews.id, id), eq(installations.orgId, orgId)));
    return row?.review ?? null;
  }

  // --------------------------------------------------------------- findings

  async insertFindings(
    reviewId: string,
    repoId: number,
    prNumber: number,
    list: Finding[],
    extra: { headSha: string; commentIds?: Map<string, number> },
  ): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    if (!list.length) return ids;
    const rows = list.map((f) => {
      const id = newId('fnd');
      ids.set(f.id, id);
      const open = f.status === 'posted' || f.status === 'general' || f.status === 'digest';
      return {
        id,
        reviewId,
        repoId,
        prNumber,
        localId: f.id,
        path: f.path,
        line: f.line,
        endLine: f.endLine,
        originalLine: f.originalLine,
        originalEndLine: f.originalEndLine,
        severity: f.severity,
        originalSeverity: f.originalSeverity,
        category: f.category,
        title: f.title,
        body: f.body,
        failureScenario: f.failureScenario,
        suggestion: f.suggestion,
        replacement: f.replacement,
        confidence: f.confidence,
        verdict: f.verdict,
        criticReason: f.criticReason,
        lineCorrected: f.lineCorrected,
        anchored: f.anchored,
        status: f.status,
        statusReason: f.statusReason,
        fingerprint: f.fingerprint,
        snippetHash: f.snippetHash,
        githubCommentId: extra.commentIds?.get(f.id) ?? null,
        open,
        trackedLine: open ? f.line : null,
        trackedEndLine: open ? f.endLine : null,
        trackedSha: open ? extra.headSha : null,
      };
    });
    for (let i = 0; i < rows.length; i += 100) await this.db.insert(findings).values(rows.slice(i, i + 100));
    return ids;
  }

  findingsForReview(reviewId: string): Promise<FindingRow[]> {
    return this.db.select().from(findings).where(eq(findings.reviewId, reviewId)).orderBy(findings.localId);
  }

  /** Findings shown on this PR that are still open. */
  openFindings(repoId: number, prNumber: number): Promise<FindingRow[]> {
    return this.db
      .select()
      .from(findings)
      .where(and(eq(findings.repoId, repoId), eq(findings.prNumber, prNumber), eq(findings.open, true)));
  }

  async resolveFindings(ids: string[], reviewId: string) {
    if (!ids.length) return;
    await this.db
      .update(findings)
      .set({ open: false, resolvedInReviewId: reviewId, resolvedAt: new Date() })
      .where(inArray(findings.id, ids));
  }

  async trackFinding(id: string, line: number | null, endLine: number | null, sha: string) {
    await this.db
      .update(findings)
      .set({ trackedLine: line, trackedEndLine: endLine, trackedSha: sha })
      .where(eq(findings.id, id));
  }

  /** Mark a finding dismissed by the team and remember its fingerprint for the whole repo. */
  async dismissFinding(row: FindingRow, reason: string) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(findings)
        .set({ open: false, dismissedAt: new Date(), dismissedReason: reason })
        .where(eq(findings.id, row.id));
      await tx
        .insert(suppressions)
        .values({
          repoId: row.repoId,
          fingerprint: row.fingerprint,
          path: row.path,
          snippetHash: row.snippetHash,
          title: row.title,
          reason,
          prNumber: row.prNumber,
          findingId: row.id,
        })
        .onConflictDoNothing();
    });
  }

  async listSuppressions(repoId: number): Promise<FingerprintRef[]> {
    const rows = await this.db.select().from(suppressions).where(eq(suppressions.repoId, repoId));
    return rows.map((r) => ({
      fingerprint: r.fingerprint,
      path: r.path,
      snippetHash: r.snippetHash,
      title: r.title,
    }));
  }

  // ------------------------------------------------------------------ quota

  /**
   * Atomically take one free review for this period. Returns the new usage count,
   * or null when the limit is reached (the row is left unchanged).
   */
  async consumeQuota(installationId: number, period: string, limit: number): Promise<number | null> {
    if (limit <= 0) return null;
    const rows = await this.db
      .insert(quotaUsage)
      .values({ installationId, period, reviewsUsed: 1 })
      .onConflictDoUpdate({
        target: [quotaUsage.installationId, quotaUsage.period],
        set: { reviewsUsed: sql`${quotaUsage.reviewsUsed} + 1`, updatedAt: new Date() },
        setWhere: sql`${quotaUsage.reviewsUsed} < ${limit}`,
      })
      .returning({ used: quotaUsage.reviewsUsed });
    return rows[0]?.used ?? null;
  }

  async refundQuota(installationId: number, period: string) {
    await this.db
      .update(quotaUsage)
      .set({ reviewsUsed: sql`greatest(${quotaUsage.reviewsUsed} - 1, 0)`, updatedAt: new Date() })
      .where(and(eq(quotaUsage.installationId, installationId), eq(quotaUsage.period, period)));
  }

  async getQuotaUsed(installationId: number, period: string): Promise<number> {
    const [row] = await this.db
      .select()
      .from(quotaUsage)
      .where(and(eq(quotaUsage.installationId, installationId), eq(quotaUsage.period, period)));
    return row?.reviewsUsed ?? 0;
  }

  // ---------------------------------------------------------------- notices

  /** True the first time (repo, pr, kind, key) is claimed — used to post one-off comments once. */
  async claimNotice(repoId: number, prNumber: number, kind: string, key: string): Promise<boolean> {
    const rows = await this.db
      .insert(prNotices)
      .values({ repoId, prNumber, kind, key })
      .onConflictDoNothing()
      .returning({ kind: prNotices.kind });
    return rows.length > 0;
  }

  // ------------------------------------------------------------------- jobs

  async saveJob(key: string, payload: Record<string, unknown>, status: string) {
    await this.db
      .insert(jobs)
      .values({ key, payload, status })
      .onConflictDoUpdate({
        target: jobs.key,
        set: { payload, status, attempts: 0, lastError: null, updatedAt: new Date() },
      });
  }

  async markJob(key: string, status: string, patch: { attempts?: number; lastError?: string | null } = {}) {
    await this.db
      .update(jobs)
      .set({ status, ...patch, updatedAt: new Date() })
      .where(eq(jobs.key, key));
  }

  unfinishedJobs(): Promise<JobRow[]> {
    return this.db
      .select()
      .from(jobs)
      .where(inArray(jobs.status, ['queued', 'running', 'retrying']))
      .orderBy(jobs.updatedAt);
  }
}
