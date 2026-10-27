import type { Core } from '@minh/core';
import { AppError, type Logger, newId, type ProductId } from '@minh/shared';
import type { Catalog } from '../catalog/catalog';
import type { AttemptLog, NewRequestRow } from '../db/schema';
import { ProviderError, toProviderError } from '../providers/errors';
import type { ProviderAdapter } from '../providers/types';
import type { HealthTracker } from '../routing/health';
import { buildPlan, type Plan, type PlannedAttempt } from '../routing/plan';
import { NO_REQUIREMENTS, requirementsFor } from '../routing/select';
import { CHARS_PER_TOKEN, estimatePromptTokens, estimateTextTokens, messageText } from '../routing/tokens';
import type {
  ChatChunk,
  ChatCompletionRequest,
  ChatResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
} from '../schemas';
import { type Cost, computeCost, type ResolvedUsage, resolveUsage } from './billing';
import type { RequestLog } from './requests';

export interface GatewayConfig {
  /** Total budget for a non-streaming upstream call. */
  upstreamTimeoutMs: number;
  /** Streaming: time allowed until the first meaningful chunk (before we commit to an endpoint). */
  firstByteTimeoutMs: number;
  /** Streaming: maximum silence between chunks once streaming. */
  streamIdleTimeoutMs: number;
  /** Cap on endpoint attempts per request across all fallback models. */
  maxAttempts: number;
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  upstreamTimeoutMs: 300_000,
  firstByteTimeoutMs: 120_000,
  streamIdleTimeoutMs: 120_000,
  maxAttempts: 6,
};

export interface GatewayDeps {
  core: Pick<Core, 'getBalance' | 'debit'>;
  catalog: Catalog;
  adapters: Map<string, ProviderAdapter>;
  health: HealthTracker;
  requestLog: RequestLog;
  logger: Logger;
  config?: Partial<GatewayConfig>;
  /** Monotonic clock in ms (latency measurement). */
  clock?: () => number;
  /** Wall clock for `created_at`. */
  wallClock?: () => Date;
  random?: () => number;
}

export interface CallContext {
  orgId: string;
  apiKeyId?: string;
  product: ProductId;
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
}

export type ChatResult =
  | { kind: 'json'; body: Record<string, unknown>; headers: Record<string, string> }
  | { kind: 'stream'; response: Response };

/** All planned attempts failed (or one failed non-retryably). */
class AttemptsExhausted extends Error {
  constructor(
    readonly last: ProviderError | undefined,
    readonly attempts: AttemptLog[],
  ) {
    super(last?.message ?? 'No attempts possible');
  }
}

interface Started<T> {
  value: T;
  attempt: PlannedAttempt;
  attempts: AttemptLog[];
  ctrl: AbortController;
  startedAt: number;
  base: Pick<AttemptLog, 'model' | 'provider' | 'endpoint' | 'upstream_model'>;
  detach: () => void;
}

interface RowBase {
  id: string;
  ctx: CallContext;
  kind: 'chat' | 'embeddings';
  requestedModel: string;
  createdAt: Date;
  stream: boolean;
  routing?: Plan['routing'];
}

const KEY_LIKE = /\b(sk|pk|rk|key|token|bearer)[-_ ]?[A-Za-z0-9_-]{8,}/gi;

/** Upstream messages are shown to customers (error details, /v1/generation); never leak our credentials. */
export function sanitizeUpstreamMessage(pe: ProviderError): string {
  if (pe.kind === 'auth') return `Provider ${pe.provider} rejected the gateway's credentials`;
  return pe.message.replace(KEY_LIKE, '[redacted]').slice(0, 300);
}

function isMeaningful(c: ChatChunk): boolean {
  if (c.usage) return true;
  return c.choices.some((ch) => {
    const d = (ch.delta ?? {}) as Record<string, unknown>;
    const has = (k: string) => typeof d[k] === 'string' && (d[k] as string).length > 0;
    return (
      Boolean(ch.finish_reason) ||
      has('content') ||
      has('reasoning_content') ||
      has('reasoning') ||
      has('refusal') ||
      (Array.isArray(d.tool_calls) && d.tool_calls.length > 0)
    );
  });
}

function completionChars(choices: { message?: ChatResponse['choices'][number]['message'] }[]): number {
  return choices.reduce((n, c) => n + (c.message ? messageText(c.message).length : 0), 0);
}

function publicUsage(u: ResolvedUsage, cost: Cost) {
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    total_tokens: u.total_tokens,
    cost_micros: cost.costMicros,
    ...(u.estimated ? { estimated: true } : {}),
  };
}

/**
 * Request execution: plan → attempts with fallback → (stream) → usage & cost →
 * wallet debit → request log. Pure of HTTP concerns except for the SSE Response.
 */
export class Gateway {
  private readonly cfg: GatewayConfig;
  private readonly clock: () => number;
  private readonly wallClock: () => Date;

  constructor(private readonly deps: GatewayDeps) {
    this.cfg = { ...DEFAULT_GATEWAY_CONFIG, ...deps.config };
    this.clock = deps.clock ?? (() => performance.now());
    this.wallClock = deps.wallClock ?? (() => new Date());
  }

  private get health() {
    return this.deps.health;
  }

  private async ensureBalance(orgId: string) {
    const balance = await this.deps.core.getBalance(orgId);
    if (balance <= 0)
      throw new AppError('payment_required', 'Insufficient balance. Please top up your wallet.');
  }

  // ----------------------------------------------------------------- attempts

  /**
   * Try planned endpoints in order until one *starts* successfully. Retryable
   * failures fall through to the next endpoint/model; anything else stops.
   */
  private async start<T>(
    genId: string,
    plan: Plan,
    ctx: CallContext,
    timeoutMs: number,
    call: (
      a: PlannedAttempt,
      adapter: ProviderAdapter,
      signal: AbortSignal,
      /** Re-arm the attempt timeout (streams: reset on upstream activity). */
      rearm: (ms: number) => void,
    ) => Promise<T>,
  ): Promise<Started<T>> {
    const attempts: AttemptLog[] = [];
    let last: ProviderError | undefined;
    for (const a of plan.attempts) {
      const { endpoint, model } = a;
      const base = {
        model: model.id,
        provider: endpoint.provider,
        endpoint: endpoint.id,
        upstream_model: endpoint.upstreamModel,
      };
      if (ctx.signal.aborted) {
        throw new AttemptsExhausted(
          new ProviderError(endpoint.provider, 'aborted', 'Client disconnected'),
          attempts,
        );
      }
      const adapter = this.deps.adapters.get(endpoint.provider);
      if (!adapter) {
        attempts.push({
          ...base,
          status: 'error',
          error_kind: 'not_found',
          error: 'Provider adapter not configured',
          latency_ms: 0,
        });
        continue;
      }
      if (!this.health.tryAcquire(endpoint.id)) {
        last = new ProviderError(
          endpoint.provider,
          'circuit_open',
          'Circuit open or rate limited; endpoint skipped',
        );
        attempts.push({
          ...base,
          status: 'error',
          error_kind: 'circuit_open',
          error: last.message,
          latency_ms: 0,
        });
        continue;
      }

      const ctrl = new AbortController();
      const onClientAbort = () =>
        ctrl.abort(new ProviderError(endpoint.provider, 'aborted', 'Client disconnected'));
      ctx.signal.addEventListener('abort', onClientAbort, { once: true });
      const detach = () => ctx.signal.removeEventListener('abort', onClientAbort);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const rearm = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(
          () =>
            ctrl.abort(
              new ProviderError(
                endpoint.provider,
                'timeout',
                `No response from ${endpoint.provider} within ${ms}ms`,
              ),
            ),
          ms,
        );
      };
      rearm(timeoutMs);
      const startedAt = this.clock();
      try {
        const value = await call(a, adapter, ctrl.signal, rearm);
        clearTimeout(timer);
        return { value, attempt: a, attempts, ctrl, startedAt, base, detach };
      } catch (err) {
        clearTimeout(timer);
        detach();
        const pe = toProviderError(endpoint.provider, err, ctrl.signal);
        if (!ctrl.signal.aborted) ctrl.abort(); // release the upstream connection
        const latency = Math.round(this.clock() - startedAt);
        attempts.push({
          ...base,
          status: 'error',
          error_kind: pe.kind,
          ...(pe.status ? { http_status: pe.status } : {}),
          error: sanitizeUpstreamMessage(pe),
          latency_ms: latency,
        });
        if (pe.kind === 'aborted') {
          this.health.recordNeutral(endpoint.id, { responded: false });
          throw new AttemptsExhausted(pe, attempts);
        }
        if (pe.endpointFault) {
          this.health.recordFailure(endpoint.id, {
            kind: pe.kind,
            message: pe.message,
            retryAfterMs: pe.retryAfterMs,
            latencyMs: latency,
          });
        } else {
          this.health.recordNeutral(endpoint.id, { responded: true });
        }
        this.deps.logger.warn('upstream attempt failed', {
          gen: genId,
          endpoint: endpoint.id,
          kind: pe.kind,
          status: pe.status,
          retryable: pe.retryable,
          msg: pe.message.slice(0, 200),
        });
        last = pe;
        if (!pe.retryable) throw new AttemptsExhausted(pe, attempts);
      }
    }
    throw new AttemptsExhausted(last, attempts);
  }

  private clientError(err: AttemptsExhausted, genId: string): AppError {
    const { last, attempts } = err;
    const details = { generation_id: genId, attempts };
    if (!last)
      return new AppError(
        'upstream_error',
        'No upstream endpoint could be tried for this request',
        details,
        503,
      );
    if (last.kind === 'aborted')
      return new AppError('bad_request', 'Client closed the request', details, 499);
    if (last.kind === 'bad_request') {
      const status = last.status && last.status >= 400 && last.status < 500 ? last.status : 400;
      return new AppError(
        'bad_request',
        `Upstream ${last.provider} rejected the request: ${sanitizeUpstreamMessage(last)}`,
        details,
        status,
      );
    }
    const failed = attempts.filter((a) => a.status === 'error');
    const all = (...kinds: string[]) =>
      failed.length > 0 && failed.every((a) => kinds.includes(a.error_kind ?? ''));
    if (all('circuit_open'))
      return new AppError(
        'upstream_error',
        'All endpoints for this request are temporarily unavailable',
        details,
        503,
      );
    if (all('rate_limit', 'circuit_open'))
      return new AppError('rate_limited', `All providers are rate limited (last: ${last.provider})`, details);
    if (all('timeout', 'circuit_open'))
      return new AppError('timeout', `All providers timed out (last: ${last.provider})`, details);
    return new AppError(
      'upstream_error',
      `All upstream attempts failed (last: ${last.provider}: ${sanitizeUpstreamMessage(last)})`,
      details,
    );
  }

  // ------------------------------------------------------- billing & logging

  private async bill(ctx: CallContext, genId: string, cost: Cost, a: PlannedAttempt, u: ResolvedUsage) {
    if (cost.costMicros <= 0) return;
    try {
      await this.deps.core.debit(ctx.orgId, cost.costMicros, {
        product: ctx.product,
        apiKeyId: ctx.apiKeyId,
        ref: genId,
        idempotencyKey: `gateway:${genId}`,
        force: true, // post-paid: the work is done, never refuse to record it
        description: `${a.model.id} via ${a.endpoint.provider}`,
        meta: {
          model: a.model.id,
          provider: a.endpoint.provider,
          prompt_tokens: u.prompt_tokens,
          completion_tokens: u.completion_tokens,
          estimated: u.estimated,
        },
      });
    } catch (err) {
      // Revenue at risk: surface loudly for reconciliation (the request log row still carries cost_micros).
      this.deps.logger.error('wallet debit failed', {
        gen: genId,
        org: ctx.orgId,
        micros: cost.costMicros,
        err: (err as Error).message,
      });
    }
  }

  private async persist(
    base: RowBase,
    fields: Omit<
      NewRequestRow,
      'id' | 'orgId' | 'apiKeyId' | 'product' | 'kind' | 'requestedModel' | 'createdAt' | 'stream' | 'routing'
    >,
  ) {
    try {
      await this.deps.requestLog.insert({
        id: base.id,
        orgId: base.ctx.orgId,
        apiKeyId: base.ctx.apiKeyId ?? null,
        product: base.ctx.product,
        kind: base.kind,
        requestedModel: base.requestedModel,
        createdAt: base.createdAt,
        stream: base.stream,
        routing: (base.routing as unknown as Record<string, unknown>) ?? null,
        ...fields,
      });
    } catch (err) {
      this.deps.logger.error('request log insert failed', { gen: base.id, err: (err as Error).message });
    }
  }

  private async persistFailure(base: RowBase, err: unknown, t0: number) {
    const attempts = err instanceof AttemptsExhausted ? err.attempts : [];
    const aborted = err instanceof AttemptsExhausted && err.last?.kind === 'aborted';
    const message =
      err instanceof AttemptsExhausted
        ? err.last
          ? sanitizeUpstreamMessage(err.last)
          : err.message
        : (err as Error).message;
    await this.persist(base, {
      status: aborted ? 'aborted' : 'error',
      error: message.slice(0, 500),
      attempts,
      latencyMs: Math.round(this.clock() - t0),
    });
  }

  private headers(genId: string, a: PlannedAttempt): Record<string, string> {
    return {
      'x-generation-id': genId,
      'x-gateway-model': a.model.id,
      'x-gateway-provider': a.endpoint.provider,
    };
  }

  // --------------------------------------------------------------------- chat

  async chat(req: ChatCompletionRequest, ctx: CallContext): Promise<ChatResult> {
    const genId = newId('gen');
    const t0 = this.clock();
    const base: RowBase = {
      id: genId,
      ctx,
      kind: 'chat',
      requestedModel: req.model ?? req.models?.[0] ?? '',
      createdAt: this.wallClock(),
      stream: Boolean(req.stream),
    };

    await this.ensureBalance(ctx.orgId);
    const r = requirementsFor(req);
    let plan: Plan;
    try {
      plan = buildPlan(
        { model: req.model, models: req.models, provider: req.provider, type: 'chat' },
        this.deps.catalog,
        r,
        this.health,
        {
          maxAttempts: this.cfg.maxAttempts,
          random: this.deps.random,
          autoRequest: req,
        },
      );
    } catch (err) {
      await this.persistFailure(base, err, t0);
      throw err;
    }
    base.routing = plan.routing;
    return req.stream ? this.chatStream(req, ctx, plan, base, t0) : this.chatJson(req, ctx, plan, base, t0);
  }

  private async chatJson(
    req: ChatCompletionRequest,
    ctx: CallContext,
    plan: Plan,
    base: RowBase,
    t0: number,
  ): Promise<ChatResult> {
    let started: Started<ChatResponse>;
    try {
      started = await this.start(base.id, plan, ctx, this.cfg.upstreamTimeoutMs, (a, adapter, signal) =>
        adapter.chat(req, a.endpoint, { signal }),
      );
    } catch (err) {
      await this.persistFailure(base, err, t0);
      throw err instanceof AttemptsExhausted ? this.clientError(err, base.id) : err;
    }
    started.detach();
    const { value: res, attempt } = started;
    const now = this.clock();
    const usage = resolveUsage(res.usage, () => ({
      prompt: estimatePromptTokens(req),
      completion: Math.ceil(completionChars(res.choices) / CHARS_PER_TOKEN),
    }));
    const cost = computeCost(usage, attempt.endpoint);
    const attemptLatency = Math.round(now - started.startedAt);
    this.health.recordSuccess(attempt.endpoint.id, {
      latencyMs: attemptLatency,
      outputTokens: usage.completion_tokens,
    });
    started.attempts.push({ ...started.base, status: 'success', latency_ms: attemptLatency });

    await this.bill(ctx, base.id, cost, attempt, usage);
    await this.persist(base, {
      model: attempt.model.id,
      provider: attempt.endpoint.provider,
      status: 'success',
      finishReason: res.choices[0]?.finish_reason ?? null,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      usageEstimated: usage.estimated,
      costMicros: cost.costMicros,
      upstreamCostMicros: cost.upstreamCostMicros,
      latencyMs: Math.round(now - t0),
      ttftMs: Math.round(now - t0),
      attempts: started.attempts,
    });

    const body: Record<string, unknown> = {
      ...res,
      id: base.id,
      object: 'chat.completion',
      created: res.created ?? Math.floor(base.createdAt.getTime() / 1000),
      model: attempt.model.id,
      provider: attempt.endpoint.provider,
      choices: res.choices,
      usage: publicUsage(usage, cost),
    };
    if (plan.routing.auto) body.routing = { ...plan.routing.auto, model: attempt.model.id };
    return { kind: 'json', body, headers: this.headers(base.id, attempt) };
  }

  private async chatStream(
    req: ChatCompletionRequest,
    ctx: CallContext,
    plan: Plan,
    base: RowBase,
    t0: number,
  ): Promise<ChatResult> {
    type Opening = { it: AsyncIterator<ChatChunk>; buffered: ChatChunk[]; ended: boolean; firstAt: number };
    let started: Started<Opening>;
    try {
      // Buffer until the first meaningful chunk so failures before it can still fall back.
      // FIRST_BYTE_TIMEOUT bounds the wait for the first upstream event; after that, any
      // upstream activity (incl. heartbeats emitted for pings / thinking) re-arms the idle timeout.
      started = await this.start(
        base.id,
        plan,
        ctx,
        this.cfg.firstByteTimeoutMs,
        async (a, adapter, signal, rearm) => {
          const it = adapter.stream(req, a.endpoint, { signal })[Symbol.asyncIterator]();
          const buffered: ChatChunk[] = [];
          for (;;) {
            const n = await it.next();
            if (n.done) return { it, buffered, ended: true, firstAt: this.clock() };
            rearm(this.cfg.streamIdleTimeoutMs);
            buffered.push(n.value);
            if (isMeaningful(n.value)) return { it, buffered, ended: false, firstAt: this.clock() };
          }
        },
      );
    } catch (err) {
      await this.persistFailure(base, err, t0);
      throw err instanceof AttemptsExhausted ? this.clientError(err, base.id) : err;
    }

    const { attempt, ctrl } = started;
    const { it, buffered, ended, firstAt } = started.value;
    const provider = attempt.endpoint.provider;
    const includeUsage = req.stream_options?.include_usage !== false;
    const created = Math.floor(base.createdAt.getTime() / 1000);
    const enc = new TextEncoder();
    const sse = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);

    let upstreamUsage: ChatResponse['usage'];
    let chars = 0;
    let finishReason: string | null = null;
    let clientGone = false;

    const rewrite = (c: ChatChunk): Record<string, unknown> | null => {
      if (c.usage) upstreamUsage = c.usage;
      for (const ch of c.choices) {
        const d = (ch.delta ?? {}) as Record<string, unknown>;
        if (typeof d.content === 'string') chars += d.content.length;
        if (Array.isArray(d.tool_calls)) chars += JSON.stringify(d.tool_calls).length;
        if (ch.finish_reason) finishReason = ch.finish_reason;
      }
      if (!c.choices.length) return null; // usage-only / filter-only chunks; we emit our own usage chunk
      const out: Record<string, unknown> = { ...c, id: base.id, model: attempt.model.id, provider };
      delete out.usage;
      return out;
    };

    const nextWithIdleTimeout = async (): Promise<IteratorResult<ChatChunk>> => {
      const ms = this.cfg.streamIdleTimeoutMs;
      const timer = setTimeout(
        () =>
          ctrl.abort(new ProviderError(provider, 'timeout', `Stream from ${provider} stalled for ${ms}ms`)),
        ms,
      );
      try {
        return await it.next();
      } finally {
        clearTimeout(timer);
      }
    };

    const account = () => {
      const usage = resolveUsage(upstreamUsage, () => ({
        prompt: estimatePromptTokens(req),
        completion: Math.ceil(chars / CHARS_PER_TOKEN),
      }));
      return { usage, cost: computeCost(usage, attempt.endpoint) };
    };

    let outcome: { status: 'success' | 'partial' | 'aborted'; error?: ProviderError } = { status: 'success' };
    let delivered = false;
    let finalized = false;

    const finalize = async () => {
      if (finalized) return;
      finalized = true;
      started.detach();
      const now = this.clock();
      const { usage, cost } = account();
      const attemptLatency = Math.round(now - started.startedAt);
      // Buffering stops at the first meaningful chunk, so its arrival time is the TTFT.
      const ttftAttempt = Math.round(firstAt - started.startedAt);
      if (outcome.status === 'success') {
        this.health.recordSuccess(attempt.endpoint.id, {
          latencyMs: attemptLatency,
          ttftMs: ttftAttempt,
          outputTokens: usage.completion_tokens,
        });
      } else if (outcome.status === 'partial' && outcome.error?.endpointFault) {
        this.health.recordFailure(attempt.endpoint.id, {
          kind: outcome.error.kind,
          message: outcome.error.message,
          latencyMs: attemptLatency,
        });
      } else {
        this.health.recordNeutral(attempt.endpoint.id, { responded: true });
      }
      started.attempts.push({
        ...started.base,
        status: outcome.status === 'partial' ? 'error' : 'success',
        ...(outcome.error
          ? { error_kind: outcome.error.kind, error: `mid-stream: ${sanitizeUpstreamMessage(outcome.error)}` }
          : {}),
        latency_ms: attemptLatency,
        ttft_ms: ttftAttempt,
      });
      await this.bill(ctx, base.id, cost, attempt, usage);
      await this.persist(base, {
        model: attempt.model.id,
        provider,
        status: outcome.status,
        error:
          outcome.status === 'partial'
            ? sanitizeUpstreamMessage(outcome.error!)
            : outcome.status === 'aborted'
              ? 'Client disconnected'
              : null,
        finishReason: outcome.status === 'partial' ? 'error' : finishReason,
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        usageEstimated: usage.estimated,
        costMicros: cost.costMicros,
        upstreamCostMicros: cost.upstreamCostMicros,
        latencyMs: Math.round(now - t0),
        ttftMs: Math.round(firstAt - t0),
        attempts: started.attempts,
      });
      if (!ctrl.signal.aborted) ctrl.abort(); // free the upstream socket if still open
    };

    const events = async function* (this: Gateway): AsyncGenerator<Uint8Array> {
      try {
        try {
          for (const c of buffered) {
            const out = rewrite(c);
            if (out) yield sse(out);
          }
          if (!ended) {
            for (;;) {
              const n = await nextWithIdleTimeout();
              if (n.done) break;
              const out = rewrite(n.value);
              if (out) yield sse(out);
            }
          }
        } catch (err) {
          const pe = toProviderError(provider, err, ctrl.signal);
          if (clientGone || pe.kind === 'aborted') {
            outcome = { status: 'aborted' };
          } else {
            outcome = { status: 'partial', error: pe };
            this.deps.logger.warn('upstream failed mid-stream', {
              gen: base.id,
              endpoint: attempt.endpoint.id,
              kind: pe.kind,
              msg: pe.message.slice(0, 200),
            });
            yield sse({
              id: base.id,
              object: 'chat.completion.chunk',
              created,
              model: attempt.model.id,
              provider,
              choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
              error: {
                code: 'upstream_error',
                message: `Upstream ${provider} failed mid-stream: ${sanitizeUpstreamMessage(pe)}`,
              },
            });
          }
        }
        if (outcome.status !== 'aborted') {
          if (includeUsage) {
            const { usage, cost } = account();
            yield sse({
              id: base.id,
              object: 'chat.completion.chunk',
              created,
              model: attempt.model.id,
              provider,
              choices: [],
              usage: publicUsage(usage, cost),
              ...(plan.routing.auto ? { routing: { ...plan.routing.auto, model: attempt.model.id } } : {}),
            });
          }
          delivered = true;
          yield enc.encode('data: [DONE]\n\n');
        }
      } finally {
        // Reached on completion, on error, and when the consumer cancels mid-stream.
        if (!delivered && outcome.status === 'success') outcome = { status: 'aborted' };
        await finalize();
      }
    }.call(this);

    const logger = this.deps.logger;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await events.next();
          if (clientGone) return; // cancelled while this pull was pending; the stream is already closed
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (err) {
          logger.error('stream pipeline failed', { gen: base.id, err: (err as Error).message });
          try {
            controller.error(err);
          } catch {}
        }
      },
      async cancel() {
        clientGone = true;
        ctrl.abort(new ProviderError(provider, 'aborted', 'Client disconnected'));
        await events.return(undefined);
      },
    });

    return {
      kind: 'stream',
      response: new Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          ...this.headers(base.id, attempt),
        },
      }),
    };
  }

  // --------------------------------------------------------------- embeddings

  async embeddings(
    req: EmbeddingsRequest,
    ctx: CallContext,
  ): Promise<{ body: Record<string, unknown>; headers: Record<string, string> }> {
    const genId = newId('gen');
    const t0 = this.clock();
    const base: RowBase = {
      id: genId,
      ctx,
      kind: 'embeddings',
      requestedModel: req.model,
      createdAt: this.wallClock(),
      stream: false,
    };
    await this.ensureBalance(ctx.orgId);

    let plan: Plan;
    try {
      plan = buildPlan(
        { model: req.model, provider: req.provider, type: 'embedding' },
        this.deps.catalog,
        NO_REQUIREMENTS,
        this.health,
        {
          maxAttempts: this.cfg.maxAttempts,
          random: this.deps.random,
        },
      );
    } catch (err) {
      await this.persistFailure(base, err, t0);
      throw err;
    }
    base.routing = plan.routing;

    let started: Started<EmbeddingsResponse>;
    try {
      started = await this.start(genId, plan, ctx, this.cfg.upstreamTimeoutMs, (a, adapter, signal) => {
        if (!adapter.embeddings)
          throw new ProviderError(
            a.endpoint.provider,
            'not_found',
            `Provider ${a.endpoint.provider} does not support embeddings`,
          );
        return adapter.embeddings(req, a.endpoint, { signal });
      });
    } catch (err) {
      await this.persistFailure(base, err, t0);
      throw err instanceof AttemptsExhausted ? this.clientError(err, genId) : err;
    }
    started.detach();
    const { value: res, attempt } = started;
    const now = this.clock();
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const reported = res.usage
      ? {
          prompt_tokens: res.usage.prompt_tokens,
          completion_tokens: 0,
          total_tokens: res.usage.prompt_tokens,
        }
      : undefined;
    const usage = resolveUsage(reported, () => ({
      prompt: inputs.reduce<number>(
        (n, i) => n + (typeof i === 'string' ? estimateTextTokens(i) : Array.isArray(i) ? i.length : 1),
        0,
      ),
      completion: 0,
    }));
    const cost = computeCost(usage, attempt.endpoint);
    const latency = Math.round(now - started.startedAt);
    this.health.recordSuccess(attempt.endpoint.id, { latencyMs: latency });
    started.attempts.push({ ...started.base, status: 'success', latency_ms: latency });
    await this.bill(ctx, genId, cost, attempt, usage);
    await this.persist(base, {
      model: attempt.model.id,
      provider: attempt.endpoint.provider,
      status: 'success',
      promptTokens: usage.prompt_tokens,
      completionTokens: 0,
      usageEstimated: usage.estimated,
      costMicros: cost.costMicros,
      upstreamCostMicros: cost.upstreamCostMicros,
      latencyMs: Math.round(now - t0),
      attempts: started.attempts,
    });
    return {
      body: {
        object: 'list',
        id: genId,
        data: res.data,
        model: attempt.model.id,
        provider: attempt.endpoint.provider,
        usage: {
          prompt_tokens: usage.prompt_tokens,
          total_tokens: usage.prompt_tokens,
          cost_micros: cost.costMicros,
          ...(usage.estimated ? { estimated: true } : {}),
        },
      },
      headers: this.headers(genId, attempt),
    };
  }
}
