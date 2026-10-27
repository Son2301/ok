import { randomBytes } from 'node:crypto';
import { Core } from '@minh/core';
import { createDb } from '@minh/db';
import {
  type ChatChunk,
  type ChatRequest,
  type LlmClient,
  type MockHandler,
  MockLlm,
  type MockReply,
} from '@minh/llm';
import { createApp } from '../app';
import { type AgentsConfig, buildPlans } from '../config';
import { migrateAgents } from '../db/migrations';
import type { IntegrationCatalog } from '../integrations';
import { SecretBox } from '../lib/crypto';
import type { FetchLike } from '../lib/http';
import type { SafeFetchOptions, SafeResponse } from '../lib/ssrf';
import { type Clock, ManualClock } from '../lib/time';
import { createPlatform } from '../platform';
import type { RuntimeDriver } from '../runtime/drivers/types';

export const INTERNAL_TOKEN = 'internal-token-for-tests-123456';

/**
 * Stream a MockLlm reply the way OpenAI-compatible gateways do, including
 * tool-call deltas (MockLlm.stream from @minh/llm only streams text content).
 */
export async function* streamFromChat(
  llm: Pick<LlmClient, 'chat'>,
  req: ChatRequest,
): AsyncIterable<ChatChunk> {
  const res = await llm.chat(req);
  const base = {
    id: res.id,
    object: 'chat.completion.chunk' as const,
    created: res.created,
    model: res.model,
  };
  const msg = res.choices[0]?.message;
  const text = typeof msg?.content === 'string' ? msg.content : '';
  for (const w of text.split(/(?<=\s)/))
    if (w) yield { ...base, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] };
  for (const [index, tc] of (msg?.tool_calls ?? []).entries()) {
    const args = tc.function.arguments;
    const half = Math.ceil(args.length / 2);
    yield {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: tc.id,
                type: 'function',
                function: { name: tc.function.name, arguments: args.slice(0, half) },
              },
            ],
          } as never,
          finish_reason: null,
        },
      ],
    };
    yield {
      ...base,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index, function: { arguments: args.slice(half) } }] } as never,
          finish_reason: null,
        },
      ],
    };
  }
  yield {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: msg?.tool_calls?.length ? 'tool_calls' : 'stop' }],
    usage: res.usage,
  };
}

export function testConfig(overrides: Partial<AgentsConfig> = {}): AgentsConfig {
  return {
    internalToken: INTERNAL_TOKEN,
    publicUrl: 'https://agents.test',
    controlPlaneUrl: 'http://control-plane.test',
    gatewayUrl: 'http://gateway.test/v1',
    platformOrgId: null,
    timezone: 'Asia/Ho_Chi_Minh',
    plans: buildPlans({
      AGENTS_PLAN_STARTER_PRICE_MICROS: 8_000_000,
      AGENTS_PLAN_STARTER_MONTHLY_TOKENS: 3_000_000,
      AGENTS_PLAN_PRO_PRICE_MICROS: 20_000_000,
      AGENTS_PLAN_PRO_MONTHLY_TOKENS: 10_000_000,
    }),
    turn: { maxSteps: 8, tokenBudget: 60_000, timeBudgetMs: 20_000 },
    scheduler: { enabled: false, intervalMs: 60_000, heartbeatIntervalMs: 60 * 60_000, dailySummaryHour: 18 },
    trustProxy: true,
    publicChatRpm: 20,
    images: {
      builtin: 'ok/agents-runtime:test',
      openclaw: 'ok/agents-runtime-openclaw:test',
      hermes: 'ok/agents-runtime-hermes:test',
    },
    docker: {
      socketPath: '/var/run/docker.sock',
      network: 'minh-agents',
      networkInternal: false,
      icc: false,
      addressMode: 'ip',
    },
    ...overrides,
  };
}

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  json<T = unknown>(): T;
}

/** Fixture-based fetch: the handler returns a Response or any JSON-serialisable value (200). */
export function fakeFetch(handler: (call: FetchCall) => unknown | Promise<unknown>) {
  const calls: FetchCall[] = [];
  const fn: FetchLike = async (input, init) => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? req?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    let body: string | null = null;
    const raw = init?.body ?? (req ? await req.text() : null);
    if (typeof raw === 'string') body = raw;
    else if (raw instanceof URLSearchParams) body = raw.toString();
    else if (raw) body = await new Response(raw as BodyInit).text();
    const call: FetchCall = {
      url,
      method: (init?.method ?? req?.method ?? 'GET').toUpperCase(),
      headers,
      body,
      json: () => JSON.parse(body ?? 'null'),
    };
    calls.push(call);
    const out = await handler(call);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out ?? {}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch: fn, calls };
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface TestPlatformOptions {
  llm?: MockHandler | MockReply[];
  /** Full control over the gateway client (e.g. to report cost_micros or stream tool calls). */
  llmClient?: (billingOrgId: string) => LlmClient;
  fetch?: FetchLike;
  safeFetch?: (url: string, opts: SafeFetchOptions) => Promise<SafeResponse>;
  clock?: Clock;
  config?: Partial<AgentsConfig>;
  driver?: RuntimeDriver;
  catalog?: IntegrationCatalog;
  orgCreditMicros?: number;
}

export async function createTestPlatform(opts: TestPlatformOptions = {}) {
  const handle = await createDb('memory://');
  const core = new Core(handle);
  await core.migrate();
  await migrateAgents(handle);
  const org = await core.createOrg('Cửa hàng An', opts.orgCreditMicros ?? 50_000_000);
  const platformOrg = await core.createOrg('Minh Platform', 1_000_000_000);
  const { key } = await core.createApiKey(org.id, { name: 'test', scopes: ['agents'] });
  const config = testConfig({ platformOrgId: platformOrg.id, ...opts.config });
  const clock = opts.clock ?? new ManualClock('2026-10-25T03:00:00Z');
  const mock = new MockLlm(opts.llm ?? (() => 'Xin chào! Tôi có thể giúp gì cho bạn?'));
  const llmCalls: { billingOrgId: string; req: ChatRequest }[] = [];
  const fetchFix = opts.fetch
    ? { fetch: opts.fetch, calls: [] as FetchCall[] }
    : fakeFetch(() => jsonResponse({ ok: true }));

  const platform = createPlatform({
    handle,
    core,
    config,
    box: new SecretBox([randomBytes(32)]),
    clock,
    fetch: fetchFix.fetch,
    safeFetch: opts.safeFetch,
    driver: opts.driver,
    catalog: opts.catalog,
    llm: ({ billingOrgId }) => {
      if (opts.llmClient) {
        const inner = opts.llmClient(billingOrgId);
        return {
          chat: (req, o) => {
            llmCalls.push({ billingOrgId, req });
            return inner.chat(req, o);
          },
          stream: (req, o) => {
            llmCalls.push({ billingOrgId, req });
            return inner.stream(req, o);
          },
        };
      }
      return {
        chat: (req) => {
          llmCalls.push({ billingOrgId, req });
          return mock.chat(req);
        },
        stream: (req) => {
          llmCalls.push({ billingOrgId, req });
          return streamFromChat(mock, req);
        },
      };
    },
  });
  const app = createApp(platform);

  const request = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const init: RequestInit = { method, headers: { authorization: `Bearer ${key}`, ...headers } };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] ??= 'application/json';
    }
    const res = await app.request(path, init);
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: test responses are asserted structurally
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers, text };
  };

  /** Create + deploy an agent through the API. */
  const createAgent = async (body: Record<string, unknown> = {}, deploy = true) => {
    const res = await request('POST', '/v1/agents', {
      name: 'Lan',
      role: 'Nhân viên CSKH',
      jobDescription: 'Trả lời khách hàng về sản phẩm và đơn hàng.',
      ...body,
    });
    if (res.status !== 201) throw new Error(`create failed: ${res.status} ${res.text}`);
    if (deploy) {
      const d = await request('POST', `/v1/agents/${res.body.id}/deploy`);
      if (d.status !== 200) throw new Error(`deploy failed: ${d.status} ${d.text}`);
    }
    return res.body as { id: string; [k: string]: unknown };
  };

  return {
    handle,
    core,
    org,
    platformOrg,
    key,
    config,
    clock: clock as ManualClock,
    platform,
    app,
    mock,
    llmCalls,
    fetchCalls: fetchFix.calls,
    request,
    createAgent,
    close: () => handle.close(),
  };
}

export type TestPlatform = Awaited<ReturnType<typeof createTestPlatform>>;
