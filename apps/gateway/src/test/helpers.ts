import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Core } from '@ok/core';
import { createDb, type DbHandle, migrate } from '@ok/db';
import { createLogger } from '@ok/shared';
import { createApp } from '../app';
import { Catalog } from '../catalog/catalog';
import type { CatalogEndpoint, CatalogModel } from '../catalog/types';
import { gatewayMigrations } from '../db/migrations';
import type { ProviderSpec } from '../providers/config';
import { createAdapters } from '../providers/registry';
import { type HealthOptions, HealthTracker } from '../routing/health';
import type { GatewayConfig } from '../services/gateway';

// ------------------------------------------------------------ mock upstream

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

export type UpstreamHandler = (req: RecordedRequest, res: ServerResponse) => void | Promise<void>;

/** A local HTTP server standing in for a provider. Swap `handler` per test. */
export class MockUpstream {
  readonly calls: RecordedRequest[] = [];
  handler: UpstreamHandler = (_req, res) => json(res, 500, { error: { message: 'no handler' } });
  private server!: Server;
  url = '';

  static async start(handler?: UpstreamHandler): Promise<MockUpstream> {
    const up = new MockUpstream();
    if (handler) up.handler = handler;
    up.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const rec: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : {},
      };
      up.calls.push(rec);
      try {
        await up.handler(rec, res);
      } catch {
        if (!res.headersSent) json(res, 500, { error: { message: 'handler crashed' } });
        else res.destroy();
      }
    });
    await new Promise<void>((resolve) => up.server.listen(0, '127.0.0.1', resolve));
    up.url = `http://127.0.0.1:${(up.server.address() as AddressInfo).port}`;
    return up;
  }

  reset(handler?: UpstreamHandler) {
    this.calls.length = 0;
    if (handler) this.handler = handler;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

export function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SseOptions {
  delayMs?: number;
  /** Destroy the socket after this many events (simulates a mid-stream crash). */
  destroyAfter?: number;
  /** Send `data: [DONE]` at the end (OpenAI style). Default true. */
  done?: boolean;
  /** Use `event:` names (Anthropic style): pass [eventName, data] tuples. */
}

/** Write SSE events. Items are objects (data only) or `[event, data]` tuples. */
export async function sse(
  res: ServerResponse,
  events: (unknown | [string, unknown])[],
  opts: SseOptions = {},
) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.flushHeaders();
  const write = (s: string) => new Promise<void>((resolve) => res.write(s, () => resolve()));
  // Let already-written events reach the client before killing the socket.
  const crash = async () => {
    await sleep(30);
    res.destroy();
  };
  let i = 0;
  for (const ev of events) {
    if (opts.destroyAfter !== undefined && i >= opts.destroyAfter) return crash();
    if (opts.delayMs) await sleep(opts.delayMs);
    if (Array.isArray(ev) && ev.length === 2 && typeof ev[0] === 'string')
      await write(`event: ${ev[0]}\ndata: ${JSON.stringify(ev[1])}\n\n`);
    else await write(`data: ${JSON.stringify(ev)}\n\n`);
    i++;
  }
  if (opts.destroyAfter !== undefined && i >= opts.destroyAfter) return crash();
  if (opts.done !== false) res.write('data: [DONE]\n\n');
  res.end();
}

/** Never respond (simulates a hung upstream); the socket is cleaned up by MockUpstream.close(). */
export function hang(): Promise<void> {
  return new Promise(() => {});
}

export function oaiCompletion(
  content: string,
  usage: { prompt_tokens: number; completion_tokens: number } | null = {
    prompt_tokens: 10,
    completion_tokens: 5,
  },
  extra: Record<string, unknown> = {},
) {
  return {
    id: 'chatcmpl-up',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'upstream-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...(usage ? { usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } } : {}),
    ...extra,
  };
}

export function oaiChunks(
  words: string[],
  usage: { prompt_tokens: number; completion_tokens: number } | null = {
    prompt_tokens: 10,
    completion_tokens: 5,
  },
) {
  const base = {
    id: 'chatcmpl-up',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'upstream-model',
  };
  return [
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    ...words.map((w) => ({ ...base, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] })),
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ...(usage
      ? [
          {
            ...base,
            choices: [],
            usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
          },
        ]
      : []),
  ];
}

// --------------------------------------------------------------- app harness

export const FULL_CAPS = { tools: true, vision: true, json: true, streaming: true };

export function endpoint(
  provider: string,
  price: [number, number],
  extra: Partial<CatalogEndpoint> = {},
): CatalogEndpoint {
  return {
    provider,
    upstreamModel: `${provider}-upstream`,
    price: { input: price[0], output: price[1] },
    cost: { input: price[0] / 2, output: price[1] / 2 },
    contextLength: 100_000,
    capabilities: FULL_CAPS,
    ...extra,
  };
}

export function openaiProvider(id: string, baseUrl: string, extra: Partial<ProviderSpec> = {}): ProviderSpec {
  return {
    id,
    name: id,
    kind: 'openai-compatible',
    baseUrl,
    apiKey: `key-${id}`,
    enabled: true,
    verified: false,
    supportsStreamUsage: true,
    ...extra,
  };
}

export const MOCK_PROVIDER: ProviderSpec = {
  id: 'mock',
  name: 'Mock',
  kind: 'mock',
  enabled: true,
  verified: true,
  mock: { latencyMs: 0, failureRate: 0 },
};

export const TEST_INTERNAL_TOKEN = 'internal-token-for-gateway-tests';

export interface Harness {
  app: ReturnType<typeof createApp>;
  core: Core;
  handle: DbHandle;
  health: HealthTracker;
  catalog: Catalog;
  /** Create a funded org + API key. */
  account(
    creditMicros?: number,
    scopes?: ('gateway' | 'safe' | '*')[],
  ): Promise<{ orgId: string; key: string; keyId: string }>;
  close(): Promise<void>;
}

/** One PGlite DB + Core per harness; build a fresh catalog/app per test with `rebuild`. */
export async function createHarness(opts: {
  models: CatalogModel[];
  providers: ProviderSpec[];
  config?: Partial<GatewayConfig>;
  health?: HealthOptions;
  random?: () => number;
  handle?: DbHandle;
}): Promise<Harness> {
  const handle = opts.handle ?? (await createDb('memory://'));
  const core = new Core(handle);
  await core.migrate();
  await migrate(handle, 'gateway', gatewayMigrations);
  const providers = new Map(opts.providers.map((p) => [p.id, p]));
  if (!providers.has('mock')) providers.set('mock', MOCK_PROVIDER);
  const catalog = new Catalog(opts.models, providers, { mockMode: 'never' });
  const health = new HealthTracker(opts.health);
  const app = createApp({
    core,
    db: handle.db,
    catalog,
    adapters: createAdapters(providers),
    health,
    logger: createLogger('gateway-test', 'error'),
    internalToken: TEST_INTERNAL_TOKEN,
    config: {
      upstreamTimeoutMs: 1_000,
      firstByteTimeoutMs: 1_000,
      streamIdleTimeoutMs: 1_000,
      maxAttempts: 6,
      ...opts.config,
    },
    random: opts.random ?? (() => 0),
  });
  return {
    app,
    core,
    handle,
    health,
    catalog,
    async account(creditMicros = 10_000_000, scopes = ['gateway']) {
      const org = await core.createOrg('Test Org', creditMicros);
      const { key, record } = await core.createApiKey(org.id, { name: 'test', scopes });
      return { orgId: org.id, key, keyId: record.id };
    },
    close: () => (opts.handle ? Promise.resolve() : handle.close()),
  };
}

export function post(
  app: Harness['app'],
  path: string,
  key: string,
  body: unknown,
  headers: Record<string, string> = {},
  init: RequestInit = {},
) {
  return app.request(path, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    ...init,
  });
}

export function get(app: Harness['app'], path: string, key: string, headers: Record<string, string> = {}) {
  return app.request(path, { headers: { authorization: `Bearer ${key}`, ...headers } });
}

/** Parse an SSE response body into `data:` payloads (JSON-decoded, `[DONE]` kept as a string). */
export async function readSseBody(res: Response): Promise<unknown[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .map((e) => e.trim())
    .filter((e) => e.startsWith('data:'))
    .map((e) => e.slice(5).trim())
    .map((d) => (d === '[DONE]' ? d : JSON.parse(d)));
}

/** Request rows are written after the response; poll briefly. */
export async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 2_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(20);
  }
}
