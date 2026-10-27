import { type AuthContext, authMiddleware, type Billing, type Core, getAuth, walletRoutes } from '@minh/core';
import type { Db } from '@minh/db';
import {
  AppError,
  errorHandler,
  type Logger,
  microsToUsd,
  notFound,
  parseJson,
  requestContext,
} from '@minh/shared';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { Catalog } from './catalog/catalog';
import type { ProviderAdapter } from './providers/types';
import type { HealthTracker } from './routing/health';
import { type ChatCompletionRequest, chatRequestSchema, embeddingsRequestSchema } from './schemas';
import { resolveProduct } from './services/billing';
import { type CallContext, Gateway, type GatewayConfig } from './services/gateway';
import { RequestLog, type UsageBucket } from './services/requests';
import { endpointHealthView, generationDetail, modelsList, providerView, requestSummary } from './views';

export interface AppDeps {
  core: Core;
  db: Db;
  catalog: Catalog;
  adapters: Map<string, ProviderAdapter>;
  health: HealthTracker;
  logger: Logger;
  internalToken: string;
  config?: Partial<GatewayConfig>;
  maxBodyBytes?: number;
  /** Shared platform wallet (VietQR top-ups, balance, e-invoice profile). Mounted when provided. */
  wallet?: { billing: Billing; sepayApiKey?: string };
  clock?: () => number;
  wallClock?: () => Date;
  random?: () => number;
}

type AppEnv = { Variables: { auth: AuthContext; requestId: string } };

const DAY = 86_400_000;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

const usageQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  group_by: z.enum(['day', 'model', 'provider', 'key', 'product']).default('day'),
});

const requestsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(500).optional(),
  status: z.enum(['success', 'error', 'partial', 'aborted']).optional(),
  model: z.string().max(200).optional(),
});

/** `YYYY-MM-DD` (UTC day) or any ISO-8601 timestamp. `end` dates are inclusive of that whole day. */
function parseTime(v: string, field: string, end: boolean): Date {
  if (isoDate.test(v)) {
    const d = new Date(`${v}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) throw new AppError('bad_request', `Invalid ${field}`);
    return end ? new Date(d.getTime() + DAY) : d;
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime()))
    throw new AppError('bad_request', `Invalid ${field}: use YYYY-MM-DD or an ISO-8601 timestamp`);
  return d;
}

function fillDays(buckets: UsageBucket[], from: Date, to: Date): UsageBucket[] {
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  const out: UsageBucket[] = [];
  for (
    let t = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    t < to.getTime();
    t += DAY
  ) {
    const key = new Date(t).toISOString().slice(0, 10);
    out.push(
      byKey.get(key) ?? {
        key,
        requests: 0,
        errors: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        cost_micros: 0,
        avg_latency_ms: null,
      },
    );
  }
  return out;
}

/** Build the gateway HTTP app. Pure: every dependency is injected (tests use PGlite + mock upstreams). */
export function createApp(deps: AppDeps) {
  const { core, catalog, health, logger } = deps;
  const requestLog = new RequestLog(deps.db);
  const gateway = new Gateway({
    core,
    catalog,
    adapters: deps.adapters,
    health,
    requestLog,
    logger,
    config: deps.config,
    clock: deps.clock,
    wallClock: deps.wallClock,
    random: deps.random,
  });

  const app = new Hono<AppEnv>();
  app.onError(errorHandler(logger));
  app.notFound(notFound);
  app.use('*', requestContext(logger));

  const limit = bodyLimit({
    maxSize: deps.maxBodyBytes ?? 20 * 1024 * 1024,
    onError: (c) => c.json(new AppError('bad_request', 'Request body too large').toJSON(), 413),
  });

  // ------------------------------------------------------------ public routes

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      service: 'gateway',
      mock_fallback: catalog.mockFallback,
      providers_enabled: [...catalog.providers.values()]
        .filter((p) => p.enabled && p.kind !== 'mock')
        .map((p) => p.id),
    }),
  );

  app.get('/v1/models', (c) => {
    const type = c.req.query('type');
    if (type && type !== 'chat' && type !== 'embedding')
      throw new AppError('bad_request', 'type must be chat or embedding');
    return c.json(
      modelsList(catalog, {
        type: type as 'chat' | 'embedding' | undefined,
        includeDisabled: c.req.query('include_disabled') === 'true',
      }),
    );
  });

  // ---------------------------------------------------------- authenticated

  // Wallet routes carry their own (product-agnostic) auth, so they are mounted
  // before the gateway-scoped `/v1/*` middleware below.
  if (deps.wallet) {
    app.route(
      '/',
      walletRoutes(core, deps.wallet.billing, {
        internalToken: deps.internalToken,
        sepayApiKey: deps.wallet.sepayApiKey,
      }),
    );
  }

  app.use(
    '/v1/*',
    authMiddleware<AppEnv>(core, {
      product: 'gateway',
      internalToken: deps.internalToken,
    }),
  );

  const callContext = (c: Context<AppEnv>): CallContext => {
    const auth = getAuth(c);
    return {
      orgId: auth.orgId,
      apiKeyId: auth.apiKey?.id,
      product: resolveProduct(auth, c.req.header('x-minh-product')),
      signal: c.req.raw.signal,
    };
  };

  app.post('/v1/chat/completions', limit, async (c) => {
    const req = (await parseJson(c, chatRequestSchema)) as unknown as ChatCompletionRequest;
    const result = await gateway.chat(req, callContext(c));
    if (result.kind === 'stream') return result.response;
    for (const [k, v] of Object.entries(result.headers)) c.header(k, v);
    return c.json(result.body);
  });

  app.post('/v1/embeddings', limit, async (c) => {
    const req = await parseJson(c, embeddingsRequestSchema);
    const result = await gateway.embeddings(req, callContext(c));
    for (const [k, v] of Object.entries(result.headers)) c.header(k, v);
    return c.json(result.body);
  });

  const generation = async (orgId: string, id: string | undefined) => {
    if (!id) throw new AppError('bad_request', 'Generation id is required');
    const row = await requestLog.get(orgId, id);
    if (!row) throw new AppError('not_found', `Generation ${id} not found`);
    return { data: generationDetail(row) };
  };
  app.get('/v1/generation/:id', async (c) => c.json(await generation(getAuth(c).orgId, c.req.param('id'))));
  // OpenRouter-style alias: GET /v1/generation?id=…
  app.get('/v1/generation', async (c) => c.json(await generation(getAuth(c).orgId, c.req.query('id'))));

  app.get('/v1/requests', async (c) => {
    const q = requestsQuery.parse(c.req.query());
    const { rows, nextCursor } = await requestLog.list(getAuth(c).orgId, q);
    return c.json({ object: 'list', data: rows.map(requestSummary), next_cursor: nextCursor });
  });

  app.get('/v1/usage', async (c) => {
    const q = usageQuery.parse(c.req.query());
    const to = q.to ? parseTime(q.to, 'to', true) : new Date();
    const from = q.from ? parseTime(q.from, 'from', false) : new Date(to.getTime() - 30 * DAY);
    if (from >= to) throw new AppError('bad_request', '`from` must be before `to`');
    if (to.getTime() - from.getTime() > 366 * DAY)
      throw new AppError('bad_request', 'Range is limited to 366 days');
    let buckets = await requestLog.usage(getAuth(c).orgId, { from, to, groupBy: q.group_by });
    if (q.group_by === 'day') buckets = fillDays(buckets, from, to);
    else buckets.sort((a, b) => b.cost_micros - a.cost_micros);
    const totals = buckets.reduce(
      (t, b) => ({
        requests: t.requests + b.requests,
        errors: t.errors + b.errors,
        prompt_tokens: t.prompt_tokens + b.prompt_tokens,
        completion_tokens: t.completion_tokens + b.completion_tokens,
        cost_micros: t.cost_micros + b.cost_micros,
      }),
      { requests: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, cost_micros: 0 },
    );
    return c.json({
      object: 'usage',
      from: from.toISOString(),
      to: to.toISOString(),
      group_by: q.group_by,
      data: buckets.map((b) => ({ ...b, cost_usd: microsToUsd(b.cost_micros) })),
      totals: { ...totals, cost_usd: microsToUsd(totals.cost_micros) },
    });
  });

  app.get('/v1/providers/health', (c) => {
    const provider = c.req.query('provider');
    const endpoints = catalog.allEndpoints().filter((e) => !provider || e.provider === provider);
    return c.json({
      object: 'list',
      data: endpoints.map((e) => endpointHealthView(e, health.stats(e.id))),
      providers: [...catalog.providers.values()].map(providerView),
    });
  });

  return app;
}
