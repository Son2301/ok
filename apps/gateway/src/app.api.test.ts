// biome-ignore-all lint/suspicious/noExplicitAny: end-to-end assertions over untyped JSON response bodies
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createDb, type DbHandle } from '@ok/db';
import { createLlmClient } from '@ok/llm';
import { newId } from '@ok/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogModel } from './catalog/types';
import { type NewRequestRow, requests } from './db/schema';
import {
  createHarness,
  endpoint,
  get,
  type Harness,
  json,
  MockUpstream,
  oaiChunks,
  oaiCompletion,
  openaiProvider,
  post,
  sse,
  TEST_INTERNAL_TOKEN,
} from './test/helpers';

let handle: DbHandle;
let up: MockUpstream;
let h: Harness;

const MODELS: CatalogModel[] = [
  { id: 'test/chat', name: 'Chat', type: 'chat', endpoints: [endpoint('alpha', [1, 2])] },
  { id: 'test/other', name: 'Other', type: 'chat', endpoints: [endpoint('alpha', [4, 8])] },
  { id: 'test/disabled', name: 'Disabled', type: 'chat', endpoints: [endpoint('offline', [1, 1])] },
  {
    id: 'test/embed',
    name: 'Embed',
    type: 'embedding',
    endpoints: [
      endpoint('alpha', [0.1, 0], {
        upstreamModel: 'emb-up',
        capabilities: { tools: false, vision: false, json: false, streaming: false },
      }),
    ],
  },
  {
    id: 'mock/embed',
    name: 'Mock embed',
    type: 'embedding',
    endpoints: [endpoint('mock', [0.02, 0], { upstreamModel: 'embed' })],
  },
];

beforeAll(async () => {
  handle = await createDb('memory://');
  up = await MockUpstream.start();
});
afterAll(async () => {
  await up.close();
  await handle.close();
});
beforeEach(async () => {
  up.reset((_r, res) => json(res, 200, oaiCompletion('ok', { prompt_tokens: 100, completion_tokens: 50 })));
  h = await createHarness({
    handle,
    models: MODELS,
    providers: [
      openaiProvider('alpha', `${up.url}/v1`),
      openaiProvider('offline', 'http://127.0.0.1:9/v1', { enabled: false }),
    ],
  });
});

const chatBody = (model = 'test/chat') => ({ model, messages: [{ role: 'user', content: 'hello' }] });

describe('auth', () => {
  it('rejects missing/invalid keys (401) and keys not scoped to gateway (403)', async () => {
    const { key: safeKey } = await h.account(1_000_000, ['safe']);
    expect((await h.app.request('/v1/chat/completions', { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await post(h.app, '/v1/chat/completions', 'sk-ok-not-a-real-key', chatBody())).status).toBe(401);
    expect((await post(h.app, '/v1/chat/completions', 'random-token', chatBody())).status).toBe(401);
    const forbidden = await post(h.app, '/v1/chat/completions', safeKey, chatBody());
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as any).error.code).toBe('forbidden');
    for (const path of ['/v1/requests', '/v1/usage', '/v1/providers/health', '/v1/generation/gen_x']) {
      expect((await h.app.request(path)).status).toBe(401);
    }
    expect(up.calls).toHaveLength(0);
  });

  it('accepts the internal token with X-Org-Id and attributes usage to X-OK-Product', async () => {
    const { orgId, key } = await h.account(1_000_000);
    expect((await post(h.app, '/v1/chat/completions', TEST_INTERNAL_TOKEN, chatBody())).status).toBe(400); // missing X-Org-Id
    const res = await post(h.app, '/v1/chat/completions', TEST_INTERNAL_TOKEN, chatBody(), {
      'x-org-id': orgId,
      'x-ok-product': 'agents',
    });
    expect(res.status).toBe(200);
    const id = ((await res.json()) as any).id;
    const [entry] = await h.core.listWalletEntries(orgId, { product: 'agents' });
    expect(entry).toMatchObject({ ref: id, product: 'agents', apiKeyId: null });
    const detail = (await (await get(h.app, `/v1/generation/${id}`, key)).json()) as any;
    expect(detail.data).toMatchObject({ product: 'agents', api_key_id: null });

    // API-key callers cannot re-attribute usage
    const viaKey = (await (
      await post(h.app, '/v1/chat/completions', key, chatBody(), { 'x-ok-product': 'agents' })
    ).json()) as any;
    expect(((await (await get(h.app, `/v1/generation/${viaKey.id}`, key)).json()) as any).data.product).toBe(
      'gateway',
    );
  });
});

describe('public endpoints', () => {
  it('GET /health', async () => {
    const res = await h.app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'ok',
      service: 'gateway',
      providers_enabled: ['alpha'],
    });
  });

  it('GET /v1/models lists available models with pricing per 1M tokens, capabilities and providers (no auth)', async () => {
    const res = await h.app.request('/v1/models');
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const ids = body.data.map((m: any) => m.id);
    expect(ids.slice(0, 3)).toEqual(['auto', 'auto:cheap', 'auto:best']);
    expect(ids).toContain('test/chat');
    expect(ids).not.toContain('test/disabled');
    const chat = body.data.find((m: any) => m.id === 'test/chat');
    expect(chat).toMatchObject({
      object: 'model',
      name: 'Chat',
      context_length: 100_000,
      pricing: { prompt: 1, completion: 2, unit: 'USD per 1M tokens' },
      capabilities: { tools: true, vision: true, json: true, streaming: true },
      providers: [
        { provider: 'alpha', pricing: { prompt: 1, completion: 2 }, enabled: true, verified: false },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('cost'); // upstream cost is never exposed

    const all = (await (await h.app.request('/v1/models?include_disabled=true')).json()) as any;
    expect(all.data.find((m: any) => m.id === 'test/disabled')).toMatchObject({ available: false });
    const emb = (await (await h.app.request('/v1/models?type=embedding')).json()) as any;
    expect(emb.data.map((m: any) => m.id)).toEqual(['test/embed', 'mock/embed']);
  });
});

describe('POST /v1/embeddings', () => {
  it('routes to an OpenAI-compatible provider, bills prompt tokens and logs the request', async () => {
    const { key, orgId } = await h.account(1_000_000);
    up.reset((_r, res) =>
      json(res, 200, {
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.5, -0.5] }],
        model: 'emb-up',
        usage: { prompt_tokens: 1000, total_tokens: 1000 },
      }),
    );
    const res = await post(h.app, '/v1/embeddings', key, { model: 'test/embed', input: ['a', 'b'] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({
      object: 'list',
      model: 'test/embed',
      provider: 'alpha',
      data: [{ embedding: [0.5, -0.5] }],
      usage: { prompt_tokens: 1000, cost_micros: 100 },
    });
    expect(up.calls[0]!.url).toBe('/v1/embeddings');
    expect(up.calls[0]!.body).toEqual({ model: 'emb-up', input: ['a', 'b'] });
    expect(await h.core.getBalance(orgId)).toBe(1_000_000 - 100);
    const detail = (await (await get(h.app, `/v1/generation/${body.id}`, key)).json()) as any;
    expect(detail.data).toMatchObject({
      kind: 'embeddings',
      status: 'success',
      usage: { prompt_tokens: 1000, completion_tokens: 0 },
    });
  });

  it('serves deterministic mock embeddings offline and rejects chat models', async () => {
    const { key } = await h.account();
    const a = (await (
      await post(h.app, '/v1/embeddings', key, { model: 'mock/embed', input: 'xin chào', dimensions: 8 })
    ).json()) as any;
    const b = (await (
      await post(h.app, '/v1/embeddings', key, { model: 'mock/embed', input: 'xin chào', dimensions: 8 })
    ).json()) as any;
    expect(a.data[0].embedding).toHaveLength(8);
    expect(a.data[0].embedding).toEqual(b.data[0].embedding);
    expect((await post(h.app, '/v1/embeddings', key, { model: 'test/chat', input: 'x' })).status).toBe(400);
  });
});

describe('GET /v1/generation/:id', () => {
  it('returns details for the caller org only', async () => {
    const a = await h.account();
    const b = await h.account();
    const id = ((await (await post(h.app, '/v1/chat/completions', a.key, chatBody())).json()) as any).id;
    const res = await get(h.app, `/v1/generation/${id}`, a.key);
    expect(res.status).toBe(200);
    const d = ((await res.json()) as any).data;
    expect(d).toMatchObject({
      id,
      object: 'generation',
      model: 'test/chat',
      provider: 'alpha',
      status: 'success',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, estimated: false },
      cost_micros: 200,
      cost_usd: 0.0002,
      fallback_count: 0,
      attempts: [{ provider: 'alpha', status: 'success' }],
    });
    expect(typeof d.latency_ms).toBe('number');
    expect(d).not.toHaveProperty('upstream_cost_micros');
    expect((await get(h.app, `/v1/generation/${id}`, b.key)).status).toBe(404);
    expect((await get(h.app, `/v1/generation?id=${id}`, a.key)).status).toBe(200);
  });
});

function seedRow(orgId: string, over: Partial<NewRequestRow>): NewRequestRow {
  return {
    id: newId('gen'),
    orgId,
    apiKeyId: 'key_a',
    product: 'gateway',
    kind: 'chat',
    requestedModel: 'test/chat',
    model: 'test/chat',
    provider: 'alpha',
    status: 'success',
    promptTokens: 10,
    completionTokens: 5,
    costMicros: 100,
    upstreamCostMicros: 50,
    latencyMs: 200,
    attempts: [],
    stream: false,
    createdAt: new Date('2026-01-01T10:00:00Z'),
    ...over,
  };
}

describe('GET /v1/usage', () => {
  it('aggregates the caller org by day (zero-filled), model, provider, key and product', async () => {
    const { orgId, key } = await h.account();
    const other = await h.account();
    await h.handle.db.insert(requests).values([
      seedRow(orgId, { createdAt: new Date('2026-01-01T01:00:00Z') }),
      seedRow(orgId, {
        createdAt: new Date('2026-01-01T23:59:00Z'),
        model: 'test/other',
        costMicros: 400,
        latencyMs: 400,
      }),
      seedRow(orgId, {
        createdAt: new Date('2026-01-03T12:00:00Z'),
        provider: 'beta',
        apiKeyId: null,
        product: 'agents',
        status: 'error',
        promptTokens: 0,
        completionTokens: 0,
        costMicros: 0,
      }),
      seedRow(orgId, { createdAt: new Date('2026-01-05T00:00:00Z') }), // outside the range
      seedRow(other.orgId, { createdAt: new Date('2026-01-02T00:00:00Z'), costMicros: 9_999 }),
    ]);

    const day = (await (
      await get(h.app, '/v1/usage?from=2026-01-01&to=2026-01-03&group_by=day', key)
    ).json()) as any;
    expect(day).toMatchObject({
      object: 'usage',
      group_by: 'day',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-04T00:00:00.000Z',
    });
    expect(day.data.map((d: any) => [d.key, d.requests, d.cost_micros])).toEqual([
      ['2026-01-01', 2, 500],
      ['2026-01-02', 0, 0],
      ['2026-01-03', 1, 0],
    ]);
    expect(day.data[0]).toMatchObject({
      prompt_tokens: 20,
      completion_tokens: 10,
      errors: 0,
      avg_latency_ms: 300,
    });
    expect(day.totals).toEqual({
      requests: 3,
      errors: 1,
      prompt_tokens: 20,
      completion_tokens: 10,
      cost_micros: 500,
      cost_usd: 0.0005,
    });

    const q = async (group: string) =>
      (
        (await (
          await get(h.app, `/v1/usage?from=2026-01-01&to=2026-01-03&group_by=${group}`, key)
        ).json()) as any
      ).data.map((d: any) => [d.key, d.requests]);
    expect(await q('model')).toEqual([
      ['test/other', 1],
      ['test/chat', 2],
    ]);
    expect(await q('provider')).toEqual(
      expect.arrayContaining([
        ['alpha', 2],
        ['beta', 1],
      ]),
    );
    expect(await q('key')).toEqual(
      expect.arrayContaining([
        ['key_a', 2],
        ['internal', 1],
      ]),
    );
    expect(await q('product')).toEqual(
      expect.arrayContaining([
        ['gateway', 2],
        ['agents', 1],
      ]),
    );
  });

  it('defaults to the last 30 days and validates parameters', async () => {
    const { key } = await h.account();
    await post(h.app, '/v1/chat/completions', key, chatBody());
    const body = (await (await get(h.app, '/v1/usage', key)).json()) as any;
    expect(body.data).toHaveLength(31);
    expect(body.totals.requests).toBe(1);
    expect((await get(h.app, '/v1/usage?group_by=week', key)).status).toBe(400);
    expect((await get(h.app, '/v1/usage?from=2026-02-01&to=2026-01-01', key)).status).toBe(400);
    expect((await get(h.app, '/v1/usage?from=garbage', key)).status).toBe(400);
    expect((await get(h.app, '/v1/usage?from=2024-01-01&to=2026-01-01', key)).status).toBe(400);
  });
});

describe('GET /v1/requests', () => {
  it('pages newest-first with an opaque cursor, scoped to the org', async () => {
    const { orgId, key } = await h.account();
    const other = await h.account();
    const rows = Array.from({ length: 5 }, (_, i) =>
      seedRow(orgId, { createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) }),
    );
    await h.handle.db.insert(requests).values([...rows, seedRow(other.orgId, {})]);
    const newestFirst = [...rows].reverse().map((r) => r.id);

    const p1 = (await (await get(h.app, '/v1/requests?limit=2', key)).json()) as any;
    expect(p1.data.map((r: any) => r.id)).toEqual(newestFirst.slice(0, 2));
    expect(p1.data[0]).toMatchObject({
      object: 'generation',
      model: 'test/chat',
      status: 'success',
      cost_micros: 100,
    });
    expect(p1.data[0]).not.toHaveProperty('upstream_cost_micros');
    const p2 = (await (await get(h.app, `/v1/requests?limit=2&cursor=${p1.next_cursor}`, key)).json()) as any;
    expect(p2.data.map((r: any) => r.id)).toEqual(newestFirst.slice(2, 4));
    const p3 = (await (await get(h.app, `/v1/requests?limit=2&cursor=${p2.next_cursor}`, key)).json()) as any;
    expect(p3.data.map((r: any) => r.id)).toEqual(newestFirst.slice(4));
    expect(p3.next_cursor).toBeNull();

    expect((await get(h.app, '/v1/requests?cursor=not-a-cursor', key)).status).toBe(400);
    expect((await get(h.app, '/v1/requests?limit=1000', key)).status).toBe(400);
  });

  it('filters by status', async () => {
    const { orgId, key } = await h.account();
    await h.handle.db.insert(requests).values([seedRow(orgId, { status: 'error' }), seedRow(orgId, {})]);
    const body = (await (await get(h.app, '/v1/requests?status=error', key)).json()) as any;
    expect(body.data.map((r: any) => r.status)).toEqual(['error']);
  });
});

describe('GET /v1/providers/health', () => {
  it('reports live per-endpoint health and provider configuration', async () => {
    const { key } = await h.account();
    await post(h.app, '/v1/chat/completions', key, chatBody());
    up.reset((_r, res) => json(res, 503, { error: { message: 'down' } }));
    await post(h.app, '/v1/chat/completions', key, chatBody());
    const body = (await (await get(h.app, '/v1/providers/health', key)).json()) as any;
    const ep = body.data.find((e: any) => e.endpoint === 'test/chat@alpha');
    expect(ep).toMatchObject({
      provider: 'alpha',
      model: 'test/chat',
      circuit: 'closed',
      requests: 2,
      successes: 1,
      failures: 1,
      success_rate: 0.5,
      consecutive_failures: 1,
      last_error: { kind: 'server' },
    });
    expect(typeof ep.p50_latency_ms).toBe('number');
    expect(body.data.some((e: any) => e.endpoint === 'test/disabled@offline')).toBe(false);
    expect(body.providers).toEqual(
      expect.arrayContaining([
        { id: 'alpha', name: 'alpha', kind: 'openai-compatible', enabled: true, verified: false },
      ]),
    );
  });
});

describe('platform products calling through @ok/llm over real HTTP', () => {
  it('createLlmClient with the internal token: chat + stream, billed to the calling product', async () => {
    const { orgId } = await h.account(1_000_000);
    up.reset((r, res) =>
      r.body.stream
        ? sse(res, oaiChunks(['streamed ', 'reply'], { prompt_tokens: 10, completion_tokens: 2 }))
        : json(res, 200, oaiCompletion('plain reply', { prompt_tokens: 10, completion_tokens: 2 })),
    );
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: h.app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const llm = createLlmClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: TEST_INTERNAL_TOKEN,
        headers: { 'x-org-id': orgId, 'x-ok-product': 'safe' },
      });
      const res = await llm.chat({
        model: 'test/chat',
        messages: [{ role: 'user', content: 'is this a scam?' }],
      });
      expect(res).toMatchObject({ provider: 'alpha', usage: { cost_micros: 10 + 4 } });
      expect(res.choices[0]!.message.content).toBe('plain reply');

      let text = '';
      let usage: unknown;
      for await (const chunk of llm.stream({
        model: 'test/chat',
        messages: [{ role: 'user', content: 'again' }],
      })) {
        text += chunk.choices[0]?.delta.content ?? '';
        if (chunk.usage) usage = chunk.usage;
      }
      expect(text).toBe('streamed reply');
      expect(usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 2, cost_micros: 14 });

      const entries = await h.core.listWalletEntries(orgId, { product: 'safe' });
      expect(entries).toHaveLength(2);
      await expect(
        llm.chat({ model: 'nope/none', messages: [{ role: 'user', content: 'x' }] }),
      ).rejects.toThrow(/404/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
