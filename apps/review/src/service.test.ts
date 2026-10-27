import { type ChatRequest, MockLlm } from '@minh/llm';
import { AppError } from '@minh/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createHeuristicMockLlm } from './mock-llm';
import { REVIEWER_MARKER } from './prompts/reviewer';
import {
  createTestContext,
  INSTALLATION_ID,
  job,
  REPO,
  REPO_ID,
  seedInstallation,
  type TestContext,
} from './test/context';
import { setupHeadA, setupHeadB, setupHeadC } from './test/fixtures';

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

const reviewerCalls = (llm: MockLlm) =>
  llm.calls.filter((c) => String(c.messages[0]?.content).includes(REVIEWER_MARKER));

describe('ReviewService — full review', () => {
  it('posts one review with inline comments for verified findings and a summary, and records everything', async () => {
    ctx = await createTestContext();
    const { orgId } = await seedInstallation(ctx);
    const llm = createHeuristicMockLlm();
    ctx.setLlm(llm);
    setupHeadA(ctx.github);

    const out = await ctx.runtime.service.run(job());
    expect(out).toMatchObject({ status: 'completed', posted: 2 });
    expect(ctx.llmOrgs).toEqual([orgId]); // billed to the linked org via the gateway client

    // One reviewer call (all files fit one batch) + one critic call.
    expect(reviewerCalls(llm)).toHaveLength(1);
    expect(String(reviewerCalls(llm)[0]!.messages[1]!.content)).not.toContain('pnpm-lock.yaml (modified');

    expect(ctx.github.reviews).toHaveLength(1);
    const review = ctx.github.reviews[0]!.input;
    expect(review.event).toBe('COMMENT');
    expect(review.commitId).toBe('shaA');
    expect(review.comments.map((c) => [c.path, c.line, c.side])).toEqual(
      expect.arrayContaining([
        ['src/db/users.ts', 12, 'RIGHT'],
        ['src/util/log.ts', 4, 'RIGHT'],
      ]),
    );
    const sql = review.comments.find((c) => c.path === 'src/db/users.ts')!;
    expect(sql.body).toContain('🔴 **Critical · Security** — SQL query built by string interpolation');
    expect(sql.body).toContain('**Failure scenario:**');
    expect(sql.body).toContain('<details><summary>Why this was flagged</summary>');
    // Summary: severity table, skipped lockfile, two-pass stats incl. the rejected test-file candidate.
    expect(review.body).toContain('2 issues found');
    expect(review.body).toContain('| 🔴 Critical | 1 |');
    expect(review.body).toContain('`pnpm-lock.yaml` | lockfile');
    expect(review.body).toContain(
      '3 candidates from the Reviewer → Critic confirmed 2, plausible 0, rejected 1',
    );
    expect(review.body).toMatch(/⏱ .* · 💰 \$/);

    // Check run: in progress → completed neutral (never fails by default).
    const check = ctx.github.checkRuns[0]!;
    expect(check.updates.map((u) => u.status)).toEqual(['in_progress', 'completed']);
    expect(check.updates[1]).toMatchObject({
      conclusion: 'neutral',
      title: expect.stringContaining('2 issues found'),
    });

    // DB: review row + every finding (including the rejected one with the critic's reason).
    const row = (await ctx.runtime.store.lastCompletedReview(REPO_ID, 1))!;
    expect(row).toMatchObject({
      status: 'completed',
      mode: 'full',
      headSha: 'shaA',
      findingsCount: 2,
      billedTo: 'org',
      billedOrgId: orgId,
    });
    expect(row.counts).toEqual({ critical: 1, high: 0, medium: 1, low: 0 });
    const findings = await ctx.runtime.store.findingsForReview(row.id);
    expect(findings.map((f) => f.status).sort()).toEqual(['posted', 'posted', 'rejected']);
    const rejected = findings.find((f) => f.status === 'rejected')!;
    expect(rejected.criticReason).toContain('test/fixture');
    expect(
      findings
        .filter((f) => f.status === 'posted')
        .every((f) => f.githubCommentId && f.open && f.fingerprint.length === 32),
    ).toBe(true);
  });

  it('posts "No verified issues" when the Critic rejects everything', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx);
    ctx.setLlm(
      new MockLlm((req: ChatRequest) =>
        String(req.messages[0]?.content).includes(REVIEWER_MARKER)
          ? JSON.stringify({
              findings: [
                {
                  path: 'src/db/users.ts',
                  line: 13,
                  severity: 'high',
                  category: 'correctness',
                  title: 'Rows may be undefined',
                  body: 'b',
                  failureScenario: 's',
                  confidence: 0.7,
                },
              ],
            })
          : JSON.stringify({
              verdicts: [{ id: 'F1', verdict: 'rejected', reason: 'db.query always returns an array.' }],
            }),
      ),
    );
    setupHeadA(ctx.github);
    await ctx.runtime.service.run(job());
    const review = ctx.github.reviews[0]!.input;
    expect(review.comments).toHaveLength(0);
    expect(review.body).toContain('No verified issues (1 candidate finding rejected by the Critic).');
    expect(ctx.github.checkRuns[0]!.updates[1]).toMatchObject({ conclusion: 'success' });
  });

  it('skips drafts unless configured, but always honours explicit requests', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx);
    setupHeadA(ctx.github, 1, { draft: true });
    expect(await ctx.runtime.service.run(job())).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('draft'),
    });
    expect(ctx.github.reviews).toHaveLength(0);
    expect(ctx.llmOrgs).toHaveLength(0);

    expect(await ctx.runtime.service.run(job({ trigger: 'command' }))).toMatchObject({ status: 'completed' });

    setupHeadA(ctx.github, 2, { draft: true });
    ctx.github.setFile(REPO, 'shaA', '.minh-review.yml', 'reviewDrafts: true\n');
    expect(await ctx.runtime.service.run(job({ number: 2 }))).toMatchObject({ status: 'completed' });
  });

  it('does not review the same head twice automatically', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx);
    setupHeadA(ctx.github);
    await ctx.runtime.service.run(job());
    expect(await ctx.runtime.service.run(job({ trigger: 'reopened' }))).toMatchObject({ status: 'skipped' });
    expect(ctx.github.reviews).toHaveLength(1);
  });

  it('comments once about an invalid .minh-review.yml and reviews with defaults', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx);
    setupHeadA(ctx.github);
    ctx.github.setFile(REPO, 'shaA', '.minh-review.yml', 'maxComments: lots\n');
    await ctx.runtime.service.run(job());
    expect(ctx.github.issueComments).toHaveLength(1);
    expect(ctx.github.issueComments[0]!.body).toContain('`.minh-review.yml` is invalid — maxComments');
    expect(ctx.github.reviews[0]!.input.body).toContain('`.minh-review.yml` is invalid');
    await ctx.runtime.service.run(job({ trigger: 'command', mode: 'full' }));
    expect(ctx.github.issueComments).toHaveLength(1);
  });

  it('reads config from the base commit for fork PRs', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx);
    setupHeadA(ctx.github, 1, { headRepoFullName: 'mallory/api' });
    ctx.github.setFile(REPO, 'shaA', '.minh-review.yml', 'models:\n  reviewer: very-expensive-model\n');
    ctx.github.setFile(REPO, 'base000', '.minh-review.yml', 'models:\n  reviewer: house-model\n');
    const llm = createHeuristicMockLlm();
    ctx.setLlm(llm);
    await ctx.runtime.service.run(job());
    expect(reviewerCalls(llm)[0]!.model).toBe('house-model');
  });

  it('applies console settings overrides on top of the repo file', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx);
    setupHeadA(ctx.github);
    await ctx.runtime.store.setRepoSettings(
      REPO_ID,
      { paths: { exclude: ['src/util/**'] }, language: 'vi' },
      'test',
    );
    await ctx.runtime.service.run(job());
    const review = ctx.github.reviews[0]!.input;
    expect(review.comments.map((c) => c.path)).toEqual(['src/db/users.ts']);
    expect(review.body).toContain('Phát hiện 1 vấn đề');
    expect(review.body).toContain('bị loại bởi paths.exclude');
  });

  it('falls back to a summary-only review when GitHub rejects inline comments (422)', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx);
    setupHeadA(ctx.github);
    ctx.github.rejectInlineComments = true;
    const out = await ctx.runtime.service.run(job());
    expect(out).toMatchObject({ status: 'completed', posted: 0 });
    expect(ctx.github.reviews).toHaveLength(1);
    expect(ctx.github.reviews[0]!.input.comments).toHaveLength(0);
    expect(ctx.github.reviews[0]!.input.body).toContain('Inline comments could not be placed');
    expect(ctx.github.reviews[0]!.input.body).toContain('SQL query built by string interpolation');
  });

  it('marks the review failed and rethrows transient errors (queue retries), refunding free quota', async () => {
    ctx = await createTestContext({ platformOrgId: 'org_platform', freeReviewsPerMonth: 5 });
    await seedInstallation(ctx, { link: false });
    setupHeadA(ctx.github);
    ctx.setLlm(
      new MockLlm(() => {
        throw new AppError('upstream_error', 'gateway unavailable');
      }),
    );
    await expect(ctx.runtime.service.run(job())).rejects.toMatchObject({ code: 'upstream_error' });
    const [review] = await ctx.handle.query<{ status: string; error: string }>(
      'SELECT status, error FROM review.reviews',
    );
    expect(review).toMatchObject({ status: 'failed', error: expect.stringContaining('gateway unavailable') });
    expect(await ctx.runtime.store.getQuotaUsed(INSTALLATION_ID, new Date().toISOString().slice(0, 7))).toBe(
      0,
    );
    expect(ctx.github.checkRuns[0]!.updates.at(-1)).toMatchObject({
      status: 'completed',
      conclusion: 'neutral',
    });
  });
});

describe('ReviewService — incremental reviews', () => {
  it('reviews only new commits, does not repost known findings, resolves fixed ones, and skips no-op pushes', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx);
    const llm = createHeuristicMockLlm();
    ctx.setLlm(llm);
    setupHeadA(ctx.github);
    await ctx.runtime.service.run(job());
    expect(ctx.github.reviews[0]!.input.comments).toHaveLength(2);

    // Push B: fixes the empty catch, adds eval(), touches the users.ts hunk.
    setupHeadB(ctx.github);
    const out = await ctx.runtime.service.run(job({ trigger: 'synchronize' }));
    expect(out).toMatchObject({ status: 'completed', posted: 1 });
    const second = ctx.github.reviews[1]!.input;
    expect(second.commitId).toBe('shaB');
    // Only the new eval() finding is posted; the SQL finding (seen again) is not reposted.
    expect(second.comments.map((c) => [c.path, c.line])).toEqual([['src/util/log.ts', 11]]);
    expect(second.body).toContain('Incremental review of `shaA..shaB`');
    expect(second.body).toContain('Resolved since the last review (1)');
    expect(second.body).toContain('~~Error is silently swallowed~~');
    expect(second.body).toContain('1 earlier finding is still open');
    // The reviewer only saw hunks touched by the push (not the untouched test file).
    const prompt = String(reviewerCalls(llm)[1]!.messages[1]!.content);
    expect(prompt).toContain('Review mode: INCREMENTAL');
    expect(prompt).not.toContain('users.test.ts (added');

    const row = (await ctx.runtime.store.lastCompletedReview(REPO_ID, 1))!;
    expect(row).toMatchObject({ mode: 'incremental', fromSha: 'shaA', headSha: 'shaB' });
    const findings = await ctx.runtime.store.findingsForReview(row.id);
    expect(findings.find((f) => f.title.startsWith('SQL'))).toMatchObject({
      status: 'already_posted',
      open: false,
    });
    const open = await ctx.runtime.store.openFindings(REPO_ID, 1);
    expect(open.map((f) => f.title).sort()).toEqual([
      'Dynamic code evaluation',
      'SQL query built by string interpolation',
    ]);

    // Push C only touches the lockfile → skipped entirely: no LLM call, no comment.
    setupHeadC(ctx.github);
    const callsBefore = llm.calls.length;
    expect(await ctx.runtime.service.run(job({ trigger: 'synchronize' }))).toMatchObject({
      status: 'skipped',
      reason: 'push changes no reviewable lines',
    });
    expect(llm.calls.length).toBe(callsBefore);
    expect(ctx.github.reviews).toHaveLength(2);
  });

  it('falls back to a full review when history diverged (force-push) without duplicating comments', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx);
    setupHeadA(ctx.github);
    await ctx.runtime.service.run(job());
    setupHeadB(ctx.github);
    ctx.github.compares.set(`${REPO}:shaA...shaB`, { status: 'diverged', diff: '', truncated: false });
    await ctx.runtime.service.run(job({ trigger: 'synchronize' }));
    const second = ctx.github.reviews[1]!.input;
    expect(second.body).toContain('Full review');
    expect(second.comments.map((c) => c.line)).toEqual([11]); // only eval(); SQL already posted
    // Full-mode tracking: the swallowed-error code is gone from the file → resolved.
    expect(second.body).toContain('~~Error is silently swallowed~~');
  });

  it('never re-raises findings the team dismissed by reply or 👎', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx);
    setupHeadA(ctx.github);
    await ctx.runtime.service.run(job());
    const [sqlComment, catchComment] = ['src/db/users.ts', 'src/util/log.ts'].map(
      (p) => ctx.github.pullComments.get(`${REPO}#1`)!.find((c) => c.path === p)!,
    );
    ctx.github.reply(
      REPO,
      1,
      sqlComment!.id,
      "Won't fix — this endpoint is admin-only and ids are validated upstream.",
    );
    ctx.github.thumbsDown(REPO, 1, catchComment!.id);
    // A drive-by commenter cannot dismiss anything.
    ctx.github.reply(REPO, 1, sqlComment!.id, 'false positive lol', 'NONE', 'random-user');

    await ctx.runtime.service.run(job({ trigger: 'command', mode: 'full' }));
    const second = ctx.github.reviews[1]!.input;
    expect(second.comments).toHaveLength(0);
    expect(await ctx.runtime.store.listSuppressions(REPO_ID)).toHaveLength(2);
    const row = (await ctx.runtime.store.lastCompletedReview(REPO_ID, 1))!;
    const statuses = (await ctx.runtime.store.findingsForReview(row.id)).map((f) => f.status);
    expect(statuses.filter((s) => s === 'suppressed')).toHaveLength(2);
  });
});

describe('ReviewService — billing', () => {
  it('bills unlinked installations to the platform org within the free quota, then asks them to link', async () => {
    ctx = await createTestContext({ platformOrgId: 'org_platform', freeReviewsPerMonth: 1 });
    await seedInstallation(ctx, { link: false });
    setupHeadA(ctx.github, 1);
    setupHeadA(ctx.github, 2);
    expect(await ctx.runtime.service.run(job({ number: 1 }))).toMatchObject({ status: 'completed' });
    expect(ctx.llmOrgs).toEqual(['org_platform']);

    expect(await ctx.runtime.service.run(job({ number: 2 }))).toMatchObject({ status: 'quota_exceeded' });
    expect(ctx.llmOrgs).toHaveLength(1);
    expect(ctx.github.issueComments).toHaveLength(1);
    expect(ctx.github.issueComments[0]!.body).toContain('used its 1 free reviews');
    expect(ctx.github.issueComments[0]!.body).toContain(
      `https://console.test/review/link?installation_id=${INSTALLATION_ID}`,
    );
    // A second attempt on the same PR does not repeat the comment.
    await ctx.runtime.service.run(job({ number: 2, trigger: 'command' }));
    expect(ctx.github.issueComments).toHaveLength(1);
  });

  it('asks unlinked installations to link when there is no free quota', async () => {
    ctx = await createTestContext({ platformOrgId: null });
    await seedInstallation(ctx, { link: false });
    setupHeadA(ctx.github);
    expect(await ctx.runtime.service.run(job())).toMatchObject({ status: 'not_linked' });
    expect(ctx.github.issueComments[0]!.body).toContain('not linked');
    expect(ctx.github.reviews).toHaveLength(0);
  });

  it('posts a polite comment instead of reviewing when the wallet is empty', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx, { balance: 0 });
    setupHeadA(ctx.github);
    expect(await ctx.runtime.service.run(job())).toMatchObject({ status: 'insufficient_balance' });
    expect(ctx.llmOrgs).toHaveLength(0);
    expect(ctx.github.issueComments[0]!.body).toContain('wallet balance is too low');
    expect(ctx.github.reviews).toHaveLength(0);
  });

  it('handles a 402 from the gateway mid-review without crashing', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx);
    setupHeadA(ctx.github);
    ctx.setLlm(
      new MockLlm(() => {
        throw new AppError('payment_required', 'LLM call failed (402): Insufficient balance');
      }),
    );
    expect(await ctx.runtime.service.run(job())).toMatchObject({ status: 'insufficient_balance' });
    expect(ctx.github.issueComments).toHaveLength(1);
    expect(ctx.github.reviews).toHaveLength(0);
    expect(ctx.github.checkRuns[0]!.updates.at(-1)).toMatchObject({ conclusion: 'neutral' });
  });
});
