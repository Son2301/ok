import { type AuthEnv, authMiddleware, getAuth } from '@ok/core';
import { AppError, parseJson } from '@ok/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { DEFAULT_CONFIG, validateOverride } from '../config';
import { type ReviewJobPayload, reviewJobKey } from '../github/webhook';
import { linkInstallation } from '../linking';
import type { FindingRow, ReviewRow } from '../store';
import { currentPeriod } from '../util';
import { notConfigured } from './github';
import type { RouteDeps } from './types';

const linkBody = z.object({
  installationId: z.coerce.number().int().positive(),
  state: z.string().min(10),
  /** Optional OAuth code (from the setup redirect) for strong ownership verification. */
  code: z.string().min(1).optional(),
});

const runBody = z
  .object({
    /** `owner/repo#123` */
    target: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+#\d+$/, 'expected owner/repo#number')
      .optional(),
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, 'expected owner/repo')
      .optional(),
    number: z.coerce.number().int().positive().optional(),
    full: z.boolean().default(false),
  })
  .refine((b) => b.target || (b.repo && b.number), {
    message: 'provide target ("owner/repo#123") or repo + number',
  });

const listQuery = z.object({
  repo: z.string().optional(),
  pr: z.coerce.number().int().positive().optional(),
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.date().optional(),
});

function reviewSummary(r: ReviewRow) {
  return {
    id: r.id,
    repo: r.repoFullName,
    prNumber: r.prNumber,
    prTitle: r.prTitle,
    status: r.status,
    statusReason: r.statusReason,
    mode: r.mode,
    trigger: r.trigger,
    headSha: r.headSha,
    fromSha: r.fromSha,
    findings: { critical: 0, high: 0, medium: 0, low: 0, ...(r.counts ?? {}) },
    findingsCount: r.findingsCount,
    costMicros: r.costMicros,
    durationMs: r.durationMs,
    billedTo: r.billedTo,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  };
}

function findingView(f: FindingRow) {
  return {
    id: f.id,
    localId: f.localId,
    path: f.path,
    line: f.line,
    endLine: f.endLine,
    originalLine: f.originalLine,
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
    githubCommentId: f.githubCommentId,
    open: f.open,
    resolvedInReviewId: f.resolvedInReviewId,
    dismissedReason: f.dismissedReason,
  };
}

/** Console API (`/v1/*`): API key (scope `review`) or INTERNAL_TOKEN + X-Org-Id. */
export function apiRoutes(deps: RouteDeps) {
  const app = new Hono<AuthEnv>();
  app.use('*', authMiddleware(deps.core, { product: 'review', internalToken: deps.internalToken }));
  const { store } = deps;

  const repoForOrg = async (orgId: string, fullName: string) => {
    const repo = await store.findRepoForOrg(orgId, fullName);
    if (!repo)
      throw new AppError('not_found', `Repository ${fullName} is not connected to this organization`);
    return repo;
  };

  // ------------------------------------------------------------ installations

  app.get('/installations', async (c) => {
    const { orgId } = getAuth(c);
    const [installs, repoRows] = await Promise.all([
      store.listInstallationsForOrg(orgId),
      store.listReposForOrg(orgId),
    ]);
    return c.json({
      installations: installs.map((i) => ({
        id: i.id,
        account: i.accountLogin,
        accountType: i.accountType,
        status: i.status,
        linkedAt: i.linkedAt,
        repos: repoRows
          .filter((r) => r.repo.installationId === i.id)
          .map((r) => ({
            id: r.repo.id,
            fullName: r.repo.fullName,
            private: r.repo.private,
            active: r.repo.active,
          })),
      })),
    });
  });

  /** A signed state token (and install URL) that links the installation back to this org. */
  app.get('/installations/install-url', (c) => {
    const { orgId } = getAuth(c);
    const { state, expiresAt } = deps.linkSigner.issue(orgId);
    const slug = deps.github?.slug;
    return c.json({
      state,
      expiresAt,
      url: slug
        ? `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`
        : null,
      configured: Boolean(deps.github),
    });
  });

  app.post('/installations/link', async (c) => {
    const { orgId } = getAuth(c);
    const body = await parseJson(c, linkBody);
    const state = deps.linkSigner.verify(body.state);
    if (!state) throw new AppError('bad_request', 'Invalid or expired setup state token');
    if (state.orgId !== orgId)
      throw new AppError('forbidden', 'This setup state token was issued to a different organization');
    const inst = await linkInstallation(
      { store, github: deps.github },
      { installationId: body.installationId, orgId, oauthCode: body.code },
      { linkWindowMs: deps.linkWindowMs, now: deps.now },
    );
    return c.json({
      installation: { id: inst.id, account: inst.accountLogin, status: inst.status, linkedAt: inst.linkedAt },
    });
  });

  app.delete('/installations/:id', async (c) => {
    const { orgId } = getAuth(c);
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id)) throw new AppError('bad_request', 'Invalid installation id');
    await store.unlinkInstallation(id, orgId);
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ repos

  app.get('/repos', async (c) => {
    const { orgId } = getAuth(c);
    const rows = await store.listReposForOrg(orgId);
    return c.json({
      repos: rows.map((r) => ({
        id: r.repo.id,
        fullName: r.repo.fullName,
        private: r.repo.private,
        active: r.repo.active && r.installationStatus === 'active',
        installationId: r.repo.installationId,
        settings: r.settings ?? null,
      })),
    });
  });

  app.get('/repos/:owner/:name/settings', async (c) => {
    const { orgId } = getAuth(c);
    const repo = await repoForOrg(orgId, `${c.req.param('owner')}/${c.req.param('name')}`);
    return c.json({
      repo: repo.fullName,
      settings: (await store.getRepoSettings(repo.id)) ?? {},
      defaults: DEFAULT_CONFIG,
    });
  });

  app.put('/repos/:owner/:name/settings', async (c) => {
    const auth = getAuth(c);
    const repo = await repoForOrg(auth.orgId, `${c.req.param('owner')}/${c.req.param('name')}`);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new AppError('bad_request', 'Body must be valid JSON');
    }
    const settings = validateOverride(body);
    await store.setRepoSettings(repo.id, settings, auth.apiKey?.id ?? auth.via);
    return c.json({ repo: repo.fullName, settings });
  });

  // ---------------------------------------------------------------- reviews

  app.get('/reviews', async (c) => {
    const { orgId } = getAuth(c);
    const q = listQuery.parse(c.req.query());
    const rows = await store.listReviewsForOrg(orgId, {
      repo: q.repo,
      prNumber: q.pr,
      status: q.status,
      limit: q.limit,
      before: q.before,
    });
    return c.json({ reviews: rows.map(reviewSummary) });
  });

  app.get('/reviews/:id', async (c) => {
    const { orgId } = getAuth(c);
    const review = await store.getReviewForOrg(orgId, c.req.param('id'));
    if (!review) throw new AppError('not_found', 'Review not found');
    const findings = await store.findingsForReview(review.id);
    return c.json({
      review: {
        ...reviewSummary(review),
        stats: review.stats,
        error: review.error,
        configError: review.configError,
        models: review.models,
        githubReviewId: review.githubReviewId,
      },
      // Every candidate, including the ones the Critic rejected and why.
      findings: findings.map(findingView),
    });
  });

  app.post('/reviews/run', async (c) => {
    const { orgId } = getAuth(c);
    const body = await parseJson(c, runBody);
    const [fullName, num] = body.target ? body.target.split('#') : [body.repo!, String(body.number)];
    const repo = await repoForOrg(orgId, fullName!);
    if (!deps.github) return c.json(notConfigured, 503);
    const inst = await store.getInstallation(repo.installationId);
    if (inst?.status !== 'active')
      throw new AppError('conflict', 'The GitHub App installation for this repository is not active');
    const [owner, name] = repo.fullName.split('/');
    const job: ReviewJobPayload = {
      installationId: repo.installationId,
      repoId: repo.id,
      owner: owner!,
      repo: name!,
      number: Number(num),
      trigger: 'api',
      mode: body.full ? 'full' : 'auto',
      requestedBy: getAuth(c).apiKey?.id ?? 'console',
    };
    const key = reviewJobKey(job);
    const queued = deps.queue.enqueue(key, job);
    return c.json({ queued, key, repo: repo.fullName, number: job.number, mode: job.mode }, 202);
  });

  app.get('/usage', async (c) => {
    const { orgId } = getAuth(c);
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [installs, usage] = await Promise.all([
      store.listInstallationsForOrg(orgId),
      store.usageForOrg(orgId, since),
    ]);
    return c.json({ period: currentPeriod(now), installations: installs.length, ...usage });
  });

  return app;
}
