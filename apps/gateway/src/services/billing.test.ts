import { describe, expect, it } from 'vitest';
import { computeCost, resolveProduct, resolveUsage } from './billing';

describe('computeCost', () => {
  it('prices each side per 1M tokens in micro-USD, rounding up', () => {
    const ep = { price: { input: 2.5, output: 10 }, cost: { input: 2, output: 8 } };
    expect(computeCost({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }, ep)).toEqual({
      costMicros: 12_500_000,
      upstreamCostMicros: 10_000_000,
    });
    expect(computeCost({ prompt_tokens: 1234, completion_tokens: 567 }, ep)).toEqual({
      costMicros: 3085 + 5670,
      upstreamCostMicros: 2468 + 4536,
    });
    expect(
      computeCost(
        { prompt_tokens: 1, completion_tokens: 1 },
        { price: { input: 0.15, output: 0.6 }, cost: { input: 0, output: 0 } },
      ),
    ).toEqual({ costMicros: 2, upstreamCostMicros: 0 });
    expect(computeCost({ prompt_tokens: 0, completion_tokens: 0 }, ep)).toEqual({
      costMicros: 0,
      upstreamCostMicros: 0,
    });
  });
});

describe('resolveUsage', () => {
  it('prefers upstream usage and flags estimates', () => {
    expect(
      resolveUsage({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }, () => ({
        prompt: 1,
        completion: 1,
      })),
    ).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, estimated: false });
    expect(resolveUsage(undefined, () => ({ prompt: 7, completion: 3 }))).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
      estimated: true,
    });
  });
});

describe('resolveProduct', () => {
  it('lets only internal callers attribute usage to another valid product', () => {
    expect(resolveProduct({ orgId: 'o', via: 'internal' }, 'agents')).toBe('agents');
    expect(resolveProduct({ orgId: 'o', via: 'internal' }, ' Review ')).toBe('review');
    expect(resolveProduct({ orgId: 'o', via: 'internal' }, 'unknown')).toBe('gateway');
    expect(resolveProduct({ orgId: 'o', via: 'internal' }, undefined)).toBe('gateway');
    expect(resolveProduct({ orgId: 'o', via: 'api_key' }, 'agents')).toBe('gateway');
  });
});
