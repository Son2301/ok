import { afterEach, describe, expect, it } from 'vitest';
import { signWebhookBody } from './github/webhook';
import {
  createTestContext,
  INSTALLATION_ID,
  INTERNAL_TOKEN,
  REPO,
  REPO_ID,
  seedInstallation,
  type TestContext,
  WEBHOOK_SECRET,
} from './test/context';
import { setupHeadA } from './test/fixtures';

let ctx: TestContext;
afterEach(async () => {
  await ctx?.close();
});

let deliveryN = 0;
function deliver(event: string, payload: unknown, opts: { secret?: string | null; delivery?: string } = {}) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': event,
    'x-github-delivery': opts.delivery ?? `d-${++deliveryN}`,
  };
  if (opts.secret !== null)
    headers['x-hub-signature-256'] = signWebhookBody(opts.secret ?? WEBHOOK_SECRET, body);
  return ctx.runtime.app.request('/github/webhook', { method: 'POST', headers, body });
}

const repository = { id: REPO_ID, name: 'api', full_name: REPO, owner: { login: 'acme' } };
const installation = { id: INSTALLATION_ID, account: { login: 'acme', type: 'Organization', id: 99 } };
const prEvent = (action: string, head = 'shaA', extra: Record<string, unknown> = {}) => ({
  action,
  pull_request: { number: 1, state: 'open', draft: false, head: { sha: head }, ...extra },
  repository,
  installation,
});

const internal = (orgId: string) => ({
  authorization: `Bearer ${INTERNAL_TOKEN}`,
  'x-org-id': orgId,
  'content-type': 'application/json',
});

describe('health + unconfigured GitHub', () => {
  it('boots and answers health without GitHub credentials; webhooks report not configured', async () => {
    ctx = await createTestContext({ githubConfigured: false });
    const health = await ctx.runtime.app.request('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, service: 'review', github: { configured: false } });
    const res = await deliver('ping', {});
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'not_configured' } });
    expect((await ctx.runtime.app.request('/nope')).status).toBe(404);
  });
});

describe('POST /github/webhook', () => {
  it('rejects missing and invalid signatures', async () => {
    ctx = await createTestContext();
    const missing = await deliver('ping', {}, { secret: null });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({
      error: { code: 'unauthorized', message: expect.stringContaining('Missing') },
    });
    const invalid = await deliver('ping', {}, { secret: 'wrong-secret' });
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toMatchObject({ error: { message: 'Invalid webhook signature' } });
    expect((await deliver('ping', { zen: 'hi' })).status).toBe(200);
  });

  it('accepts a pull_request event with 202 and the queued job posts a review', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx);
    setupHeadA(ctx.github);
    const res = await deliver('pull_request', prEvent('opened'));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true, key: `pr:${REPO_ID}#1`, queue: 'queued' });
    await ctx.runtime.queue.onIdle();
    expect(ctx.github.reviews).toHaveLength(1);
  });

  it('ignores duplicate deliveries', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx);
    setupHeadA(ctx.github);
    await deliver('pull_request', prEvent('opened'), { delivery: 'same' });
    const dup = await deliver('pull_request', prEvent('opened'), { delivery: 'same' });
    expect(await dup.json()).toMatchObject({ duplicate: true });
    await ctx.runtime.queue.onIdle();
    expect(ctx.github.reviews).toHaveLength(1);
  });

  it('coalesces rapid pushes to one PR: one run in flight plus one follow-up for the latest head', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx);
    setupHeadA(ctx.github);
    let release!: () => void;
    ctx.github.gate = new Promise<void>((r) => {
      release = r;
    });
    await deliver('pull_request', prEvent('opened'));
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await deliver('pull_request', prEvent('synchronize', 'shaX'));
    const r3 = await deliver('pull_request', prEvent('synchronize', 'shaY'));
    expect(await r2.json()).toMatchObject({ queue: 'deferred' });
    expect(await r3.json()).toMatchObject({ queue: 'deferred' });
    ctx.github.gate = null;
    release();
    await ctx.runtime.queue.onIdle();
    // getPullRequest ran exactly twice (first job + one coalesced follow-up), not three times.
    expect(ctx.github.calls.filter((c) => c === 'getPullRequest')).toHaveLength(2);
    expect(ctx.github.reviews).toHaveLength(1); // the follow-up saw the same head and skipped
  });

  it('handles /review comments: queues a full review and reacts with 👀', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx);
    setupHeadA(ctx.github);
    const res = await deliver('issue_comment', {
      action: 'created',
      issue: { number: 1, state: 'open', pull_request: {}, user: { login: 'author' } },
      comment: {
        id: 555,
        body: '/review full',
        author_association: 'COLLABORATOR',
        user: { login: 'dev', type: 'User' },
      },
      repository,
      installation,
    });
    expect(res.status).toBe(202);
    await ctx.runtime.queue.onIdle();
    expect(ctx.github.reactions).toEqual([{ repo: REPO, commentId: 555, content: 'eyes' }]);
    expect(ctx.github.reviews).toHaveLength(1);
  });

  it('skips draft PRs (job runs but does nothing) and cancels queued work on close', async () => {
    ctx = await createTestContext();
    await seedInstallation(ctx);
    setupHeadA(ctx.github, 1, { draft: true });
    expect((await deliver('pull_request', prEvent('opened', 'shaA', { draft: true }))).status).toBe(202);
    await ctx.runtime.queue.onIdle();
    expect(ctx.github.reviews).toHaveLength(0);

    const closed = await deliver('pull_request', prEvent('closed'));
    expect(await closed.json()).toMatchObject({ ok: true, cancelled: false });
    const ignored = await deliver('pull_request', prEvent('labeled'));
    expect(await ignored.json()).toMatchObject({ ignored: expect.stringContaining('labeled') });
  });

  it('records installation and installation_repositories events', async () => {
    ctx = await createTestContext();
    await deliver('installation', {
      action: 'created',
      installation,
      repositories: [{ id: 1, full_name: 'acme/one', private: true }],
    });
    expect(await ctx.runtime.store.getInstallation(INSTALLATION_ID)).toMatchObject({
      accountLogin: 'acme',
      status: 'active',
      orgId: null,
    });
    expect(await ctx.runtime.store.getRepo(1)).toMatchObject({ fullName: 'acme/one', active: true });

    await deliver('installation_repositories', {
      action: 'added',
      installation,
      repositories_added: [{ id: 2, full_name: 'acme/two', private: false }],
      repositories_removed: [{ id: 1, full_name: 'acme/one' }],
    });
    expect(await ctx.runtime.store.getRepo(2)).toMatchObject({ active: true });
    expect(await ctx.runtime.store.getRepo(1)).toMatchObject({ active: false });

    await deliver('installation', { action: 'suspend', installation });
    expect((await ctx.runtime.store.getInstallation(INSTALLATION_ID))?.status).toBe('suspended');
    await deliver('installation', { action: 'deleted', installation });
    expect((await ctx.runtime.store.getInstallation(INSTALLATION_ID))?.status).toBe('deleted');
  });
});

describe('installation linking', () => {
  it('links via the GitHub setup callback with a valid state and redirects to the console', async () => {
    ctx = await createTestContext();
    const org = await ctx.core.createOrg('Acme', 1_000_000);
    await deliver('installation', { action: 'created', installation, repositories: [] });
    const { state } = ctx.runtime.linkSigner.issue(org.id);
    const res = await ctx.runtime.app.request(
      `/github/setup?installation_id=${INSTALLATION_ID}&setup_action=install&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://console.test/review?linked=${INSTALLATION_ID}`);
    expect((await ctx.runtime.store.getInstallation(INSTALLATION_ID))?.orgId).toBe(org.id);

    const bad = await ctx.runtime.app.request(
      `/github/setup?installation_id=${INSTALLATION_ID}&state=v1.forged.sig`,
    );
    expect(bad.status).toBe(400);
  });

  it('refuses to link stale installations without OAuth, but accepts a verified OAuth code', async () => {
    let now = Date.now();
    ctx = await createTestContext({ now: () => now });
    const org = await ctx.core.createOrg('Acme', 1_000_000);
    await deliver('installation', { action: 'created', installation, repositories: [] });
    now += 2 * 60 * 60 * 1000; // two hours later
    const { state } = ctx.runtime.linkSigner.issue(org.id);
    const stale = await ctx.runtime.app.request(
      `/github/setup?installation_id=${INSTALLATION_ID}&state=${encodeURIComponent(state)}`,
    );
    expect(stale.status).toBe(403);

    ctx.github.oauthUsers.set('good-code', [INSTALLATION_ID]);
    const wrong = await ctx.runtime.app.request(
      `/github/setup?installation_id=${INSTALLATION_ID}&state=${encodeURIComponent(state)}&code=other`,
    );
    expect(wrong.status).toBe(403);
    const ok = await ctx.runtime.app.request(
      `/github/setup?installation_id=${INSTALLATION_ID}&state=${encodeURIComponent(state)}&code=good-code`,
    );
    expect(ok.status).toBe(302);
  });

  it('POST /v1/installations/link requires a state issued to the same org and refuses stealing', async () => {
    ctx = await createTestContext();
    const a = await ctx.core.createOrg('A', 1_000_000);
    const b = await ctx.core.createOrg('B', 1_000_000);
    await deliver('installation', {
      action: 'created',
      installation,
      repositories: [{ id: REPO_ID, full_name: REPO, private: true }],
    });
    const stateA = ctx.runtime.linkSigner.issue(a.id).state;

    const mismatch = await ctx.runtime.app.request('/v1/installations/link', {
      method: 'POST',
      headers: internal(b.id),
      body: JSON.stringify({ installationId: INSTALLATION_ID, state: stateA }),
    });
    expect(mismatch.status).toBe(403);

    const ok = await ctx.runtime.app.request('/v1/installations/link', {
      method: 'POST',
      headers: internal(a.id),
      body: JSON.stringify({ installationId: INSTALLATION_ID, state: stateA }),
    });
    expect(ok.status).toBe(200);

    const stateB = ctx.runtime.linkSigner.issue(b.id).state;
    const steal = await ctx.runtime.app.request('/v1/installations/link', {
      method: 'POST',
      headers: internal(b.id),
      body: JSON.stringify({ installationId: INSTALLATION_ID, state: stateB }),
    });
    expect(steal.status).toBe(409);

    const list = await ctx.runtime.app.request('/v1/installations', { headers: internal(a.id) });
    expect(await list.json()).toMatchObject({
      installations: [{ id: INSTALLATION_ID, account: 'acme', repos: [{ id: REPO_ID, fullName: REPO }] }],
    });
    const url = await ctx.runtime.app.request('/v1/installations/install-url', { headers: internal(a.id) });
    expect(await url.json()).toMatchObject({
      url: expect.stringContaining('https://github.com/apps/minh-review/installations/new?state=v1.'),
    });
  });
});

describe('console API', () => {
  it('requires auth, enforces the review scope and accepts internal calls', async () => {
    ctx = await createTestContext();
    const { orgId } = await seedInstallation(ctx);
    expect((await ctx.runtime.app.request('/v1/reviews')).status).toBe(401);
    const { key: safeOnly } = await ctx.core.createApiKey(orgId!, { name: 'safe', scopes: ['safe'] });
    expect(
      (await ctx.runtime.app.request('/v1/reviews', { headers: { authorization: `Bearer ${safeOnly}` } }))
        .status,
    ).toBe(403);
    const { key } = await ctx.core.createApiKey(orgId!, { name: 'review', scopes: ['review'] });
    expect(
      (await ctx.runtime.app.request('/v1/reviews', { headers: { authorization: `Bearer ${key}` } })).status,
    ).toBe(200);
    expect((await ctx.runtime.app.request('/v1/reviews', { headers: internal(orgId!) })).status).toBe(200);
    expect(
      (await ctx.runtime.app.request('/v1/reviews', { headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
  });

  it('lists reviews and shows details incl. rejected findings, scoped to the org', async () => {
    ctx = await createTestContext();
    const { orgId } = await seedInstallation(ctx);
    const other = await ctx.core.createOrg('Other', 0);
    setupHeadA(ctx.github);
    await ctx.runtime.service.run({
      installationId: INSTALLATION_ID,
      repoId: REPO_ID,
      owner: 'acme',
      repo: 'api',
      number: 1,
      trigger: 'opened',
      mode: 'auto',
    });

    const list = (await (
      await ctx.runtime.app.request('/v1/reviews', { headers: internal(orgId!) })
    ).json()) as { reviews: Record<string, unknown>[] };
    expect(list.reviews).toHaveLength(1);
    expect(list.reviews[0]).toMatchObject({
      repo: REPO,
      prNumber: 1,
      status: 'completed',
      findings: { critical: 1, medium: 1 },
      findingsCount: 2,
    });
    const id = list.reviews[0]!.id as string;

    const detail = (await (
      await ctx.runtime.app.request(`/v1/reviews/${id}`, { headers: internal(orgId!) })
    ).json()) as {
      findings: { status: string; criticReason: string; verdict: string }[];
      review: { stats: { rejected: number } };
    };
    expect(detail.review.stats.rejected).toBe(1);
    expect(detail.findings.find((f) => f.verdict === 'rejected')).toMatchObject({
      status: 'rejected',
      criticReason: expect.any(String),
    });

    expect((await ctx.runtime.app.request(`/v1/reviews/${id}`, { headers: internal(other.id) })).status).toBe(
      404,
    );
    const otherList = (await (
      await ctx.runtime.app.request('/v1/reviews', { headers: internal(other.id) })
    ).json()) as { reviews: unknown[] };
    expect(otherList.reviews).toHaveLength(0);
    const usage = await (await ctx.runtime.app.request('/v1/usage', { headers: internal(orgId!) })).json();
    expect(usage).toMatchObject({ installations: 1, reviews: 1 });
  });

  it('stores validated per-repo settings', async () => {
    ctx = await createTestContext();
    const { orgId } = await seedInstallation(ctx);
    const put = (body: unknown) =>
      ctx.runtime.app.request(`/v1/repos/${REPO}/settings`, {
        method: 'PUT',
        headers: internal(orgId!),
        body: JSON.stringify(body),
      });
    expect((await put({ maxComments: 500 })).status).toBe(400);
    expect((await put({ severityTreshold: 'high' })).status).toBe(400);
    expect((await put({ severityThreshold: 'high', paths: { exclude: ['docs/**'] } })).status).toBe(200);
    const got = await (
      await ctx.runtime.app.request(`/v1/repos/${REPO}/settings`, { headers: internal(orgId!) })
    ).json();
    expect(got).toMatchObject({ settings: { severityThreshold: 'high', paths: { exclude: ['docs/**'] } } });
    const repos = await (await ctx.runtime.app.request('/v1/repos', { headers: internal(orgId!) })).json();
    expect(repos).toMatchObject({
      repos: [{ fullName: REPO, active: true, settings: { severityThreshold: 'high' } }],
    });
    const other = await ctx.core.createOrg('Other', 0);
    expect(
      (await ctx.runtime.app.request(`/v1/repos/${REPO}/settings`, { headers: internal(other.id) })).status,
    ).toBe(404);
  });

  it('POST /v1/reviews/run queues a review for owner/repo#number of the org only', async () => {
    ctx = await createTestContext();
    const { orgId } = await seedInstallation(ctx);
    setupHeadA(ctx.github);
    const run = await ctx.runtime.app.request('/v1/reviews/run', {
      method: 'POST',
      headers: internal(orgId!),
      body: JSON.stringify({ target: `${REPO}#1`, full: true }),
    });
    expect(run.status).toBe(202);
    expect(await run.json()).toMatchObject({ queued: 'queued', key: `pr:${REPO_ID}#1`, mode: 'full' });
    await ctx.runtime.queue.onIdle();
    expect(ctx.github.reviews).toHaveLength(1);

    const other = await ctx.core.createOrg('Other', 0);
    const denied = await ctx.runtime.app.request('/v1/reviews/run', {
      method: 'POST',
      headers: internal(other.id),
      body: JSON.stringify({ repo: REPO, number: 1 }),
    });
    expect(denied.status).toBe(404);
    const invalid = await ctx.runtime.app.request('/v1/reviews/run', {
      method: 'POST',
      headers: internal(orgId!),
      body: JSON.stringify({ target: 'nope' }),
    });
    expect(invalid.status).toBe(400);
  });
});
