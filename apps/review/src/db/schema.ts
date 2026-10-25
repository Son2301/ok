import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  real,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const review = pgSchema('review');

const ts = (name: string) => timestamp(name, { withTimezone: true });
const id64 = (name: string) => bigint(name, { mode: 'number' });

/** GitHub App installations, optionally linked to a platform org (who pays). */
export const installations = review.table(
  'installations',
  {
    id: id64('id').primaryKey(),
    accountLogin: text('account_login').notNull(),
    accountType: text('account_type').notNull().default('Organization'),
    accountId: id64('account_id'),
    orgId: text('org_id'),
    /** active | suspended | deleted */
    status: text('status').notNull().default('active'),
    linkedAt: ts('linked_at'),
    /** Last installation/installation_repositories webhook (owner-triggered); bounds the no-OAuth link window. */
    lastEventAt: ts('last_event_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('installations_org_idx').on(t.orgId)],
);

export const repos = review.table(
  'repos',
  {
    id: id64('id').primaryKey(),
    installationId: id64('installation_id')
      .notNull()
      .references(() => installations.id, { onDelete: 'cascade' }),
    fullName: text('full_name').notNull(),
    private: boolean('private').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('repos_installation_idx').on(t.installationId)],
);

/** Console overrides of `.okreview.yml` (partial config, merged on top of the repo file). */
export const repoSettings = review.table('repo_settings', {
  repoId: id64('repo_id')
    .primaryKey()
    .references(() => repos.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull(),
  updatedBy: text('updated_by'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export interface ReviewStats {
  filesReviewed: number;
  skipped: { path: string; reason: string }[];
  candidates: number;
  confirmed: number;
  plausible: number;
  rejected: number;
  batches: number;
  resolved: number;
  stillOpen: number;
  warnings: string[];
  inlineFallback?: boolean;
}

export const reviews = review.table(
  'reviews',
  {
    id: text('id').primaryKey(),
    installationId: id64('installation_id').notNull(),
    repoId: id64('repo_id').notNull(),
    repoFullName: text('repo_full_name').notNull(),
    prNumber: integer('pr_number').notNull(),
    prTitle: text('pr_title'),
    headSha: text('head_sha'),
    baseSha: text('base_sha'),
    /** Previous reviewed head for incremental reviews. */
    fromSha: text('from_sha'),
    /** full | incremental */
    mode: text('mode').notNull(),
    trigger: text('trigger').notNull(),
    /** running | completed | failed | skipped | quota_exceeded | insufficient_balance | not_linked */
    status: text('status').notNull(),
    statusReason: text('status_reason'),
    billedOrgId: text('billed_org_id'),
    /** org | platform */
    billedTo: text('billed_to'),
    error: text('error'),
    stats: jsonb('stats').$type<ReviewStats>(),
    counts: jsonb('counts').$type<Record<string, number>>(),
    findingsCount: integer('findings_count').notNull().default(0),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    llmCalls: integer('llm_calls').notNull().default(0),
    durationMs: integer('duration_ms'),
    githubReviewId: id64('github_review_id'),
    checkRunId: id64('check_run_id'),
    configError: text('config_error'),
    models: jsonb('models').$type<{ reviewer: string; critic: string }>(),
    createdAt: ts('created_at').notNull().defaultNow(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    index('reviews_pr_idx').on(t.repoId, t.prNumber, t.createdAt),
    index('reviews_installation_idx').on(t.installationId, t.createdAt),
  ],
);

export const findings = review.table(
  'findings',
  {
    id: text('id').primaryKey(),
    reviewId: text('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    repoId: id64('repo_id').notNull(),
    prNumber: integer('pr_number').notNull(),
    localId: text('local_id').notNull(),
    path: text('path').notNull(),
    line: integer('line').notNull(),
    endLine: integer('end_line'),
    originalLine: integer('original_line').notNull(),
    originalEndLine: integer('original_end_line'),
    severity: text('severity').notNull(),
    originalSeverity: text('original_severity').notNull(),
    category: text('category').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    failureScenario: text('failure_scenario').notNull(),
    suggestion: text('suggestion'),
    replacement: text('replacement'),
    confidence: real('confidence').notNull(),
    /** confirmed | plausible | rejected */
    verdict: text('verdict').notNull(),
    criticReason: text('critic_reason'),
    lineCorrected: boolean('line_corrected').notNull().default(false),
    anchored: boolean('anchored').notNull().default(false),
    /** posted | general | digest | rejected | filtered | duplicate | capped | already_posted | suppressed */
    status: text('status').notNull(),
    statusReason: text('status_reason'),
    fingerprint: text('fingerprint').notNull(),
    snippetHash: text('snippet_hash').notNull(),
    githubCommentId: id64('github_comment_id'),
    /** Shown to the author and not yet resolved/dismissed. */
    open: boolean('open').notNull().default(false),
    /** Position of the flagged code at the latest reviewed head (updated by incremental reviews). */
    trackedLine: integer('tracked_line'),
    trackedEndLine: integer('tracked_end_line'),
    trackedSha: text('tracked_sha'),
    resolvedInReviewId: text('resolved_in_review_id'),
    resolvedAt: ts('resolved_at'),
    dismissedAt: ts('dismissed_at'),
    dismissedReason: text('dismissed_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('findings_review_idx').on(t.reviewId),
    index('findings_pr_open_idx').on(t.repoId, t.prNumber, t.open),
    index('findings_fingerprint_idx').on(t.repoId, t.fingerprint),
  ],
);

/** Fingerprints the team dismissed (reply like "won't fix" or a 👎) — never raised again in the repo. */
export const suppressions = review.table(
  'suppressions',
  {
    repoId: id64('repo_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    path: text('path').notNull(),
    snippetHash: text('snippet_hash').notNull(),
    title: text('title').notNull(),
    reason: text('reason').notNull(),
    prNumber: integer('pr_number'),
    findingId: text('finding_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.fingerprint] })],
);

/** Free monthly reviews for installations that are not linked to an org. */
export const quotaUsage = review.table(
  'quota_usage',
  {
    installationId: id64('installation_id').notNull(),
    period: text('period').notNull(),
    reviewsUsed: integer('reviews_used').notNull().default(0),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.installationId, t.period] })],
);

/** One-off PR comments (quota, balance, invalid config) are posted at most once per key. */
export const prNotices = review.table(
  'pr_notices',
  {
    repoId: id64('repo_id').notNull(),
    prNumber: integer('pr_number').notNull(),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.prNumber, t.kind, t.key] })],
);

/** Durable mirror of the in-process queue (one row per coalescing key) for crash recovery. */
export const jobs = review.table(
  'jobs',
  {
    key: text('key').primaryKey(),
    kind: text('kind').notNull().default('review'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** queued | running | retrying | done | failed | cancelled */
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('jobs_status_idx').on(t.status)],
);
