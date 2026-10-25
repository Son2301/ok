import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff } from '../diff/parse';
import { createGitHubApp, normalizePrivateKey, synthesizeDiff } from './octokit';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, // GitHub hands out PKCS#1 keys
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(
  routes: (req: Recorded) => { status?: number; json?: unknown; text?: string; type?: string },
) {
  const requests: Recorded[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const req: Recorded = {
      method: (init.method ?? 'GET').toUpperCase(),
      url: String(input),
      headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(req);
    const r = routes(req);
    const body = r.text ?? JSON.stringify(r.json ?? {});
    return new Response(body, {
      status: r.status ?? 200,
      headers: { 'content-type': r.type ?? 'application/json; charset=utf-8' },
    });
  };
  return { fetch: fn as typeof fetch, requests };
}

const prJson = {
  number: 1,
  title: 'Fix',
  body: 'desc',
  state: 'open',
  draft: false,
  merged: false,
  html_url: 'https://github.com/acme/api/pull/1',
  user: { login: 'dev' },
  head: { sha: 'h1', ref: 'feat', repo: { full_name: 'dev/api' } },
  base: { sha: 'b1', ref: 'main', repo: { full_name: 'acme/api' } },
};

function routes(req: Recorded) {
  const path = new URL(req.url).pathname;
  if (req.method === 'POST' && path === '/app/installations/7/access_tokens') {
    return {
      status: 201,
      json: {
        token: 'ghs_installation',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: {},
        repository_selection: 'all',
      },
    };
  }
  if (path === '/repos/acme/api/pulls/1') {
    if (req.headers.accept?.includes('diff'))
      return { text: 'diff --git a/x b/x\n', type: 'application/vnd.github.v3.diff; charset=utf-8' };
    return { json: prJson };
  }
  if (path === '/repos/acme/api/pulls/2')
    return { status: 406, json: { message: 'Sorry, the diff exceeded the maximum number of files' } };
  if (path === '/repos/acme/api/pulls/2/files') {
    return {
      json: [
        { filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
        { filename: 'img.png', status: 'added' },
      ],
    };
  }
  if (req.method === 'POST' && path === '/repos/acme/api/pulls/1/reviews') return { json: { id: 321 } };
  if (path.startsWith('/repos/acme/api/contents/')) return { status: 404, json: { message: 'Not Found' } };
  if (path.startsWith('/repos/acme/api/compare/')) return { status: 404, json: { message: 'Not Found' } };
  if (path === '/app/installations/7')
    return {
      json: {
        id: 7,
        created_at: '2026-01-01T00:00:00Z',
        account: { login: 'acme', type: 'Organization', id: 99 },
      },
    };
  if (path === '/app/installations/8') return { status: 404, json: { message: 'Not Found' } };
  return { status: 500, json: { message: `unexpected ${req.method} ${path}` } };
}

function verifyJwt(token: string) {
  const [h, p, s] = token.split('.');
  const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s!, 'base64url'));
  return {
    ok,
    header: JSON.parse(Buffer.from(h!, 'base64url').toString()),
    payload: JSON.parse(Buffer.from(p!, 'base64url').toString()),
  };
}

describe('GitHub App adapter (Octokit, offline)', () => {
  it('signs an RS256 app JWT, caches the installation token and maps PR data', async () => {
    const f = fakeFetch(routes);
    const app = createGitHubApp({
      appId: 12345,
      privateKey: privateKey.replace(/\n/g, '\\n'),
      fetch: f.fetch,
      slug: 'ok-review',
    });
    const gh = app.installation(7);

    const pr = await gh.getPullRequest('acme', 'api', 1);
    expect(pr).toMatchObject({
      number: 1,
      headSha: 'h1',
      baseSha: 'b1',
      headRepoFullName: 'dev/api',
      baseRepoFullName: 'acme/api',
      authorLogin: 'dev',
      draft: false,
    });
    expect(await gh.getPullRequestDiff('acme', 'api', 1)).toBe('diff --git a/x b/x\n');

    const tokenCalls = f.requests.filter((r) => r.url.endsWith('/access_tokens'));
    expect(tokenCalls).toHaveLength(1); // cached for the second call
    const jwt = verifyJwt(tokenCalls[0]!.headers.authorization!.replace(/^bearer /i, ''));
    expect(jwt.ok).toBe(true);
    expect(jwt.header.alg).toBe('RS256');
    expect(String(jwt.payload.iss)).toBe('12345');
    expect(jwt.payload.exp - jwt.payload.iat).toBeLessThanOrEqual(600);

    const apiCalls = f.requests.filter((r) => r.url.includes('/repos/'));
    expect(apiCalls.every((r) => r.headers.authorization === 'token ghs_installation')).toBe(true);
    expect(apiCalls[1]!.headers.accept).toContain('diff');
  });

  it('builds review requests and maps 404s to null', async () => {
    const f = fakeFetch(routes);
    const gh = createGitHubApp({ appId: 1, privateKey, fetch: f.fetch }).installation(7);
    const { id } = await gh.createReview('acme', 'api', 1, {
      commitId: 'h1',
      body: 'summary',
      event: 'COMMENT',
      comments: [{ path: 'a.ts', line: 5, side: 'RIGHT', start_line: 3, start_side: 'RIGHT', body: 'x' }],
    });
    expect(id).toBe(321);
    const post = f.requests.find((r) => r.method === 'POST' && r.url.endsWith('/pulls/1/reviews'))!;
    expect(post.body).toEqual({
      commit_id: 'h1',
      body: 'summary',
      event: 'COMMENT',
      comments: [{ path: 'a.ts', line: 5, side: 'RIGHT', start_line: 3, start_side: 'RIGHT', body: 'x' }],
    });
    expect(await gh.getFileContent('acme', 'api', '.okreview.yml', 'h1')).toBeNull();
    expect(await gh.compareCommits('acme', 'api', 'gone', 'h1')).toBeNull();
  });

  it('rebuilds the diff from the file list when GitHub refuses a too-large diff (406)', async () => {
    const f = fakeFetch(routes);
    const gh = createGitHubApp({ appId: 1, privateKey, fetch: f.fetch }).installation(7);
    const diff = await gh.getPullRequestDiff('acme', 'api', 2);
    const files = parseUnifiedDiff(diff);
    expect(files.map((x) => [x.path, x.status, x.binary])).toEqual([
      ['src/a.ts', 'modified', false],
      ['img.png', 'added', true],
    ]);
  });

  it('looks up installations with the app JWT', async () => {
    const f = fakeFetch(routes);
    const app = createGitHubApp({ appId: 1, privateKey, fetch: f.fetch });
    expect(await app.getInstallation(7)).toEqual({
      id: 7,
      accountLogin: 'acme',
      accountType: 'Organization',
      accountId: 99,
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(await app.getInstallation(8)).toBeNull();
    expect(f.requests[0]!.headers.authorization).toMatch(/^bearer /i);
    expect(app.userCanAccessInstallation).toBeUndefined(); // no OAuth client configured
  });
});

describe('helpers', () => {
  it('normalizes private keys from env formats', () => {
    expect(normalizePrivateKey(privateKey.replace(/\n/g, '\\n'))).toBe(privateKey.trim());
    expect(normalizePrivateKey(Buffer.from(privateKey).toString('base64'))).toBe(privateKey.trim());
  });

  it('synthesizes parseable diffs for added, removed, renamed and binary files', () => {
    const diff = synthesizeDiff([
      { filename: 'new.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+x' },
      { filename: 'old.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-x' },
      { filename: 'b.ts', previous_filename: 'a.ts', status: 'renamed' },
      { filename: 'c.ts', previous_filename: 'd.ts', status: 'renamed', patch: '@@ -1 +1 @@\n-1\n+2' },
      { filename: 'logo.png', status: 'modified' },
    ]);
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => [f.path, f.status, f.oldPath, f.binary, f.hunks.length])).toEqual([
      ['new.ts', 'added', null, false, 1],
      ['old.ts', 'deleted', 'old.ts', false, 1],
      ['b.ts', 'renamed', 'a.ts', false, 0],
      ['c.ts', 'renamed', 'd.ts', false, 1],
      ['logo.png', 'modified', 'logo.png', true, 0],
    ]);
    expect(synthesizeDiff([])).toBe('');
  });
});
