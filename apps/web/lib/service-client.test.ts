import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildUrl, createServiceClient, parseErrorBody, ServiceError } from './service-client';

const bases = {
  gateway: 'http://gw.test',
  agents: 'http://agents.test/',
  safe: 'http://safe.test/prefix',
  review: 'http://review.test',
};

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {}));
}

describe('buildUrl', () => {
  it('joins paths and drops empty query values', () => {
    expect(buildUrl('http://gw.test', '/v1/usage', { group_by: 'model', from: undefined, to: '' })).toBe(
      'http://gw.test/v1/usage?group_by=model',
    );
    expect(buildUrl('http://agents.test/', 'v1/agents')).toBe('http://agents.test/v1/agents');
  });

  it('keeps a path prefix on the base URL', () => {
    expect(buildUrl('http://safe.test/prefix', '/v1/checks', { limit: 5 })).toBe(
      'http://safe.test/prefix/v1/checks?limit=5',
    );
  });
});

describe('parseErrorBody', () => {
  it('reads the platform error envelope', () => {
    expect(parseErrorBody(402, '{"error":{"code":"payment_required","message":"Top up"}}')).toEqual({
      code: 'payment_required',
      message: 'Top up',
      details: undefined,
    });
  });

  it('falls back to the raw text', () => {
    expect(parseErrorBody(502, 'Bad Gateway')).toEqual({ code: 'http_502', message: 'Bad Gateway' });
    expect(parseErrorBody(500, '')).toEqual({ code: 'http_500', message: 'HTTP 500' });
  });
});

describe('createServiceClient', () => {
  it('authenticates as the platform with the org header', async () => {
    const fetch = fakeFetch(() => Response.json({ ok: true }));
    const client = createServiceClient({
      bases,
      internalToken: 'secret-token-1234567',
      timeoutMs: 1000,
      fetch,
    });
    await client.json('gateway', '/v1/wallet', { orgId: 'org_1' });
    const [url, init] = fetch.mock.calls[0]!;
    const headers = new Headers(init!.headers);
    expect(String(url)).toBe('http://gw.test/v1/wallet');
    expect(headers.get('authorization')).toBe('Bearer secret-token-1234567');
    expect(headers.get('x-org-id')).toBe('org_1');
    expect(init!.method).toBe('GET');
  });

  it('never sends the token on public calls', async () => {
    const fetch = fakeFetch(() => Response.json({ data: [] }));
    const client = createServiceClient({
      bases,
      internalToken: 'secret-token-1234567',
      timeoutMs: 1000,
      fetch,
    });
    await client.json('gateway', '/v1/models', { auth: false, headers: { 'x-forwarded-for': '1.2.3.4' } });
    const headers = new Headers(fetch.mock.calls[0]![1]!.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-org-id')).toBeNull();
    expect(headers.get('x-forwarded-for')).toBe('1.2.3.4');
  });

  it('refuses authenticated calls without an org', async () => {
    const client = createServiceClient({
      bases,
      internalToken: 't'.repeat(20),
      timeoutMs: 1000,
      fetch: fakeFetch(() => Response.json({})),
    });
    await expect(client.json('gateway', '/v1/wallet')).rejects.toThrow(/orgId is required/);
  });

  it('sends JSON bodies as POST by default', async () => {
    const fetch = fakeFetch(() => Response.json({ id: 'top_1' }, { status: 201 }));
    const client = createServiceClient({ bases, internalToken: 't'.repeat(20), timeoutMs: 1000, fetch });
    const res = await client.json<{ id: string }>('gateway', '/v1/wallet/topups', {
      orgId: 'org_1',
      body: { amountVnd: 200000 },
    });
    const init = fetch.mock.calls[0]![1]!;
    expect(res.id).toBe('top_1');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"amountVnd":200000}');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
  });

  it('maps HTTP errors to ServiceError with the service code', async () => {
    const fetch = fakeFetch(() =>
      Response.json(
        { error: { code: 'unavailable', message: 'Bank transfer top-ups are not configured yet' } },
        { status: 503 },
      ),
    );
    const client = createServiceClient({ bases, internalToken: 't'.repeat(20), timeoutMs: 1000, fetch });
    const res = await client.attempt('gateway', '/v1/wallet/topups', {
      orgId: 'o',
      method: 'POST',
      body: {},
    });
    expect(res).toEqual({
      ok: false,
      error: {
        service: 'gateway',
        kind: 'http',
        status: 503,
        code: 'unavailable',
        message: 'Bank transfer top-ups are not configured yet',
        details: undefined,
      },
    });
  });

  it('reports a down service without throwing from attempt()', async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:4100') });
    });
    const client = createServiceClient({ bases, internalToken: 't'.repeat(20), timeoutMs: 1000, fetch });
    const res = await client.attempt('agents', '/v1/agents', { orgId: 'o' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe('down');
      expect(res.error.code).toBe('unreachable');
      expect(res.error.status).toBe(0);
      expect(String(res.error.details)).toContain('ECONNREFUSED');
    }
    await expect(client.json('agents', '/v1/agents', { orgId: 'o' })).rejects.toBeInstanceOf(ServiceError);
  });

  describe('against a real socket', () => {
    let server: Server;
    let base: string;
    beforeAll(async () => {
      server = createServer((req, res) => {
        if (req.url === '/slow') return void setTimeout(() => res.end('{}'), 500);
        if (req.url === '/bad-json') return void res.end('not json');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ path: req.url, org: req.headers['x-org-id'] ?? null }));
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('round-trips JSON', async () => {
      const client = createServiceClient({
        bases: { ...bases, review: base },
        internalToken: 't'.repeat(20),
        timeoutMs: 1000,
      });
      expect(await client.json('review', '/v1/reviews', { orgId: 'org_9', query: { limit: 2 } })).toEqual({
        path: '/v1/reviews?limit=2',
        org: 'org_9',
      });
    });

    it('times out slow services', async () => {
      const client = createServiceClient({
        bases: { ...bases, review: base },
        internalToken: 't'.repeat(20),
        timeoutMs: 100,
      });
      const res = await client.attempt('review', '/slow', { orgId: 'o' });
      expect(res.ok ? null : res.error.kind).toBe('timeout');
    });

    it('flags invalid JSON', async () => {
      const client = createServiceClient({
        bases: { ...bases, review: base },
        internalToken: 't'.repeat(20),
        timeoutMs: 1000,
      });
      const res = await client.attempt('review', '/bad-json', { orgId: 'o' });
      expect(res.ok ? null : res.error.code).toBe('bad_response');
    });

    it('reports a closed port as down', async () => {
      const client = createServiceClient({
        bases: { ...bases, review: 'http://127.0.0.1:1' },
        internalToken: 't'.repeat(20),
        timeoutMs: 1000,
      });
      const res = await client.attempt('review', '/health', { auth: false });
      expect(res.ok ? null : res.error.kind).toBe('down');
    });
  });
});
