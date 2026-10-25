// biome-ignore-all lint/suspicious/noExplicitAny: end-to-end assertions over untyped JSON response bodies
import { createDb, type DbHandle } from '@ok/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogModel } from './catalog/types';
import { type RequestRow, requests } from './db/schema';
import type { ProviderSpec } from './providers/config';
import {
  createHarness,
  endpoint,
  type Harness,
  hang,
  json,
  MockUpstream,
  oaiChunks,
  oaiCompletion,
  openaiProvider,
  post,
  readSseBody,
  sse,
  waitFor,
} from './test/helpers';

let handle: DbHandle;
let upA: MockUpstream;
let upB: MockUpstream;
let upC: MockUpstream;
let h: Harness;

const MODELS = (): CatalogModel[] => [
  {
    id: 'test/primary',
    name: 'Primary',
    type: 'chat',
    auto: { tiers: ['balanced'], quality: 70 },
    endpoints: [endpoint('alpha', [1, 2]), endpoint('beta', [2, 4])],
  },
  { id: 'test/secondary', name: 'Secondary', type: 'chat', endpoints: [endpoint('gamma', [3, 6])] },
  {
    id: 'test/novision',
    name: 'No vision',
    type: 'chat',
    endpoints: [
      endpoint('alpha', [1, 1], {
        capabilities: { tools: true, vision: false, json: true, streaming: true },
      }),
    ],
  },
  {
    id: 'test/fast',
    name: 'Fast',
    type: 'chat',
    auto: { tiers: ['fast'], quality: 50 },
    endpoints: [endpoint('gamma', [0.1, 0.2])],
  },
  {
    id: 'test/reasoner',
    name: 'Reasoner',
    type: 'chat',
    auto: { tiers: ['reasoning'], quality: 90, strengths: ['math'] },
    endpoints: [endpoint('beta', [5, 10])],
  },
  {
    id: 'mock/echo',
    name: 'Echo',
    type: 'chat',
    endpoints: [endpoint('mock', [1, 2], { upstreamModel: 'echo' })],
  },
  {
    id: 'test/claude',
    name: 'Claude',
    type: 'chat',
    endpoints: [endpoint('anth', [3, 15], { upstreamModel: 'claude-x' })],
  },
  {
    id: 'test/gemini',
    name: 'Gemini',
    type: 'chat',
    endpoints: [endpoint('gem', [1, 4], { upstreamModel: 'gemini-x' })],
  },
];

const ok =
  (
    content = 'hello',
    usage: { prompt_tokens: number; completion_tokens: number } | null = {
      prompt_tokens: 1000,
      completion_tokens: 500,
    },
  ) =>
  (_r: unknown, res: import('node:http').ServerResponse) =>
    json(res, 200, oaiCompletion(content, usage));
const fail =
  (status: number, message = `upstream ${status}`, headers: Record<string, string> = {}) =>
  (_r: unknown, res: import('node:http').ServerResponse) =>
    json(res, status, { error: { message, type: 'x' } }, headers);

const chat = (body: Record<string, unknown> = {}) => ({
  model: 'test/primary',
  messages: [{ role: 'user', content: 'Say hi' }],
  ...body,
});

async function row(id: string): Promise<RequestRow> {
  return waitFor(async () => (await h.handle.db.select().from(requests).where(eq(requests.id, id)))[0]);
}

beforeAll(async () => {
  handle = await createDb('memory://');
  [upA, upB, upC] = await Promise.all([MockUpstream.start(), MockUpstream.start(), MockUpstream.start()]);
});
afterAll(async () => {
  await Promise.all([upA.close(), upB.close(), upC.close()]);
  await handle.close();
});
const PROVIDERS = (): ProviderSpec[] => [
  openaiProvider('alpha', `${upA.url}/v1`),
  openaiProvider('beta', `${upB.url}/v1`),
  openaiProvider('gamma', `${upC.url}/v1`),
  {
    id: 'anth',
    name: 'anth',
    kind: 'anthropic',
    baseUrl: upC.url,
    apiKey: 'sk-ant',
    apiVersion: '2023-06-01',
    enabled: true,
    verified: false,
  },
  {
    id: 'gem',
    name: 'gem',
    kind: 'google',
    baseUrl: `${upC.url}/v1beta`,
    apiKey: 'gem-key',
    enabled: true,
    verified: false,
  },
];

beforeEach(async () => {
  for (const up of [upA, upB, upC]) up.reset(fail(500, 'unexpected call'));
  h = await createHarness({
    handle,
    models: MODELS(),
    providers: PROVIDERS(),
    config: { upstreamTimeoutMs: 400, firstByteTimeoutMs: 400, streamIdleTimeoutMs: 400 },
  });
});

describe('POST /v1/chat/completions (non-streaming)', () => {
  it('routes to the cheapest healthy endpoint, returns provider + cost, debits the wallet and logs the request', async () => {
    const { key, keyId, orgId } = await h.account(5_000_000);
    upA.reset(ok('hi there'));
    const res = await post(
      h.app,
      '/v1/chat/completions',
      key,
      chat({
        models: ['test/secondary'],
        provider: { sort: 'price' },
        metadata: { trace: 'x' },
        temperature: 0.2,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body).toMatchObject({
      object: 'chat.completion',
      model: 'test/primary',
      provider: 'alpha',
      choices: [{ message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 500,
        total_tokens: 1500,
        cost_micros: 1000 * 1 + 500 * 2,
      },
    });
    expect(body.id).toMatch(/^gen_/);
    expect(res.headers.get('x-generation-id')).toBe(body.id);

    // upstream saw the upstream model name, its own key, and no gateway-only fields
    const sent = upA.calls[0]!;
    expect(sent.body).toMatchObject({
      model: 'alpha-upstream',
      temperature: 0.2,
      messages: [{ role: 'user', content: 'Say hi' }],
    });
    expect(sent.body).not.toHaveProperty('models');
    expect(sent.body).not.toHaveProperty('provider');
    expect(sent.body).not.toHaveProperty('metadata');
    expect(sent.headers.authorization).toBe('Bearer key-alpha');
    expect(upB.calls).toHaveLength(0);

    expect(await h.core.getBalance(orgId)).toBe(5_000_000 - 2_000);
    const [entry] = await h.core.listWalletEntries(orgId, { product: 'gateway' });
    expect(entry).toMatchObject({ amountMicros: -2_000, ref: body.id, apiKeyId: keyId, kind: 'usage' });

    const r = await row(body.id);
    expect(r).toMatchObject({
      orgId,
      apiKeyId: keyId,
      product: 'gateway',
      kind: 'chat',
      requestedModel: 'test/primary',
      model: 'test/primary',
      provider: 'alpha',
      status: 'success',
      promptTokens: 1000,
      completionTokens: 500,
      usageEstimated: false,
      costMicros: 2000,
      upstreamCostMicros: 1000 * 0.5 + 500 * 1,
      stream: false,
      finishReason: 'stop',
    });
    expect(r.attempts).toEqual([
      expect.objectContaining({ provider: 'alpha', status: 'success', endpoint: 'test/primary@alpha' }),
    ]);
    expect(r.routing).toMatchObject({
      requested_model: 'test/primary',
      models: ['test/primary', 'test/secondary'],
      sort: 'price',
    });
    expect(JSON.stringify(r)).not.toContain('Say hi'); // prompts are never stored
  });

  it('estimates usage (~chars/4) and flags it when the upstream reports none', async () => {
    const { key } = await h.account();
    upA.reset(ok('x'.repeat(400), null));
    const body = (await (await post(h.app, '/v1/chat/completions', key, chat())).json()) as Record<
      string,
      any
    >;
    expect(body.usage).toMatchObject({ completion_tokens: 100, estimated: true });
    expect(body.usage.prompt_tokens).toBeGreaterThan(0);
    expect((await row(body.id)).usageEstimated).toBe(true);
  });

  it('refuses with 402 before calling upstream when the wallet is empty', async () => {
    const { key } = await h.account(0);
    upA.reset(ok());
    const res = await post(h.app, '/v1/chat/completions', key, chat());
    expect(res.status).toBe(402);
    expect(((await res.json()) as any).error.code).toBe('payment_required');
    expect(upA.calls).toHaveLength(0);
  });

  it('validates the body', async () => {
    const { key } = await h.account();
    expect(
      (await post(h.app, '/v1/chat/completions', key, { model: 'test/primary', messages: [] })).status,
    ).toBe(400);
    expect(
      (await post(h.app, '/v1/chat/completions', key, { messages: [{ role: 'user', content: 'x' }] })).status,
    ).toBe(400);
    expect((await post(h.app, '/v1/chat/completions', key, chat({ n: 2 }))).status).toBe(400);
    const notFound = await post(h.app, '/v1/chat/completions', key, chat({ model: 'nope/none' }));
    expect(notFound.status).toBe(404);
  });

  it('rejects requests no endpoint can serve (capability inferred from image parts)', async () => {
    const { key } = await h.account();
    const res = await post(h.app, '/v1/chat/completions', key, {
      model: 'test/novision',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is it' },
            { type: 'image_url', image_url: { url: 'https://x/y.png' } },
          ],
        },
      ],
    });
    expect(res.status).toBe(400);
    const err = ((await res.json()) as any).error;
    expect(err.details.routing.skipped[0].reason).toMatch(/image/);
    expect(upA.calls).toHaveLength(0);
  });

  it('honors provider.order / only / ignore', async () => {
    const { key } = await h.account();
    upA.reset(ok('from a'));
    upB.reset(ok('from b'));
    const ordered = (await (
      await post(h.app, '/v1/chat/completions', key, chat({ provider: { order: ['beta'] } }))
    ).json()) as any;
    expect(ordered.provider).toBe('beta');
    const only = (await (
      await post(h.app, '/v1/chat/completions', key, chat({ provider: { only: ['beta'] } }))
    ).json()) as any;
    expect(only.provider).toBe('beta');
    const ignore = (await (
      await post(h.app, '/v1/chat/completions', key, chat({ provider: { ignore: ['alpha'] } }))
    ).json()) as any;
    expect(ignore.provider).toBe('beta');
    expect(upA.calls).toHaveLength(0);
  });

  it('serves the offline mock model, including tool calls', async () => {
    const { key } = await h.account();
    const res = await post(h.app, '/v1/chat/completions', key, {
      model: 'mock/echo',
      tool_choice: 'required',
      tools: [
        { type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } },
      ],
      messages: [{ role: 'user', content: 'find it' }],
    });
    const body = (await res.json()) as any;
    expect(body.provider).toBe('mock');
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('lookup');
  });
});

describe('fallback', () => {
  it.each([
    ['500', fail(500)],
    ['503', fail(503)],
    ['429', fail(429, 'slow down', { 'retry-after': '1' })],
    ['timeout', () => hang()],
  ])('falls back to the next endpoint on %s', async (_label, handler) => {
    const { key } = await h.account();
    upA.reset(handler as never);
    upB.reset(ok('from beta'));
    const res = await post(h.app, '/v1/chat/completions', key, chat({ provider: { sort: 'price' } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.provider).toBe('beta');
    expect(body.choices[0].message.content).toBe('from beta');
    expect(body.usage.cost_micros).toBe(1000 * 2 + 500 * 4); // billed at the serving endpoint's price
    const r = await row(body.id);
    expect(r.attempts.map((a) => [a.provider, a.status])).toEqual([
      ['alpha', 'error'],
      ['beta', 'success'],
    ]);
    expect(r.attempts[0]!.error_kind).toBe(
      _label === 'timeout' ? 'timeout' : _label === '429' ? 'rate_limit' : 'server',
    );
    expect(h.health.stats('test/primary@alpha').failures).toBe(1);
  });

  it('falls back across models in models[] after all endpoints of the first fail', async () => {
    const { key } = await h.account();
    upA.reset(fail(502));
    upB.reset(fail(503));
    upC.reset(ok('from gamma'));
    const res = await post(h.app, '/v1/chat/completions', key, chat({ models: ['test/secondary'] }));
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ model: 'test/secondary', provider: 'gamma' });
    const detail = (await (
      await h.app.request(`/v1/generation/${body.id}`, { headers: { authorization: `Bearer ${key}` } })
    ).json()) as any;
    expect(detail.data.fallback_count).toBe(2);
    expect(detail.data.attempts.map((a: any) => a.endpoint)).toEqual([
      'test/primary@alpha',
      'test/primary@beta',
      'test/secondary@gamma',
    ]);
  });

  it('never retries a 400 — the client error is returned as-is', async () => {
    const { key } = await h.account();
    upA.reset(fail(400, "Invalid value for 'temperature'"));
    upB.reset(ok());
    upC.reset(ok());
    const res = await post(h.app, '/v1/chat/completions', key, chat({ models: ['test/secondary'] }));
    expect(res.status).toBe(400);
    const err = ((await res.json()) as any).error;
    expect(err.code).toBe('bad_request');
    expect(err.message).toContain("Invalid value for 'temperature'");
    expect(err.details.attempts).toHaveLength(1);
    expect(upB.calls).toHaveLength(0);
    expect(upC.calls).toHaveLength(0);
    expect(h.health.stats('test/primary@alpha').failures).toBe(0); // client errors don't hurt endpoint health
  });

  it('returns 502 with every attempt when all providers fail, and logs the failure', async () => {
    const { key, orgId } = await h.account(1_000_000);
    upA.reset(fail(500));
    upB.reset(fail(401, 'Incorrect API key provided: sk-proj-abcdefghijklmnop'));
    const res = await post(h.app, '/v1/chat/completions', key, chat());
    expect(res.status).toBe(502);
    const err = ((await res.json()) as any).error;
    expect(err.code).toBe('upstream_error');
    expect(err.details.attempts.map((a: any) => a.error_kind)).toEqual(['server', 'auth']);
    expect(JSON.stringify(err)).not.toContain('sk-proj'); // never leak upstream credential hints
    const r = await row(err.details.generation_id);
    expect(r).toMatchObject({ status: 'error', costMicros: 0 });
    expect(await h.core.getBalance(orgId)).toBe(1_000_000);
  });

  it('returns 429 when every provider is rate limited', async () => {
    const { key } = await h.account();
    upA.reset(fail(429));
    upB.reset(fail(429));
    expect((await post(h.app, '/v1/chat/completions', key, chat())).status).toBe(429);
  });

  it('opens the circuit after repeated failures and skips the endpoint', async () => {
    h = await createHarness({
      handle,
      models: MODELS(),
      providers: PROVIDERS(),
      health: { failureThreshold: 2, cooldownMs: 60_000 },
    });
    const { key } = await h.account();
    upA.reset(fail(500));
    upB.reset(ok('beta'));
    for (let i = 0; i < 2; i++)
      expect(((await (await post(h.app, '/v1/chat/completions', key, chat())).json()) as any).provider).toBe(
        'beta',
      );
    expect(upA.calls).toHaveLength(2);
    expect(h.health.stats('test/primary@alpha').circuit).toBe('open');
    const third = (await (await post(h.app, '/v1/chat/completions', key, chat())).json()) as any;
    expect(third.provider).toBe('beta');
    expect(upA.calls).toHaveLength(2); // skipped while open
  });
});

describe('streaming', () => {
  it('passes chunks through, rewrites ids/model, and ends with a usage chunk carrying cost', async () => {
    const { key, orgId } = await h.account(1_000_000);
    upA.reset((_r, res) =>
      sse(res, oaiChunks(['Hel', 'lo', '!'], { prompt_tokens: 20, completion_tokens: 3 })),
    );
    const res = await post(h.app, '/v1/chat/completions', key, chat({ stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const genId = res.headers.get('x-generation-id')!;
    const events = await readSseBody(res);
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1) as any[];
    expect(
      chunks.every(
        (c) =>
          c.id === genId &&
          c.model === 'test/primary' &&
          c.provider === 'alpha' &&
          c.object === 'chat.completion.chunk',
      ),
    ).toBe(true);
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('Hello!');
    expect(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('stop');
    const usage = chunks.at(-1);
    expect(usage.choices).toEqual([]);
    expect(usage.usage).toEqual({
      prompt_tokens: 20,
      completion_tokens: 3,
      total_tokens: 23,
      cost_micros: 20 + 6,
    });
    expect(upA.calls[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });

    const r = await row(genId);
    expect(r).toMatchObject({
      status: 'success',
      stream: true,
      promptTokens: 20,
      completionTokens: 3,
      costMicros: 26,
    });
    expect(r.ttftMs).not.toBeNull();
    expect(await h.core.getBalance(orgId)).toBe(1_000_000 - 26);
  });

  it('honors stream_options.include_usage=false but still bills', async () => {
    const { key, orgId } = await h.account(1_000_000);
    upA.reset((_r, res) => sse(res, oaiChunks(['a'], { prompt_tokens: 10, completion_tokens: 10 })));
    const events = await readSseBody(
      await post(
        h.app,
        '/v1/chat/completions',
        key,
        chat({ stream: true, stream_options: { include_usage: false } }),
      ),
    );
    expect(events.some((e: any) => e !== '[DONE]' && e.usage)).toBe(false);
    await waitFor(async () => ((await h.core.getBalance(orgId)) === 1_000_000 - 30 ? true : null));
  });

  it('falls back before the first byte: HTTP error, empty-then-dead stream, or first-byte timeout', async () => {
    const { key } = await h.account();
    upB.reset((_r, res) => sse(res, oaiChunks(['beta'])));
    const cases = [
      fail(503),
      (_r: unknown, res: import('node:http').ServerResponse) =>
        sse(res, oaiChunks(['never']).slice(0, 1), { destroyAfter: 1 }), // role chunk only, then crash
      () => hang(),
    ];
    for (const handler of cases) {
      upA.reset(handler as never);
      const res = await post(h.app, '/v1/chat/completions', key, chat({ stream: true }));
      expect(res.status).toBe(200);
      const chunks = (await readSseBody(res)).filter((e) => e !== '[DONE]') as any[];
      expect(chunks.every((c) => c.provider === 'beta')).toBe(true);
      expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('beta');
    }
  });

  it('returns a JSON error (not a stream) when every endpoint fails before the first byte', async () => {
    const { key } = await h.account();
    upA.reset(fail(500));
    upB.reset(fail(500));
    const res = await post(h.app, '/v1/chat/completions', key, chat({ stream: true }));
    expect(res.status).toBe(502);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('on a mid-stream upstream failure sends an SSE error event, usage, [DONE], and does not retry', async () => {
    const { key, orgId } = await h.account(1_000_000);
    upA.reset((_r, res) =>
      sse(res, oaiChunks(['partial ', 'answer ', 'never-sent'], null), { destroyAfter: 3 }),
    );
    upB.reset(ok());
    const res = await post(h.app, '/v1/chat/completions', key, chat({ stream: true }));
    expect(res.status).toBe(200);
    const genId = res.headers.get('x-generation-id')!;
    const events = await readSseBody(res);
    expect(events.at(-1)).toBe('[DONE]');
    const chunks = events.slice(0, -1) as any[];
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('partial answer ');
    const errChunk = chunks.find((c) => c.error);
    expect(errChunk).toMatchObject({
      choices: [{ finish_reason: 'error' }],
      error: { code: 'upstream_error' },
    });
    expect(chunks.at(-1).usage).toMatchObject({ completion_tokens: 4, estimated: true });
    expect(upB.calls).toHaveLength(0);
    const r = await row(genId);
    expect(r).toMatchObject({ status: 'partial', finishReason: 'error', usageEstimated: true });
    expect(r.costMicros).toBeGreaterThan(0);
    expect(await h.core.getBalance(orgId)).toBe(1_000_000 - r.costMicros);
    expect(h.health.stats('test/primary@alpha').failures).toBe(1);
  });

  it('records an aborted request when the client disconnects mid-stream', async () => {
    const { key } = await h.account();
    upA.reset((_r, res) =>
      sse(res, oaiChunks(Array.from({ length: 50 }, (_, i) => `w${i} `)), { delayMs: 20 }),
    );
    const res = await post(h.app, '/v1/chat/completions', key, chat({ stream: true }));
    const genId = res.headers.get('x-generation-id')!;
    const reader = res.body!.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    const r = await row(genId);
    expect(r.status).toBe('aborted');
    expect(r.completionTokens).toBeGreaterThan(0);
  });
});

describe('auto routing', () => {
  it('classifies the request, picks a tier model and explains why', async () => {
    const { key } = await h.account();
    upB.reset(ok('QED'));
    const res = await post(h.app, '/v1/chat/completions', key, {
      model: 'auto',
      messages: [{ role: 'user', content: 'Prove that the sum of two even numbers is even.' }],
    });
    const body = (await res.json()) as any;
    expect(body.model).toBe('test/reasoner');
    expect(body.routing).toMatchObject({ variant: 'default', tier: 'reasoning', model: 'test/reasoner' });
    expect(body.routing.reason).toMatch(/^reasoning: math\/reasoning cues → test\/reasoner/);
  });

  it('auto:cheap downgrades and includes routing in the final stream chunk', async () => {
    const { key } = await h.account();
    upC.reset((_r, res) => sse(res, oaiChunks(['cheap'])));
    const res = await post(h.app, '/v1/chat/completions', key, {
      model: 'auto:cheap',
      stream: true,
      messages: [{ role: 'user', content: 'Why does this fail?\n```js\nconst a = b +;\n```' }],
    });
    const chunks = (await readSseBody(res)).filter((e) => e !== '[DONE]') as any[];
    expect(chunks[0].model).toBe('test/fast');
    expect(chunks.at(-1).routing).toMatchObject({ variant: 'cheap', tier: 'fast' });
  });
});

describe('native providers through the full pipeline', () => {
  const anthText = (text: string, index = 0): [string, unknown][] => [
    [
      'content_block_start',
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    ],
    ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  const messageStart: [string, unknown] = [
    'message_start',
    {
      type: 'message_start',
      message: { id: 'msg_1', model: 'claude-x', usage: { input_tokens: 11, output_tokens: 1 } },
    },
  ];

  it('Anthropic: translates the request and response and bills from Anthropic usage', async () => {
    const { key } = await h.account();
    upC.reset((_r, res) =>
      json(res, 200, {
        id: 'msg_1',
        model: 'claude-x',
        content: [{ type: 'text', text: 'Xin chào!' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1000, output_tokens: 100 },
      }),
    );
    const res = await post(h.app, '/v1/chat/completions', key, {
      model: 'test/claude',
      messages: [
        { role: 'system', content: 'Be kind.' },
        { role: 'user', content: 'Chào bạn' },
      ],
    });
    const body = (await res.json()) as any;
    expect(body).toMatchObject({
      model: 'test/claude',
      provider: 'anth',
      choices: [{ message: { content: 'Xin chào!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1000, completion_tokens: 100, cost_micros: 1000 * 3 + 100 * 15 },
    });
    expect(upC.calls[0]!.url).toBe('/v1/messages');
    expect(upC.calls[0]!.body).toMatchObject({
      model: 'claude-x',
      system: 'Be kind.',
      messages: [{ role: 'user' }],
    });
  });

  it('keeps a stream alive through upstream heartbeats (pings / thinking) longer than the timeouts', async () => {
    const { key } = await h.account();
    const thinkingDelta: [string, unknown] = [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
    ];
    const ping: [string, unknown] = ['ping', { type: 'ping' }];
    const events: [string, unknown][] = [
      messageStart,
      [
        'content_block_start',
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      ],
      ...Array.from({ length: 4 }, () => thinkingDelta),
      ...Array.from({ length: 4 }, () => ping),
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ...anthText('done thinking', 1),
    ];
    // ~1.5s of upstream activity with no visible content, against 400ms first-byte / idle timeouts
    upC.reset((_r, res) => sse(res, events, { delayMs: 100, done: false }));
    const res = await post(h.app, '/v1/chat/completions', key, {
      model: 'test/claude',
      stream: true,
      messages: [{ role: 'user', content: 'think' }],
    });
    expect(res.status).toBe(200);
    const chunks = (await readSseBody(res)).filter((e) => e !== '[DONE]') as any[];
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('done thinking');
    expect(chunks.every((c) => c.choices.length > 0 || c.usage)).toBe(true); // heartbeats are never forwarded
    expect(chunks.at(-1).usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
  });

  it('Gemini: streams through the native API with usage from usageMetadata', async () => {
    const { key } = await h.account();
    upC.reset((_r, res) =>
      sse(
        res,
        [
          { candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }] },
          {
            candidates: [{ content: { role: 'model', parts: [{ text: 'lo' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 },
          },
        ],
        { done: false },
      ),
    );
    const res = await post(h.app, '/v1/chat/completions', key, {
      model: 'test/gemini',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const chunks = (await readSseBody(res)).filter((e) => e !== '[DONE]') as any[];
    expect(upC.calls[0]!.url).toBe('/v1beta/models/gemini-x:streamGenerateContent?alt=sse');
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('Hello');
    expect(chunks.every((c) => c.model === 'test/gemini' && c.provider === 'gem')).toBe(true);
    expect(chunks.at(-1).usage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 2,
      total_tokens: 10,
      cost_micros: 8 + 8,
    });
  });
});
