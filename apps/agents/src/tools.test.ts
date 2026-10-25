import { createHmac } from 'node:crypto';
import { AppError } from '@ok/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentRow } from './db/schema';
import { defineIntegration, INTEGRATIONS, IntegrationCatalog, toolBuilder } from './integrations';
import type { SafeFetchOptions } from './lib/ssrf';
import { hostAllowed, safeFetch } from './lib/ssrf';
import type { InlineDriver } from './runtime/drivers/inline';
import { createTestPlatform, type TestPlatform } from './test/helpers';

let t: TestPlatform;
const safeCalls: { url: string; opts: SafeFetchOptions }[] = [];

beforeAll(async () => {
  t = await createTestPlatform({
    // Real SSRF checks (DNS answers are faked), but no real network: public hosts get a canned response.
    safeFetch: async (url, opts) => {
      safeCalls.push({ url, opts });
      const host = new URL(url).hostname;
      if (!hostAllowed(host, opts.allowedHosts))
        throw new AppError('forbidden', `Host ${host} is not in this agent's allowlist`);
      if (host.endsWith('.test-public')) {
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{"ok":true}'),
          truncated: false,
          url,
          redirects: 0,
        };
      }
      return safeFetch(url, { ...opts, lookup: async () => [{ address: '10.0.0.7', family: 4 }] });
    },
  });
});
afterAll(() => t.close());

const agentRow = (id: string) => t.platform.agents.get(t.org.id, id);

describe('http_request tool', () => {
  it('requires an allowlist, enforces methods and blocks private destinations', async () => {
    const a = await t.createAgent({ name: 'Http', integrations: { http: { enabled: true } } });
    let agent = await agentRow(a.id);
    const noList = await t.platform.tools.execute(
      agent,
      'http_request',
      { url: 'https://api.test-public/x' },
      { source: 'inline' },
    );
    expect(noList.error).toMatch(/no allowed hosts/);

    await t.request('PUT', `/v1/agents/${a.id}/integrations/http`, {
      config: { allowedHosts: ['api.test-public', 'intranet.example.com'], allowedMethods: ['GET', 'POST'] },
      tools: { http_request: 'auto' },
    });
    agent = await agentRow(a.id);
    const ok = await t.platform.tools.execute(
      agent,
      'http_request',
      { url: 'https://api.test-public/products?q=ao' },
      { source: 'inline' },
    );
    expect(ok).toMatchObject({ ok: true, result: { status: 200, body: '{"ok":true}' } });
    expect(safeCalls.at(-1)!.opts.allowedHosts).toEqual(['api.test-public', 'intranet.example.com']);

    const internal = await t.platform.tools.execute(
      agent,
      'http_request',
      { url: 'https://intranet.example.com/admin' },
      { source: 'inline' },
    );
    expect(internal).toMatchObject({ ok: false });
    expect(internal.error).toMatch(/non-public address 10\.0\.0\.7/);
    const notAllowed = await t.platform.tools.execute(
      agent,
      'http_request',
      { url: 'https://evil.test-public/' },
      { source: 'inline' },
    );
    expect(notAllowed.error).toMatch(/not in this agent's allowlist/);
    const del = await t.platform.tools.execute(
      agent,
      'http_request',
      { url: 'https://api.test-public/x', method: 'DELETE' },
      { source: 'inline' },
    );
    expect(del.error).toMatch(/Method DELETE is not allowed/);
  });

  it('escalates non-GET requests to owner approval by default', async () => {
    const a = await t.createAgent({
      name: 'Http2',
      integrations: {
        http: {
          enabled: true,
          config: { allowedHosts: ['api.test-public'], allowedMethods: ['GET', 'POST'] },
        },
      },
    });
    const agent = await agentRow(a.id);
    const get = await t.platform.tools.execute(
      agent,
      'http_request',
      { url: 'https://api.test-public/x' },
      { source: 'inline' },
    );
    expect(get.outcome).toBe('executed');
    const post = await t.platform.tools.execute(
      agent,
      'http_request',
      { url: 'https://api.test-public/x', method: 'POST', body: { a: 1 } },
      { source: 'inline' },
    );
    expect(post.outcome).toBe('pending_approval');
  });
});

describe('send_webhook tool', () => {
  it('posts a signed event to the owner-configured URL only', async () => {
    const a = await t.createAgent({ name: 'Hook' });
    await t.request('PUT', `/v1/agents/${a.id}/integrations/webhook`, {
      config: { url: 'https://hooks.test-public/lead' },
      credentials: { signingSecret: 'whsec-test-123' },
      tools: { send_webhook: 'auto' },
    });
    const agent = await agentRow(a.id);
    const res = await t.platform.tools.execute(
      agent,
      'send_webhook',
      { event: 'lead.created', payload: { name: 'An', phone: '0901234567' } },
      { source: 'inline' },
    );
    expect(res).toMatchObject({ ok: true, result: { delivered: true, status: 200 } });
    const call = safeCalls.at(-1)!;
    expect(call.url).toBe('https://hooks.test-public/lead');
    expect(call.opts.maxRedirects).toBe(0);
    const headers = call.opts.headers!;
    const expected = createHmac('sha256', 'whsec-test-123')
      .update(`${headers['x-ok-timestamp']}.${call.opts.body}`)
      .digest('hex');
    expect(headers['x-ok-signature']).toBe(`sha256=${expected}`);
    expect(JSON.parse(String(call.opts.body))).toMatchObject({
      event: 'lead.created',
      payload: { name: 'An' },
      agentId: a.id,
    });
  });
});

describe('tool execution guards', () => {
  it('times out slow tools and reports disabled/unknown tools', async () => {
    const slowIntegration = defineIntegration({
      id: 'slow',
      name: 'Slow',
      category: 'developer',
      description: 'test',
      verified: true,
      status: 'available',
      authSchema: z.object({}),
      tools: [
        toolBuilder()({
          name: 'slow_tool',
          description: 'never finishes',
          args: z.object({}),
          risk: 'read',
          timeoutMs: 50,
          handler: () => new Promise(() => {}),
        }),
      ],
    });
    const local = await createTestPlatform({
      catalog: new IntegrationCatalog([...INTEGRATIONS, slowIntegration]),
    });
    try {
      const a = await local.createAgent({ name: 'Slowpoke' }, false);
      const agent: AgentRow = {
        ...(await local.platform.agents.get(local.org.id, a.id)),
        integrations: { slow: { enabled: true, config: {} } },
      };
      const started = Date.now();
      const res = await local.platform.tools.execute(agent, 'slow_tool', {}, { source: 'inline' });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(res).toMatchObject({ ok: false, outcome: 'error' });
      expect(res.error).toMatch(/timed out/);
      expect(
        await local.platform.tools.execute(agent, 'no_such_tool', {}, { source: 'inline' }),
      ).toMatchObject({ ok: false, outcome: 'denied' });
      expect(
        await local.platform.tools.execute(agent, 'kiotviet_search_products', {}, { source: 'inline' }),
      ).toMatchObject({ ok: false, outcome: 'denied' });
    } finally {
      await local.close();
    }
  });
});

describe('boot reconcile (inline driver)', () => {
  it('re-creates running agents after a control-plane restart', async () => {
    const a = await t.createAgent({ name: 'Survivor' });
    // Simulate a restart: the in-memory runtime is gone.
    await (t.platform.driver as InlineDriver).remove(a.id);
    expect((await t.platform.driver.status(a.id)).state).toBe('missing');
    const actions = await t.platform.agents.reconcile();
    expect(actions).toContainEqual({ agentId: a.id, action: 'redeployed' });
    expect((await t.platform.driver.status(a.id)).state).toBe('running');
    expect(
      (await t.request('POST', `/v1/agents/${a.id}/messages`, { message: 'còn sống không?' })).status,
    ).toBe(200);
  });
});
