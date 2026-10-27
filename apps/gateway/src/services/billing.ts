import type { AuthContext } from '@minh/core';
import { PRODUCT_IDS, type ProductId, tokenCostMicros } from '@minh/shared';
import type { Endpoint } from '../catalog/types';
import type { UpstreamUsage } from '../schemas';

export interface ResolvedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** True when the upstream reported nothing and tokens were estimated (~chars/4). */
  estimated: boolean;
}

/** Use upstream-reported usage when present, else fall back to the estimate. */
export function resolveUsage(
  upstream: UpstreamUsage | undefined,
  estimate: () => { prompt: number; completion: number },
): ResolvedUsage {
  if (upstream && Number.isFinite(upstream.prompt_tokens)) {
    const prompt = Math.max(0, Math.round(upstream.prompt_tokens));
    const completion = Math.max(0, Math.round(upstream.completion_tokens || 0));
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      estimated: false,
    };
  }
  const e = estimate();
  return {
    prompt_tokens: e.prompt,
    completion_tokens: e.completion,
    total_tokens: e.prompt + e.completion,
    estimated: true,
  };
}

export interface Cost {
  /** What the customer pays, micro-USD. */
  costMicros: number;
  /** What the upstream charges us, micro-USD (internal). */
  upstreamCostMicros: number;
}

/** Exact cost from token counts and the endpoint's per-1M prices (each side rounded up). */
export function computeCost(
  usage: Pick<ResolvedUsage, 'prompt_tokens' | 'completion_tokens'>,
  endpoint: Pick<Endpoint, 'price' | 'cost'>,
): Cost {
  return {
    costMicros:
      tokenCostMicros(usage.prompt_tokens, endpoint.price.input) +
      tokenCostMicros(usage.completion_tokens, endpoint.price.output),
    upstreamCostMicros:
      tokenCostMicros(usage.prompt_tokens, endpoint.cost.input) +
      tokenCostMicros(usage.completion_tokens, endpoint.cost.output),
  };
}

/**
 * Product attribution: platform services calling with the internal token may
 * bill usage to their own product via `x-minh-product`; everyone else is `gateway`.
 */
export function resolveProduct(auth: AuthContext, header: string | undefined): ProductId {
  const p = header?.trim().toLowerCase();
  if (auth.via === 'internal' && p && (PRODUCT_IDS as string[]).includes(p)) return p as ProductId;
  return 'gateway';
}
