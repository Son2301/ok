import type { Endpoint, Model } from '../catalog/types';
import type { ChatCompletionRequest, ProviderPrefs } from '../schemas';
import type { EndpointHealth } from './health';
import { countImages, estimatePromptTokens } from './tokens';

/** Hard requirements an endpoint must meet to serve a request. */
export interface Requirements {
  tools: boolean;
  vision: boolean;
  json: boolean;
  streaming: boolean;
  promptTokens: number;
  /** Requested completion budget (max_tokens / max_completion_tokens). */
  maxOutputTokens?: number;
}

/** Infer requirements from a chat request: tools → tool support, image parts → vision, response_format → JSON. */
export function requirementsFor(req: ChatCompletionRequest): Requirements {
  const imgs = countImages(req.messages);
  const toolHistory = req.messages.some((m) => m.role === 'tool' || (m.tool_calls?.length ?? 0) > 0);
  const rf = req.response_format?.type;
  return {
    tools: Boolean(req.tools?.length) || toolHistory,
    vision: imgs.low + imgs.high > 0,
    json: rf === 'json_object' || rf === 'json_schema',
    streaming: Boolean(req.stream),
    promptTokens: estimatePromptTokens(req),
    maxOutputTokens: req.max_completion_tokens ?? req.max_tokens,
  };
}

export const NO_REQUIREMENTS: Requirements = {
  tools: false,
  vision: false,
  json: false,
  streaming: false,
  promptTokens: 0,
};

/** Read-only view of endpoint health used by routing (HealthTracker implements it). */
export interface HealthView {
  isAvailable(id: string): boolean;
  isDegraded(id: string): boolean;
  stats(id: string): Pick<EndpointHealth, 'p50TtftMs' | 'p50LatencyMs' | 'tokensPerSec' | 'successRate'>;
}

export interface Skip {
  endpoint: string;
  reason: string;
}

export interface SelectionResult {
  endpoints: Endpoint[];
  skipped: Skip[];
}

export interface SelectOptions {
  /** RNG for the default price-weighted shuffle (inject for deterministic tests). */
  random?: () => number;
}

/** Why an endpoint cannot serve the request, or null if it can (capabilities + context window). */
export function capabilityMismatch(e: Endpoint, r: Requirements): string | null {
  if (r.tools && !e.capabilities.tools) return 'does not support tools';
  if (r.vision && !e.capabilities.vision) return 'does not support image input';
  if (r.json && !e.capabilities.json) return 'does not support JSON response_format';
  if (r.streaming && !e.capabilities.streaming) return 'does not support streaming';
  if (r.maxOutputTokens && e.maxOutputTokens && r.maxOutputTokens > e.maxOutputTokens) {
    return `max_tokens ${r.maxOutputTokens} exceeds endpoint limit ${e.maxOutputTokens}`;
  }
  const needed = r.promptTokens + (r.maxOutputTokens ?? 0);
  if (needed > e.contextLength) return `needs ~${needed} tokens, context window is ${e.contextLength}`;
  return null;
}

const norm = (s: string) => s.trim().toLowerCase();
/** A provider preference entry matches the provider id or the full endpoint id. */
export const matchesProvider = (e: Endpoint, name: string) =>
  norm(name) === e.provider || norm(name) === e.id.toLowerCase();

/** Expected USD cost of serving this request on `e` (price per 1M × estimated tokens). */
export function expectedCost(e: Endpoint, r: Requirements): number {
  const out = Math.min(r.maxOutputTokens ?? 500, 2_000);
  return (e.price.input * Math.max(r.promptTokens, 1) + e.price.output * out) / 1e6;
}

const byPrice = (r: Requirements) => (a: Endpoint, b: Endpoint) => expectedCost(a, r) - expectedCost(b, r);

/** Sort by a metric, endpoints without data last; ties broken by price. */
function byMetric(r: Requirements, metric: (e: Endpoint) => number | null, dir: 'asc' | 'desc') {
  return (a: Endpoint, b: Endpoint) => {
    const ma = metric(a);
    const mb = metric(b);
    if (ma === null && mb === null) return byPrice(r)(a, b);
    if (ma === null) return 1;
    if (mb === null) return -1;
    if (ma !== mb) return dir === 'asc' ? ma - mb : mb - ma;
    return byPrice(r)(a, b);
  };
}

/**
 * Default ordering (no `sort`): like OpenRouter — endpoints without recent
 * trouble first, sampled without replacement with weight ∝ 1/price²; degraded
 * endpoints follow, cheapest first.
 */
export function weightedOrder(
  endpoints: Endpoint[],
  r: Requirements,
  health: HealthView,
  random: () => number,
): Endpoint[] {
  const healthy = endpoints.filter((e) => !health.isDegraded(e.id));
  const degraded = endpoints.filter((e) => health.isDegraded(e.id)).sort(byPrice(r));
  const pool = healthy.map((e) => ({ e, w: 1 / Math.max(expectedCost(e, r), 1e-9) ** 2 }));
  const out: Endpoint[] = [];
  while (pool.length) {
    const total = pool.reduce((s, x) => s + x.w, 0);
    let pick = random() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      pick -= pool[i]!.w;
      if (pick < 0) {
        idx = i;
        break;
      }
    }
    out.push(pool[idx]!.e);
    pool.splice(idx, 1);
  }
  return [...out, ...degraded];
}

export function sortEndpoints(
  endpoints: Endpoint[],
  sort: ProviderPrefs['sort'],
  r: Requirements,
  health: HealthView,
  random: () => number,
): Endpoint[] {
  const list = [...endpoints];
  switch (sort) {
    case 'price':
      return list.sort(byPrice(r));
    case 'latency':
      return list.sort(
        byMetric(r, (e) => health.stats(e.id).p50TtftMs ?? health.stats(e.id).p50LatencyMs, 'asc'),
      );
    case 'throughput':
      return list.sort(byMetric(r, (e) => health.stats(e.id).tokensPerSec, 'desc'));
    case 'uptime':
      return list.sort(byMetric(r, (e) => health.stats(e.id).successRate, 'desc'));
    default:
      return weightedOrder(list, r, health, random);
  }
}

/**
 * Pure endpoint selection for one model: filter by provider preferences,
 * capabilities, context window and circuit state, then order by `order` and
 * `sort` (or the default price/health weighting).
 */
export function selectEndpoints(
  model: Model,
  r: Requirements,
  prefs: ProviderPrefs | undefined,
  health: HealthView,
  opts: SelectOptions = {},
): SelectionResult {
  const skipped: Skip[] = [];
  const eligible: Endpoint[] = [];
  for (const e of model.endpoints) {
    if (!e.enabled) continue; // provider not configured; not interesting for routing traces
    if (prefs?.only?.length && !prefs.only.some((p) => matchesProvider(e, p))) {
      skipped.push({ endpoint: e.id, reason: 'excluded by provider.only' });
      continue;
    }
    if (prefs?.ignore?.some((p) => matchesProvider(e, p))) {
      skipped.push({ endpoint: e.id, reason: 'excluded by provider.ignore' });
      continue;
    }
    const mismatch = capabilityMismatch(e, r);
    if (mismatch) {
      skipped.push({ endpoint: e.id, reason: mismatch });
      continue;
    }
    if (!health.isAvailable(e.id)) {
      skipped.push({ endpoint: e.id, reason: 'unavailable (circuit open or rate limited)' });
      continue;
    }
    eligible.push(e);
  }

  const random = opts.random ?? Math.random;
  const ordered: Endpoint[] = [];
  for (const name of prefs?.order ?? []) {
    for (const e of eligible) if (matchesProvider(e, name) && !ordered.includes(e)) ordered.push(e);
  }
  const rest = sortEndpoints(
    eligible.filter((e) => !ordered.includes(e)),
    prefs?.sort,
    r,
    health,
    random,
  );

  let endpoints = [...ordered, ...rest];
  if (prefs?.allow_fallbacks === false) {
    const keep = prefs.order?.length ? ordered : endpoints.slice(0, 1);
    for (const e of endpoints)
      if (!keep.includes(e)) skipped.push({ endpoint: e.id, reason: 'provider.allow_fallbacks is false' });
    endpoints = keep;
  }
  return { endpoints, skipped };
}
