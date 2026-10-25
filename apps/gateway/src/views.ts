import { microsToUsd } from '@ok/shared';
import type { Catalog } from './catalog/catalog';
import type { Capabilities, Endpoint, Model } from './catalog/types';
import type { RequestRow } from './db/schema';
import type { ProviderSpec } from './providers/config';
import type { EndpointHealth } from './routing/health';

/** Serializers for public API responses. Upstream cost (our margin) is never exposed. */

const unionCaps = (eps: Endpoint[]): Capabilities =>
  eps.reduce<Capabilities>(
    (a, e) => ({
      tools: a.tools || e.capabilities.tools,
      vision: a.vision || e.capabilities.vision,
      json: a.json || e.capabilities.json,
      streaming: a.streaming || e.capabilities.streaming,
    }),
    { tools: false, vision: false, json: false, streaming: false },
  );

export function modelView(m: Model, includeDisabled: boolean) {
  const eps = m.endpoints.filter((e) => includeDisabled || e.enabled);
  const priced = (eps.some((e) => e.enabled) ? eps.filter((e) => e.enabled) : eps).sort(
    (a, b) => a.price.input + a.price.output - (b.price.input + b.price.output),
  );
  const cheapest = priced[0];
  return {
    id: m.id,
    object: 'model' as const,
    name: m.name,
    type: m.type,
    owned_by: m.id.split('/')[0],
    ...(m.description ? { description: m.description } : {}),
    context_length: eps.length ? Math.max(...eps.map((e) => e.contextLength)) : null,
    pricing: cheapest
      ? { prompt: cheapest.price.input, completion: cheapest.price.output, unit: 'USD per 1M tokens' }
      : null,
    capabilities: unionCaps(eps),
    available: eps.some((e) => e.enabled),
    ...(m.auto ? { tiers: m.auto.tiers } : {}),
    ...(m.aliases?.length ? { aliases: m.aliases } : {}),
    providers: eps.map((e) => ({
      provider: e.provider,
      context_length: e.contextLength,
      ...(e.maxOutputTokens ? { max_output_tokens: e.maxOutputTokens } : {}),
      pricing: { prompt: e.price.input, completion: e.price.output },
      capabilities: e.capabilities,
      enabled: e.enabled,
      verified: e.verified ?? false,
    })),
  };
}

export const AUTO_MODELS = [
  {
    id: 'auto',
    name: 'Auto router',
    description:
      'Classifies each request (length, code, math/reasoning, tools, images, language, JSON) and picks the best-value enabled model for its tier.',
  },
  {
    id: 'auto:cheap',
    name: 'Auto router (cheap)',
    description: 'Like auto, one tier cheaper; picks the cheapest model in the tier.',
  },
  {
    id: 'auto:best',
    name: 'Auto router (best)',
    description: 'Like auto, one tier stronger; picks the highest-quality model in the tier.',
  },
].map((m) => ({
  ...m,
  object: 'model' as const,
  type: 'chat' as const,
  owned_by: 'gateway',
  pricing: null,
  available: true,
  providers: [],
}));

export function modelsList(
  catalog: Catalog,
  opts: { type?: 'chat' | 'embedding'; includeDisabled: boolean },
) {
  const models = catalog
    .list({ type: opts.type, includeDisabled: opts.includeDisabled })
    .map((m) => modelView(m, opts.includeDisabled));
  return { object: 'list' as const, data: opts.type === 'embedding' ? models : [...AUTO_MODELS, ...models] };
}

export function requestSummary(r: RequestRow) {
  return {
    id: r.id,
    object: 'generation' as const,
    created_at: r.createdAt.toISOString(),
    kind: r.kind,
    product: r.product,
    api_key_id: r.apiKeyId,
    requested_model: r.requestedModel,
    model: r.model,
    provider: r.provider,
    status: r.status,
    error: r.error,
    finish_reason: r.finishReason,
    stream: r.stream,
    usage: {
      prompt_tokens: r.promptTokens,
      completion_tokens: r.completionTokens,
      total_tokens: r.promptTokens + r.completionTokens,
      estimated: r.usageEstimated,
    },
    cost_micros: r.costMicros,
    cost_usd: microsToUsd(r.costMicros),
    latency_ms: r.latencyMs,
    ttft_ms: r.ttftMs,
    attempt_count: r.attempts.length,
  };
}

export function generationDetail(r: RequestRow) {
  return {
    ...requestSummary(r),
    fallback_count: Math.max(0, r.attempts.length - 1),
    attempts: r.attempts,
    routing: r.routing,
  };
}

export function endpointHealthView(e: Endpoint, h: EndpointHealth) {
  return {
    endpoint: e.id,
    model: e.modelId,
    provider: e.provider,
    upstream_model: e.upstreamModel,
    verified: e.verified ?? false,
    circuit: h.circuit,
    available: h.available,
    degraded: h.degraded,
    requests: h.requests,
    successes: h.successes,
    failures: h.failures,
    success_rate: h.successRate,
    p50_latency_ms: h.p50LatencyMs,
    p95_latency_ms: h.p95LatencyMs,
    p50_ttft_ms: h.p50TtftMs,
    p95_ttft_ms: h.p95TtftMs,
    tokens_per_sec: h.tokensPerSec,
    consecutive_failures: h.consecutiveFailures,
    opened_at: h.openedAt,
    blocked_until: h.blockedUntil,
    last_error: h.lastError,
    last_success_at: h.lastSuccessAt,
  };
}

export function providerView(p: ProviderSpec) {
  return { id: p.id, name: p.name, kind: p.kind, enabled: p.enabled, verified: p.verified };
}
