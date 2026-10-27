import { describe, expect, it } from 'vitest';
import {
  mergeReviewJobs,
  parseReviewCommand,
  type ReviewJobPayload,
  routeEvent,
  signWebhookBody,
  verifyWebhookSignature,
} from './webhook';

describe('verifyWebhookSignature', () => {
  const secret = 'shhh-its-a-secret';
  const body = JSON.stringify({ action: 'opened', n: 1 });

  it('accepts a valid signature over the raw body (string or bytes)', () => {
    const sig = signWebhookBody(secret, body);
    expect(verifyWebhookSignature(secret, body, sig)).toBe(true);
    expect(
      verifyWebhookSignature(secret, Buffer.from(body), sig.toUpperCase().replace('SHA256=', 'sha256=')),
    ).toBe(true);
  });

  it('rejects invalid, tampered, malformed and missing signatures', () => {
    const sig = signWebhookBody(secret, body);
    expect(verifyWebhookSignature(secret, `${body} `, sig)).toBe(false);
    expect(verifyWebhookSignature('other-secret', body, sig)).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, '')).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'sha1=abc')).toBe(false);
    expect(verifyWebhookSignature(secret, body, `sha256=${'z'.repeat(64)}`)).toBe(false);
    expect(verifyWebhookSignature(secret, body, sig.slice(0, -2))).toBe(false);
    expect(verifyWebhookSignature('', body, sig)).toBe(false);
  });
});

describe('parseReviewCommand', () => {
  it.each([
    ['/review', { full: false }],
    ['/review full', { full: true }],
    ['  /REVIEW  ', { full: false }],
    ['Thanks!\n/review full\nplease', { full: true }],
    ['@minh-review review', { full: false }],
    ['@minh-review[bot] review full', { full: true }],
    ['/reviewer', null],
    ['please /review', null],
    ['> /review', null],
    ['```\n/review\n```', null],
    ['@someone-else review', null],
  ])('%j → %j', (body, expected) => {
    expect(parseReviewCommand(body, 'minh-review')).toEqual(expected);
  });
});

const repository = { id: 42, name: 'api', full_name: 'acme/api', owner: { login: 'acme' } };
const installation = { id: 7, account: { login: 'acme', type: 'Organization', id: 99 } };
const pr = (over: Record<string, unknown> = {}) => ({
  number: 5,
  state: 'open',
  draft: false,
  head: { sha: 'abc' },
  ...over,
});

describe('routeEvent', () => {
  it('routes reviewable pull_request actions to review jobs', () => {
    for (const action of ['opened', 'reopened', 'synchronize', 'ready_for_review']) {
      const r = routeEvent(
        'pull_request',
        { action, pull_request: pr(), repository, installation },
        { appSlug: 'minh-review' },
      );
      expect(r).toEqual({
        kind: 'review',
        draft: false,
        job: {
          installationId: 7,
          repoId: 42,
          owner: 'acme',
          repo: 'api',
          number: 5,
          trigger: action,
          mode: 'auto',
          headSha: 'abc',
        },
      });
    }
  });

  it('flags drafts, cancels on close and ignores other actions', () => {
    const draft = routeEvent(
      'pull_request',
      { action: 'opened', pull_request: pr({ draft: true }), repository, installation },
      { appSlug: null },
    );
    expect(draft).toMatchObject({ kind: 'review', draft: true });
    expect(
      routeEvent(
        'pull_request',
        { action: 'closed', pull_request: pr(), repository, installation },
        { appSlug: null },
      ),
    ).toEqual({
      kind: 'cancel',
      repoId: 42,
      number: 5,
    });
    expect(
      routeEvent(
        'pull_request',
        { action: 'labeled', pull_request: pr(), repository, installation },
        { appSlug: null },
      ).kind,
    ).toBe('ignore');
    expect(
      routeEvent('pull_request', { action: 'opened', pull_request: pr(), repository }, { appSlug: null })
        .kind,
    ).toBe('ignore');
  });

  const comment = (over: Record<string, unknown> = {}, issueOver: Record<string, unknown> = {}) => ({
    action: 'created',
    issue: { number: 5, state: 'open', pull_request: { url: 'x' }, user: { login: 'author' }, ...issueOver },
    comment: {
      id: 900,
      body: '/review full',
      author_association: 'MEMBER',
      user: { login: 'maintainer', type: 'User' },
      ...over,
    },
    repository,
    installation,
  });

  it('turns /review comments from trusted users into review jobs', () => {
    expect(routeEvent('issue_comment', comment(), { appSlug: 'minh-review' })).toEqual({
      kind: 'review',
      draft: false,
      job: {
        installationId: 7,
        repoId: 42,
        owner: 'acme',
        repo: 'api',
        number: 5,
        trigger: 'command',
        mode: 'full',
        commentId: 900,
        requestedBy: 'maintainer',
      },
    });
    // PR author may always ask, even without repo membership.
    const byAuthor = routeEvent(
      'issue_comment',
      comment({
        author_association: 'CONTRIBUTOR',
        user: { login: 'author', type: 'User' },
        body: '@minh-review review',
      }),
      {
        appSlug: 'minh-review',
      },
    );
    expect(byAuthor).toMatchObject({ kind: 'review', job: { mode: 'auto' } });
  });

  it('ignores comments from bots, strangers, non-PR issues, edits and non-commands', () => {
    const slug = { appSlug: 'minh-review' };
    expect(
      routeEvent('issue_comment', comment({ user: { login: 'minh-review[bot]', type: 'Bot' } }), slug).kind,
    ).toBe('ignore');
    expect(
      routeEvent(
        'issue_comment',
        comment({ author_association: 'NONE', user: { login: 'drive-by', type: 'User' } }),
        slug,
      ),
    ).toMatchObject({
      kind: 'ignore',
      reason: expect.stringContaining('may not request'),
    });
    expect(routeEvent('issue_comment', comment({}, { pull_request: undefined }), slug).kind).toBe('ignore');
    expect(routeEvent('issue_comment', { ...comment(), action: 'edited' }, slug).kind).toBe('ignore');
    expect(routeEvent('issue_comment', comment({ body: 'LGTM' }), slug).kind).toBe('ignore');
    expect(routeEvent('issue_comment', comment({}, { state: 'closed' }), slug).kind).toBe('ignore');
  });

  it('parses installation and installation_repositories events', () => {
    const created = routeEvent(
      'installation',
      {
        action: 'created',
        installation,
        repositories: [{ id: 1, full_name: 'acme/a', private: true }, { bogus: true }],
      },
      { appSlug: null },
    );
    expect(created).toEqual({
      kind: 'installation',
      action: 'created',
      installation: { id: 7, accountLogin: 'acme', accountType: 'Organization', accountId: 99 },
      repositories: [{ id: 1, fullName: 'acme/a', private: true }],
    });
    const repos = routeEvent(
      'installation_repositories',
      {
        action: 'added',
        installation,
        repositories_added: [{ id: 2, full_name: 'acme/b', private: false }],
        repositories_removed: [],
      },
      { appSlug: null },
    );
    expect(repos).toMatchObject({
      kind: 'installation_repositories',
      added: [{ id: 2, fullName: 'acme/b' }],
      removed: [],
    });
    expect(routeEvent('ping', {}, { appSlug: null })).toEqual({ kind: 'ping' });
    expect(routeEvent('star', {}, { appSlug: null }).kind).toBe('ignore');
  });
});

describe('mergeReviewJobs', () => {
  const job = (over: Partial<ReviewJobPayload>): ReviewJobPayload => ({
    installationId: 1,
    repoId: 2,
    owner: 'o',
    repo: 'r',
    number: 3,
    trigger: 'synchronize',
    mode: 'auto',
    ...over,
  });
  it('keeps the newest head, sticky full mode and explicit triggers', () => {
    const merged = mergeReviewJobs(
      job({ trigger: 'command', mode: 'full', commentId: 9, headSha: 'a' }),
      job({ headSha: 'b' }),
    );
    expect(merged).toMatchObject({ trigger: 'command', mode: 'full', commentId: 9, headSha: 'b' });
    expect(
      mergeReviewJobs(job({ headSha: 'a' }), job({ headSha: 'c', trigger: 'synchronize' })),
    ).toMatchObject({ mode: 'auto', headSha: 'c' });
  });
});
