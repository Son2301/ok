import { Core } from '@ok/core';
import { createDb, type DbHandle, migrate } from '@ok/db';
import type { LlmClient } from '@ok/llm';
import { type AppDeps, createApp, createSafeContext, type SafeContext } from '../app';
import { safeMigrations } from '../db/migrations';
import { parseSafeEnv, type SafeEnv } from '../env';
import type { MediaDetector } from '../media/detectors';
import type {
  HopRequest,
  HopResponse,
  ResolvedAddress,
  Resolver,
  TlsInfo,
  Transport,
} from '../net/safe-fetch';
import type { FetchLike } from '../verdict/signal';

export const INTERNAL_TOKEN = 'test-internal-token-1234567890';

/** fetch that fails loudly: tests must never reach the network. Optionally serve canned routes. */
export function strictFetch(
  routes: Record<string, (req: Request) => Response | Promise<Response>> = {},
): FetchLike & { calls: Request[] } {
  const calls: Request[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input.toString(), init);
    calls.push(req);
    for (const [prefix, handler] of Object.entries(routes))
      if (req.url.startsWith(prefix)) return handler(req);
    throw new Error(`Unexpected network call in test: ${req.method} ${req.url}`);
  }) as FetchLike & { calls: Request[] };
  fn.calls = calls;
  return fn;
}

/** DNS resolver backed by a map; unknown names fail like NXDOMAIN. Values may be functions (rebinding). */
export function fakeResolver(
  map: Record<string, string[] | (() => string[])>,
  mx: Record<string, { exchange: string; priority: number }[]> = {},
): Resolver & { lookups: string[] } {
  const lookups: string[] = [];
  return {
    lookups,
    async lookup(host: string): Promise<ResolvedAddress[]> {
      lookups.push(host);
      const v = map[host];
      if (!v) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      const list = typeof v === 'function' ? v() : v;
      return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    async resolveMx(domain: string) {
      const v = mx[domain];
      if (!v) throw Object.assign(new Error(`queryMx ENOTFOUND ${domain}`), { code: 'ENOTFOUND' });
      return v;
    },
  };
}

export interface FakeRoute {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Never resolves (to test timeouts). */
  hang?: boolean;
  tls?: TlsInfo;
}

/** Transport serving canned responses by URL; records every hop (incl. the pinned address). */
export function fakeTransport(routes: Record<string, FakeRoute>): Transport & { hops: HopRequest[] } {
  const hops: HopRequest[] = [];
  const t = (async (req: HopRequest): Promise<HopResponse> => {
    hops.push(req);
    const r = routes[req.url.href];
    if (!r) throw Object.assign(new Error(`connect ECONNREFUSED ${req.address}`), { code: 'ECONNREFUSED' });
    if (r.hang) {
      return new Promise<HopResponse>((_, reject) =>
        req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }),
      );
    }
    const body = typeof r.body === 'string' ? new TextEncoder().encode(r.body) : (r.body ?? new Uint8Array());
    const capped = body.subarray(0, req.maxBytes);
    return {
      status: r.status ?? 200,
      headers: { 'content-type': 'text/html; charset=utf-8', ...r.headers },
      body: capped,
      truncated: body.length > req.maxBytes,
      tls: r.tls,
    };
  }) as Transport & { hops: HopRequest[] };
  t.hops = hops;
  return t;
}

export interface SetupOptions {
  env?: Record<string, string>;
  llm?: LlmClient | null;
  fetch?: FetchLike;
  resolver?: Resolver;
  transport?: Transport;
  detectors?: MediaDetector[];
  now?: () => Date;
}

export interface TestSafe {
  handle: DbHandle;
  core: Core;
  env: SafeEnv;
  ctx: SafeContext;
  app: ReturnType<typeof createApp>;
  /** Org ids the LLM factory was asked to bill. */
  llmOrgs: (string | null)[];
  close(): Promise<void>;
}

export async function setupSafe(opts: SetupOptions = {}): Promise<TestSafe> {
  const handle = await createDb('memory://');
  const core = new Core(handle);
  await core.migrate();
  await migrate(handle, 'safe', safeMigrations);
  const env = parseSafeEnv({
    INTERNAL_TOKEN,
    NODE_ENV: 'test',
    TRUST_PROXY: 'true',
    SAFE_RDAP_ENABLED: 'false',
    SAFE_PLATFORM_ORG_ID: 'org_platform',
    GATEWAY_URL: opts.llm ? 'http://gateway.test/v1' : '',
    ...opts.env,
  });
  const llmOrgs: (string | null)[] = [];
  const deps: AppDeps = {
    handle,
    core,
    env,
    fetch: opts.fetch ?? strictFetch(),
    resolver: opts.resolver ?? fakeResolver({}),
    transport: opts.transport ?? fakeTransport({}),
    detectors: opts.detectors ?? [],
    now: opts.now,
    llmFor: (orgId) => {
      llmOrgs.push(orgId);
      return opts.llm && orgId ? opts.llm : null;
    },
  };
  const ctx = createSafeContext(deps);
  await ctx.reloadBrands();
  const app = createApp(deps, ctx);
  return { handle, core, env, ctx, app, llmOrgs, close: () => handle.close() };
}

export function post(
  app: TestSafe['app'],
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10', ...headers },
    body: JSON.stringify(body),
  });
}

/** MockLlm reply for the scam analyst schema. */
export function scamReply(
  p: Partial<{ prob: number; conf: number; type: string; quotes: string[]; goal: string }> = {},
): string {
  return JSON.stringify({
    scam_probability: p.prob ?? 0.9,
    confidence: p.conf ?? 0.9,
    scam_type: p.type ?? 'impersonation_authority',
    tactics: ['urgency', 'authority'],
    red_flags: (p.quotes ?? []).map((q) => ({
      quote: q,
      why_vi: 'Câu này tạo áp lực để bạn làm theo ngay',
      why_en: 'This creates pressure to act now',
    })),
    scammer_goal_vi: p.goal ?? 'Muốn bạn chuyển tiền',
    scammer_goal_en: 'Wants you to send money',
    advice_vi: ['Gọi lại số chính thức để xác minh'],
    advice_en: ['Call the official number to verify'],
  });
}
