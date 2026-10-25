import { createHash } from 'node:crypto';
import { type AuthEnv, authMiddleware, type Core, safeEqual } from '@ok/core';
import type { DbHandle } from '@ok/db';
import { createLlmClient, type LlmClient } from '@ok/llm';
import {
  AppError,
  createLogger,
  errorHandler,
  type Logger,
  newId,
  notFound,
  parseJson,
  requestContext,
} from '@ok/shared';
import { eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { DailyLimiter } from './billing/limiter';
import { type Caller, type CheckTicket, Metering } from './billing/metering';
import { resolvePrices } from './billing/pricing';
import {
  classifyMessage,
  ERROR_TEXT,
  formatTelegramReply,
  MEDIA_ONLY_TEXT,
  rateLimitedText,
  sendMessage,
  type TelegramUpdate,
  WELCOME_TEXT,
} from './channels/telegram';
import { brandOverrides } from './db/schema';
import type { SafeEnv } from './env';
import type { MediaKind } from './media/containers';
import {
  hiveDetector,
  type MediaDetector,
  realityDefenderDetector,
  sightengineDetector,
} from './media/detectors';
import { nodeTransport } from './net/node-transport';
import { type Resolver, SafeFetcher, systemResolver, type Transport } from './net/safe-fetch';
import { REPORT_CATEGORY_IDS, REPORT_STATUSES, REPORT_TYPES, type ReportType } from './reports/categories';
import { ReportService } from './reports/service';
import { type CheckContext, SafeService } from './service';
import { FeedStore } from './sources/feeds';
import { VerdictCache } from './store/cache';
import { CheckStore } from './store/checks';
import { type BrandOverride, BrandRegistry } from './url/brand-match';
import type { FetchLike } from './verdict/signal';
import { CHECK_KINDS, type CheckKind, type Verdict } from './verdict/types';

export interface AppDeps {
  handle: DbHandle;
  core: Core;
  env: SafeEnv;
  logger?: Logger;
  /** LLM client per billed org. Default: gateway client when GATEWAY_URL is set. */
  llmFor?: (orgId: string | null) => LlmClient | null;
  /** fetch used for third-party APIs (Safe Browsing, VirusTotal, RDAP, detectors…). */
  fetch?: FetchLike;
  /** DNS resolver for the SSRF guard and MX lookups. */
  resolver?: Resolver;
  /** Network transport for the SSRF-safe fetcher. */
  transport?: Transport;
  detectors?: MediaDetector[];
  registry?: BrandRegistry;
  now?: () => Date;
}

export interface SafeContext {
  service: SafeService;
  reports: ReportService;
  feeds: FeedStore;
  checks: CheckStore;
  cache: VerdictCache;
  metering: Metering;
  limiter: DailyLimiter;
  registry: BrandRegistry;
  fetcher: SafeFetcher;
  /** Reload admin brand overrides from the database. */
  reloadBrands(): Promise<void>;
}

export function defaultLlmFactory(env: SafeEnv): (orgId: string | null) => LlmClient | null {
  return (orgId) => {
    if (!env.GATEWAY_URL || !orgId) return null;
    return createLlmClient({
      baseUrl: env.GATEWAY_URL,
      apiKey: env.INTERNAL_TOKEN,
      headers: { 'x-org-id': orgId, 'x-ok-product': 'safe' },
      timeoutMs: env.SAFE_LLM_TIMEOUT_MS,
    });
  };
}

export function defaultDetectors(env: SafeEnv, fetchFn: FetchLike): MediaDetector[] {
  const out: MediaDetector[] = [];
  if (env.HIVE_API_KEY) out.push(hiveDetector(env.HIVE_API_KEY, fetchFn));
  if (env.SIGHTENGINE_API_USER && env.SIGHTENGINE_API_SECRET)
    out.push(sightengineDetector(env.SIGHTENGINE_API_USER, env.SIGHTENGINE_API_SECRET, fetchFn));
  if (env.REALITY_DEFENDER_API_KEY)
    out.push(
      realityDefenderDetector(env.REALITY_DEFENDER_API_KEY, fetchFn, {
        maxWaitMs: env.REALITY_DEFENDER_MAX_WAIT_MS,
      }),
    );
  return out;
}

/** Wire all services from injected dependencies (no I/O). */
export function createSafeContext(deps: AppDeps): SafeContext {
  const { env, handle } = deps;
  const db = handle.db;
  const now = deps.now ?? (() => new Date());
  const fetchFn = deps.fetch ?? ((input, init) => fetch(input, init));
  const resolver = deps.resolver ?? systemResolver;
  const registry = deps.registry ?? new BrandRegistry();
  const salt =
    env.SAFE_FINGERPRINT_SALT ?? createHash('sha256').update(`safe-fp:${env.INTERNAL_TOKEN}`).digest('hex');
  const fetcher = new SafeFetcher(deps.transport ?? nodeTransport, resolver, {
    timeoutMs: env.SAFE_FETCH_TIMEOUT_MS,
    maxBytes: env.SAFE_FETCH_MAX_BYTES,
    maxRedirects: env.SAFE_FETCH_MAX_REDIRECTS,
  });
  const reports = new ReportService(db, registry, now);
  const feeds = new FeedStore(db);
  const cache = new VerdictCache(db, now);
  const checks = new CheckStore(db);
  const limiter = new DailyLimiter(db, salt);
  const metering = new Metering(deps.core, limiter, env, resolvePrices(env.SAFE_PRICES));
  const service = new SafeService({
    env,
    registry,
    fetcher,
    resolver,
    fetch: fetchFn,
    reports,
    feeds,
    cache,
    llmFor: deps.llmFor ?? defaultLlmFactory(env),
    detectors: deps.detectors ?? defaultDetectors(env, fetchFn),
    now,
    logger: deps.logger ?? createLogger('safe'),
  });
  return {
    service,
    reports,
    feeds,
    checks,
    cache,
    metering,
    limiter,
    registry,
    fetcher,
    async reloadBrands() {
      const rows = await db.select().from(brandOverrides);
      registry.applyOverrides(rows as BrandOverride[]);
    },
  };
}

/** Client IP. X-Forwarded-For is only trusted when TRUST_PROXY=true (entry counted from the right). */
export function clientIp(c: Context, env: SafeEnv): string {
  if (env.TRUST_PROXY) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const parts = xff
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const pick = parts[Math.max(0, parts.length - env.TRUST_PROXY_HOPS)];
      if (pick) return pick;
    }
    const real = c.req.header('x-real-ip');
    if (real) return real.trim();
  }
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

const urlBody = z.object({
  url: z.string().min(1).max(4096),
  options: z.object({ noCache: z.boolean().optional() }).optional(),
});
const textBody = z.object({
  text: z.string().min(1).max(10_000),
  channel: z.enum(['sms', 'zalo', 'messenger', 'email', 'telegram', 'facebook', 'other']).optional(),
  sender: z.string().max(200).optional(),
  storeInput: z.boolean().optional(),
});
const phoneBody = z.object({ phone: z.string().min(3).max(40) });
const bankBody = z.object({
  accountNumber: z.string().min(6).max(40),
  bankName: z.string().max(80).optional(),
});
const emailBody = z.object({ email: z.string().min(3).max(320) });
const aiTextBody = z.object({ text: z.string().min(1).max(20_000), storeInput: z.boolean().optional() });
const mediaUrlBody = z.object({ url: z.string().min(1).max(4096) });
const reportBody = z.object({
  type: z.enum(REPORT_TYPES),
  value: z.string().min(1).max(2048),
  bankName: z.string().max(80).optional(),
  category: z.enum(REPORT_CATEGORY_IDS),
  description: z.string().max(2000).optional(),
  evidenceUrls: z.array(z.string().max(2048)).max(5).optional(),
  evidenceImages: z
    .array(z.object({ contentType: z.string().max(60), dataBase64: z.string().max(1_500_000) }))
    .max(3)
    .optional(),
  amountLostVnd: z.number().int().min(0).max(1e13).optional(),
});
const voteBody = z.object({ vote: z.enum(['confirm', 'dispute']) });
const moderateBody = z.object({ status: z.enum(REPORT_STATUSES), note: z.string().max(1000).optional() });
const brandBody = z.object({
  name: z.string().max(120).optional(),
  category: z
    .enum([
      'bank',
      'ewallet',
      'government',
      'ecommerce',
      'logistics',
      'telco',
      'social',
      'tech',
      'crypto',
      'payment',
      'insurance',
      'media',
    ])
    .optional(),
  officialDomains: z
    .array(
      z
        .string()
        .min(3)
        .max(253)
        .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i),
    )
    .max(50)
    .optional(),
  keywords: z
    .array(
      z.object({
        k: z
          .string()
          .min(2)
          .max(60)
          .regex(/^[a-z0-9]+$/),
        mode: z.enum(['fuzzy', 'substring', 'prefix', 'token']),
      }),
    )
    .max(30)
    .optional(),
  mentions: z.array(z.string().min(2).max(80)).max(30).optional(),
  disabled: z.boolean().optional(),
});

export function createApp(deps: AppDeps, ctx: SafeContext = createSafeContext(deps)): Hono<AuthEnv> {
  const { env, core } = deps;
  const logger = deps.logger ?? createLogger('safe');
  const { service, reports, feeds, checks, cache, metering, limiter, registry, fetcher } = ctx;
  const app = new Hono<AuthEnv>();
  const maxUploadBytes = Math.round(env.SAFE_MAX_UPLOAD_MB * 1024 * 1024);

  app.use('*', requestContext(logger));
  app.onError(errorHandler(logger));
  app.notFound(notFound);
  if (env.SAFE_CORS_ORIGINS) {
    const origins = env.SAFE_CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    app.use(
      '/v1/*',
      cors({
        origin: origins,
        allowHeaders: ['authorization', 'content-type', 'x-api-key'],
        allowMethods: ['GET', 'POST'],
        exposeHeaders: ['x-ratelimit-remaining', 'x-ratelimit-limit', 'x-safe-charged-micros'],
      }),
    );
  }

  app.get('/health', async (c) => {
    let db = 'ok';
    try {
      await deps.handle.query('SELECT 1');
    } catch {
      db = 'error';
    }
    return c.json({ ok: db === 'ok', service: 'safe', db }, db === 'ok' ? 200 : 503);
  });
  app.get('/', (c) =>
    c.json({
      service: 'safe',
      docs: 'See apps/safe/README.md',
      endpoints: '/v1/check/{url,text,phone,bank-account,email,image,video,audio,ai-text}',
    }),
  );

  // ------------------------------------------------------------------ v1 (anonymous allowed)
  const jsonLimit = bodyLimit({
    maxSize: 256 * 1024,
    onError: () => {
      throw new AppError('bad_request', 'Request body too large');
    },
  });
  app.use(
    '/v1/*',
    authMiddleware(core, { product: 'safe', internalToken: env.INTERNAL_TOKEN, optional: true }),
  );

  const callerFrom = (c: Context<AuthEnv>): Caller => {
    const auth = c.get('auth');
    if (auth?.via === 'api_key' && auth.apiKey)
      return { type: 'api_key', orgId: auth.orgId, apiKeyId: auth.apiKey.id };
    if (auth?.via === 'internal')
      return { type: 'internal', orgId: auth.orgId, userId: c.req.header('x-user-id') ?? undefined };
    return { type: 'anonymous', ip: clientIp(c, env) };
  };

  async function runCheck(
    c: Context<AuthEnv>,
    kind: CheckKind,
    fn: (cc: CheckContext) => Promise<Verdict>,
    opts: { storeInput?: boolean; rawInput?: string; caller?: Caller } = {},
  ): Promise<{ verdict: Verdict; ticket: CheckTicket }> {
    const caller = opts.caller ?? callerFrom(c);
    const checkId = newId('chk');
    const ticket = await metering.begin(caller, kind, checkId);
    let verdict: Verdict;
    try {
      verdict = await fn({ llmOrgId: ticket.llmOrgId });
    } catch (err) {
      await metering
        .refund(ticket, (err as Error).message)
        .catch((e) => logger.error('refund_failed', { err: String(e), checkId }));
      throw err;
    }
    verdict = { ...verdict, id: checkId };
    await checks
      .record(verdict, ticket, { storeInput: opts.storeInput, rawInput: opts.rawInput })
      .catch((e) => logger.error('record_check_failed', { err: String(e) }));
    if (ticket.chargedMicros) c.header('x-safe-charged-micros', String(ticket.chargedMicros));
    if (ticket.limit) {
      c.header('x-ratelimit-limit', String(ticket.limit.limit));
      c.header('x-ratelimit-remaining', String(ticket.limit.remaining));
      c.header('x-ratelimit-reset', ticket.limit.resetAt.toISOString());
    }
    return { verdict, ticket };
  }

  app.post('/v1/check/url', jsonLimit, async (c) => {
    const body = await parseJson(c, urlBody);
    const { verdict } = await runCheck(c, 'url', (cc) =>
      service.checkUrl(body.url, { ...cc, useCache: !body.options?.noCache }),
    );
    return c.json(verdict);
  });

  app.post('/v1/check/text', jsonLimit, async (c) => {
    const body = await parseJson(c, textBody);
    const { verdict } = await runCheck(c, 'text', (cc) => service.checkText(body, cc), {
      storeInput: body.storeInput,
      rawInput: body.text,
    });
    return c.json(verdict);
  });

  app.post('/v1/check/phone', jsonLimit, async (c) => {
    const body = await parseJson(c, phoneBody);
    const { verdict } = await runCheck(c, 'phone', (cc) => service.checkPhone(body.phone, cc));
    return c.json(verdict);
  });

  app.post('/v1/check/bank-account', jsonLimit, async (c) => {
    const body = await parseJson(c, bankBody);
    const { verdict } = await runCheck(c, 'bank_account', (cc) => service.checkBankAccount(body, cc));
    return c.json(verdict);
  });

  app.post('/v1/check/email', jsonLimit, async (c) => {
    const body = await parseJson(c, emailBody);
    const { verdict } = await runCheck(c, 'email', (cc) => service.checkEmail(body.email, cc));
    return c.json(verdict);
  });

  app.post('/v1/check/ai-text', jsonLimit, async (c) => {
    const body = await parseJson(c, aiTextBody);
    const { verdict } = await runCheck(c, 'ai_text', (cc) => service.checkAiText(body.text, cc), {
      storeInput: body.storeInput,
      rawInput: body.text,
    });
    return c.json(verdict);
  });

  const mediaLimit = bodyLimit({
    maxSize: maxUploadBytes + 512 * 1024,
    onError: () => {
      throw new AppError('bad_request', `Upload must be ${env.SAFE_MAX_UPLOAD_MB}MB or smaller`);
    },
  });
  for (const kind of ['image', 'video', 'audio'] as MediaKind[]) {
    app.post(`/v1/check/${kind}`, mediaLimit, async (c) => {
      const ct = c.req.header('content-type') ?? '';
      if (/multipart\/form-data/i.test(ct)) {
        const form = await c.req.formData().catch(() => {
          throw new AppError('bad_request', 'Invalid multipart body');
        });
        const file = form.get('file') ?? form.get('media');
        if (!file || typeof file === 'string')
          throw new AppError('bad_request', 'Send the file in a multipart field named "file"');
        if (file.size === 0) throw new AppError('bad_request', 'The uploaded file is empty');
        if (file.size > maxUploadBytes)
          throw new AppError('bad_request', `Upload must be ${env.SAFE_MAX_UPLOAD_MB}MB or smaller`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const { verdict } = await runCheck(c, kind, (cc) =>
          service.checkMedia({ bytes, filename: file.name, kind }, cc),
        );
        return c.json(verdict);
      }
      const body = await parseJson(c, mediaUrlBody);
      const { verdict } = await runCheck(c, kind, async (cc) => {
        const dl = await fetcher.fetchBinary(body.url, maxUploadBytes);
        return service.checkMedia({ bytes: dl.bytes, kind }, cc);
      });
      return c.json(verdict);
    });
  }

  // ------------------------------------------------------------------ reports
  const reportLimit = bodyLimit({
    maxSize: 6 * 1024 * 1024,
    onError: () => {
      throw new AppError('bad_request', 'Report too large');
    },
  });
  const fingerprint = (caller: Caller) =>
    caller.type === 'anonymous'
      ? `ip:${limiter.hashKey(caller.ip)}`
      : caller.type === 'telegram'
        ? `tg:${limiter.hashKey(caller.chatId)}`
        : `org:${caller.orgId}${caller.type === 'internal' && caller.userId ? `:${caller.userId}` : ''}`;

  app.post('/v1/reports', reportLimit, async (c) => {
    const body = await parseJson(c, reportBody);
    const caller = callerFrom(c);
    const limitKey =
      caller.type === 'anonymous' ? caller.ip : caller.type === 'telegram' ? caller.chatId : caller.orgId;
    const max = caller.type === 'anonymous' ? env.SAFE_ANON_DAILY_REPORTS : 500;
    const lim = await limiter.hit(caller.type === 'anonymous' ? 'anon_report' : 'org_report', limitKey, max);
    if (!lim.allowed) {
      throw new AppError('rate_limited', `Daily report limit of ${max} reached`, {
        vi: `Bạn đã gửi tối đa ${max} báo cáo hôm nay. Cảm ơn bạn, hãy quay lại vào ngày mai.`,
        resetAt: lim.resetAt.toISOString(),
      });
    }
    const { report, deduplicated } = await reports.create(
      body,
      fingerprint(caller),
      caller.type === 'api_key' || caller.type === 'internal' ? caller.orgId : undefined,
    );
    await cache
      .invalidate(body.type === 'url' ? 'url' : (body.type as CheckKind), report.lookupKey)
      .catch(() => {});
    return c.json(
      {
        id: report.id,
        type: report.type,
        status: report.status,
        category: report.category,
        deduplicated,
        message: deduplicated
          ? {
              vi: 'Bạn đã báo cáo mục này trước đó; chúng tôi đã cập nhật báo cáo của bạn.',
              en: 'You reported this before; your report was updated.',
            }
          : {
              vi: 'Cảm ơn bạn! Báo cáo sẽ được kiểm duyệt trước khi hiển thị là đã xác minh.',
              en: 'Thank you! Your report will be reviewed before it counts as verified.',
            },
      },
      deduplicated ? 200 : 201,
    );
  });

  app.get('/v1/reports/stats', async (c) => {
    const days = Math.min(90, Math.max(1, Number(c.req.query('days') ?? 7) || 7));
    const [r, k] = await Promise.all([reports.stats(days), checks.stats(days)]);
    c.header('cache-control', 'public, max-age=60');
    return c.json({ days, ...r, ...k });
  });

  app.post('/v1/reports/:id/votes', jsonLimit, async (c) => {
    const body = await parseJson(c, voteBody);
    const caller = callerFrom(c);
    const lim = await limiter.hit(
      'vote',
      caller.type === 'anonymous' ? caller.ip : caller.type === 'telegram' ? caller.chatId : caller.orgId,
      100,
    );
    if (!lim.allowed) throw new AppError('rate_limited', 'Daily vote limit reached');
    const counts = await reports.vote(c.req.param('id'), fingerprint(caller), body.vote);
    const report = await reports.get(c.req.param('id'));
    if (report)
      await cache
        .invalidate(report.type === 'url' ? 'url' : (report.type as CheckKind), report.lookupKey)
        .catch(() => {});
    return c.json({ id: c.req.param('id'), votes: counts });
  });

  // ------------------------------------------------------------------ history (signed-in users)
  app.get('/v1/checks', async (c) => {
    const auth = c.get('auth');
    if (!auth) throw new AppError('unauthorized', 'Sign in to see your check history');
    const kindQ = c.req.query('kind');
    const kind =
      kindQ && (CHECK_KINDS as readonly string[]).includes(kindQ) ? (kindQ as CheckKind) : undefined;
    const before = c.req.query('before') ? new Date(c.req.query('before')!) : undefined;
    const rows = await checks.list(auth.orgId, {
      limit: Number(c.req.query('limit') ?? 20) || 20,
      before: before && !Number.isNaN(before.getTime()) ? before : undefined,
      kind,
      userId: auth.via === 'internal' ? (c.req.header('x-user-id') ?? undefined) : undefined,
    });
    return c.json({
      data: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        level: r.level,
        score: r.score,
        inputPreview: r.inputPreview,
        via: r.via,
        cached: r.cached,
        chargedMicros: r.chargedMicros,
        createdAt: r.createdAt.toISOString(),
      })),
      nextBefore: rows.length ? rows[rows.length - 1]!.createdAt.toISOString() : null,
    });
  });

  app.get('/v1/checks/:id', async (c) => {
    const auth = c.get('auth');
    if (!auth) throw new AppError('unauthorized', 'Sign in to see your check history');
    const row = await checks.get(auth.orgId, c.req.param('id'));
    if (!row) throw new AppError('not_found', 'Check not found');
    return c.json(row.verdict);
  });

  app.get('/v1/brands', (c) =>
    c.json({
      data: registry
        .list()
        .map((b) => ({ id: b.id, name: b.name, category: b.category, officialDomains: b.domains })),
    }),
  );

  app.get('/v1/pricing', (c) =>
    c.json({
      currency: 'micro-USD',
      perCheck: Object.fromEntries(CHECK_KINDS.map((k) => [k, metering.price(k)])),
      freeTier: {
        checksPerDay: env.SAFE_ANON_DAILY_CHECKS,
        mediaChecksPerDay: env.SAFE_ANON_DAILY_MEDIA,
        reportsPerDay: env.SAFE_ANON_DAILY_REPORTS,
      },
    }),
  );

  // ------------------------------------------------------------------ admin (internal token)
  app.use('/admin/*', async (c, next) => {
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token || !safeEqual(token, env.INTERNAL_TOKEN))
      throw new AppError('unauthorized', 'Admin routes require the internal token');
    await next();
  });

  app.get('/admin/reports', async (c) => {
    const status = c.req.query('status');
    const type = c.req.query('type');
    const before = c.req.query('before') ? new Date(c.req.query('before')!) : undefined;
    const rows = await reports.list({
      status: (REPORT_STATUSES as readonly string[]).includes(status ?? '')
        ? (status as (typeof REPORT_STATUSES)[number])
        : undefined,
      type: (REPORT_TYPES as readonly string[]).includes(type ?? '') ? (type as ReportType) : undefined,
      limit: Number(c.req.query('limit') ?? 50) || 50,
      before: before && !Number.isNaN(before.getTime()) ? before : undefined,
    });
    return c.json({ data: rows });
  });

  app.get('/admin/reports/:id', async (c) => {
    const report = await reports.get(c.req.param('id'));
    if (!report) throw new AppError('not_found', 'Report not found');
    const evidence = (await reports.evidence(report.id)).map(({ data: _d, ...e }) => e);
    const summary = await reports.summarize(report.type as ReportType, report.lookupKey);
    return c.json({ report, evidence, summary });
  });

  app.get('/admin/reports/:id/evidence/:evidenceId', async (c) => {
    const ev = (await reports.evidence(c.req.param('id'))).find((e) => e.id === c.req.param('evidenceId'));
    if (!ev) throw new AppError('not_found', 'Evidence not found');
    return c.body(new Uint8Array(ev.data), 200, {
      'content-type': ev.contentType,
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
    });
  });

  app.post('/admin/reports/:id/moderate', jsonLimit, async (c) => {
    const body = await parseJson(c, moderateBody);
    const row = await reports.moderate(c.req.param('id'), body.status, body.note);
    await cache
      .invalidate(row.type === 'url' ? 'url' : (row.type as CheckKind), row.lookupKey)
      .catch(() => {});
    return c.json({ report: row });
  });

  app.post('/admin/feeds/import', async (c) => {
    const results = await feeds.importAll(
      { openPhishUrl: env.OPENPHISH_FEED_URL, phishTankAppKey: env.PHISHTANK_APP_KEY },
      deps.fetch ?? ((i, init) => fetch(i, init)),
    );
    return c.json({ results });
  });

  app.get('/admin/brands', async (c) =>
    c.json({ data: registry.list(), overrides: await deps.handle.db.select().from(brandOverrides) }),
  );

  app.put('/admin/brands/:id', jsonLimit, async (c) => {
    const id = c.req.param('id');
    if (!/^[a-z0-9_-]{2,40}$/.test(id))
      throw new AppError('bad_request', 'Brand id must be 2–40 chars of a-z, 0-9, _ or -');
    const body = await parseJson(c, brandBody);
    const row = {
      brandId: id,
      name: body.name ?? null,
      category: body.category ?? null,
      officialDomains: (body.officialDomains ?? []).map((d) => d.toLowerCase()),
      keywords: body.keywords ?? [],
      mentions: body.mentions ?? [],
      disabled: body.disabled ?? false,
      updatedAt: new Date(),
    };
    await deps.handle.db
      .insert(brandOverrides)
      .values(row)
      .onConflictDoUpdate({ target: brandOverrides.brandId, set: row });
    await ctx.reloadBrands();
    return c.json({
      brand: registry.get(id) ?? null,
      override: (await deps.handle.db.select().from(brandOverrides).where(eq(brandOverrides.brandId, id)))[0],
    });
  });

  // ------------------------------------------------------------------ Telegram bot webhook
  app.post('/channels/telegram', jsonLimit, async (c) => {
    if (!env.TELEGRAM_WEBHOOK_SECRET) throw new AppError('not_found', 'Telegram channel is not configured');
    const secret = c.req.header('x-telegram-bot-api-secret-token') ?? '';
    if (!safeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET))
      throw new AppError('unauthorized', 'Invalid Telegram secret token');
    const update = (await c.req.json().catch(() => null)) as TelegramUpdate | null;
    const msg = update?.message ?? update?.edited_message;
    if (!msg) return c.json({ ok: true });
    const input = classifyMessage(msg);
    const reply = (text: string) => c.json(sendMessage(msg.chat.id, text, msg.message_id));
    switch (input.kind) {
      case 'ignore':
        return c.json({ ok: true });
      case 'command':
        return reply(WELCOME_TEXT);
      case 'media_only':
        return reply(MEDIA_ONLY_TEXT);
    }
    const caller: Caller = { type: 'telegram', chatId: String(msg.chat.id) };
    try {
      const kind: CheckKind = input.kind;
      const { verdict } = await runCheck(
        c,
        kind,
        (cc) => {
          switch (input.kind) {
            case 'url':
              return service.checkUrl(input.value, cc);
            case 'phone':
              return service.checkPhone(input.value, cc);
            case 'bank_account':
              return service.checkBankAccount({ accountNumber: input.value }, cc);
            default:
              return service.checkText({ text: input.value, channel: 'telegram' }, cc);
          }
        },
        { caller, rawInput: input.value },
      );
      return reply(formatTelegramReply(verdict));
    } catch (err) {
      if (err instanceof AppError && err.code === 'rate_limited')
        return reply(rateLimitedText(env.SAFE_TELEGRAM_DAILY_CHECKS));
      if (err instanceof AppError && err.code === 'bad_request' && input.kind === 'url') {
        // Not a valid link after all: check it as a message.
        const { verdict } = await runCheck(
          c,
          'text',
          (cc) => service.checkText({ text: input.value, channel: 'telegram' }, cc),
          { caller, rawInput: input.value },
        ).catch(() => ({ verdict: null }));
        if (verdict) return reply(formatTelegramReply(verdict));
      }
      logger.error('telegram_check_failed', { err: (err as Error).message });
      return reply(ERROR_TEXT);
    }
  });

  return app;
}
