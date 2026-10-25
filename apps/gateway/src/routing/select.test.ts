import { describe, expect, it } from 'vitest';
import type { Capabilities, Endpoint, Model } from '../catalog/types';
import type { ChatCompletionRequest } from '../schemas';
import { HealthTracker } from './health';
import {
  capabilityMismatch,
  type Requirements,
  requirementsFor,
  selectEndpoints,
  weightedOrder,
} from './select';

const CAPS: Capabilities = { tools: true, vision: true, json: true, streaming: true };

function ep(provider: string, price: number, extra: Partial<Endpoint> = {}): Endpoint {
  return {
    id: `m/x@${provider}`,
    modelId: 'm/x',
    provider,
    upstreamModel: provider,
    price: { input: price, output: price * 2 },
    cost: { input: price / 2, output: price },
    contextLength: 128_000,
    capabilities: CAPS,
    enabled: true,
    ...extra,
  };
}

const model = (endpoints: Endpoint[]): Model => ({ id: 'm/x', name: 'X', type: 'chat', endpoints });
const R: Requirements = { tools: false, vision: false, json: false, streaming: false, promptTokens: 100 };
const ids = (eps: Endpoint[]) => eps.map((e) => e.provider);

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('requirementsFor', () => {
  it('infers capabilities and prompt size from the request', () => {
    const req: ChatCompletionRequest = {
      model: 'x',
      stream: true,
      max_tokens: 256,
      response_format: { type: 'json_object' },
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image_url', image_url: { url: 'https://x/y.png' } },
          ],
        },
      ],
    };
    const r = requirementsFor(req);
    expect(r).toMatchObject({ tools: true, vision: true, json: true, streaming: true, maxOutputTokens: 256 });
    expect(r.promptTokens).toBeGreaterThan(765); // one high-detail image
  });

  it('treats tool-call history as requiring tool support', () => {
    const r = requirementsFor({
      model: 'x',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        { role: 'tool', content: '42', tool_call_id: 'c1' },
      ],
    });
    expect(r.tools).toBe(true);
    expect(r.vision).toBe(false);
  });
});

describe('capabilityMismatch', () => {
  it('checks every capability, max output and the context window', () => {
    const noTools = ep('a', 1, { capabilities: { ...CAPS, tools: false } });
    expect(capabilityMismatch(noTools, { ...R, tools: true })).toMatch(/tools/);
    expect(
      capabilityMismatch(ep('a', 1, { capabilities: { ...CAPS, vision: false } }), { ...R, vision: true }),
    ).toMatch(/image/);
    expect(
      capabilityMismatch(ep('a', 1, { capabilities: { ...CAPS, json: false } }), { ...R, json: true }),
    ).toMatch(/JSON/);
    expect(
      capabilityMismatch(ep('a', 1, { capabilities: { ...CAPS, streaming: false } }), {
        ...R,
        streaming: true,
      }),
    ).toMatch(/streaming/);
    expect(
      capabilityMismatch(ep('a', 1, { maxOutputTokens: 1000 }), { ...R, maxOutputTokens: 2000 }),
    ).toMatch(/max_tokens/);
    expect(
      capabilityMismatch(ep('a', 1, { contextLength: 1000 }), {
        ...R,
        promptTokens: 900,
        maxOutputTokens: 200,
      }),
    ).toMatch(/context window/);
    expect(
      capabilityMismatch(ep('a', 1), { ...R, tools: true, vision: true, json: true, streaming: true }),
    ).toBeNull();
  });
});

describe('selectEndpoints', () => {
  const health = () => new HealthTracker();

  it('honors only / ignore and explains skips', () => {
    const m = model([ep('openai', 1), ep('azure', 1), ep('groq', 1)]);
    const only = selectEndpoints(m, R, { only: ['OpenAI', 'groq'] }, health(), { random: () => 0 });
    expect(ids(only.endpoints).sort()).toEqual(['groq', 'openai']);
    expect(only.skipped).toEqual([{ endpoint: 'm/x@azure', reason: 'excluded by provider.only' }]);
    const ignore = selectEndpoints(m, R, { ignore: ['azure'] }, health(), { random: () => 0 });
    expect(ids(ignore.endpoints)).not.toContain('azure');
  });

  it('skips disabled endpoints silently and capability mismatches with a reason', () => {
    const m = model([
      ep('a', 1, { enabled: false }),
      ep('b', 1, { capabilities: { ...CAPS, vision: false } }),
      ep('c', 1),
    ]);
    const sel = selectEndpoints(m, { ...R, vision: true }, undefined, health(), { random: () => 0 });
    expect(ids(sel.endpoints)).toEqual(['c']);
    expect(sel.skipped).toEqual([{ endpoint: 'm/x@b', reason: 'does not support image input' }]);
  });

  it('puts `order` first, then the rest; allow_fallbacks=false keeps only the ordered ones', () => {
    const m = model([ep('a', 1), ep('b', 5), ep('c', 3)]);
    const sel = selectEndpoints(m, R, { order: ['c', 'b'], sort: 'price' }, health());
    expect(ids(sel.endpoints)).toEqual(['c', 'b', 'a']);
    const strict = selectEndpoints(m, R, { order: ['c'], allow_fallbacks: false }, health());
    expect(ids(strict.endpoints)).toEqual(['c']);
    expect(strict.skipped.map((s) => s.reason)).toEqual([
      'provider.allow_fallbacks is false',
      'provider.allow_fallbacks is false',
    ]);
  });

  it('allow_fallbacks=false without order keeps only the top choice', () => {
    const m = model([ep('a', 3), ep('b', 1), ep('c', 2)]);
    const sel = selectEndpoints(m, R, { sort: 'price', allow_fallbacks: false }, health());
    expect(ids(sel.endpoints)).toEqual(['b']);
  });

  it('sort=price orders by expected request cost', () => {
    const m = model([ep('a', 3), ep('b', 1), ep('c', 2)]);
    expect(ids(selectEndpoints(m, R, { sort: 'price' }, health()).endpoints)).toEqual(['b', 'c', 'a']);
  });

  it('sort=latency uses observed p50 TTFT; endpoints without data go last (cheapest first)', () => {
    const h = health();
    for (let i = 0; i < 3; i++) {
      h.recordSuccess('m/x@a', { latencyMs: 900, ttftMs: 400 });
      h.recordSuccess('m/x@b', { latencyMs: 300, ttftMs: 80 });
    }
    const m = model([ep('a', 1), ep('b', 5), ep('c', 9), ep('d', 2)]);
    expect(ids(selectEndpoints(m, R, { sort: 'latency' }, h).endpoints)).toEqual(['b', 'a', 'd', 'c']);
  });

  it('sort=throughput prefers higher tokens/sec', () => {
    const h = health();
    h.recordSuccess('m/x@a', { latencyMs: 1100, ttftMs: 100, outputTokens: 50 }); // 50 tok/s
    h.recordSuccess('m/x@b', { latencyMs: 1100, ttftMs: 100, outputTokens: 400 }); // 400 tok/s
    const m = model([ep('a', 1), ep('b', 1)]);
    expect(ids(selectEndpoints(m, R, { sort: 'throughput' }, h).endpoints)).toEqual(['b', 'a']);
  });

  it('sort=uptime prefers higher success rate', () => {
    const h = health();
    h.recordSuccess('m/x@a', { latencyMs: 10 });
    h.recordFailure('m/x@a', { kind: 'server' });
    h.recordSuccess('m/x@b', { latencyMs: 10 });
    h.recordSuccess('m/x@b', { latencyMs: 10 });
    const m = model([ep('a', 1), ep('b', 2)]);
    expect(ids(selectEndpoints(m, R, { sort: 'uptime' }, h).endpoints)).toEqual(['b', 'a']);
  });

  it('skips endpoints whose circuit is open', () => {
    const h = new HealthTracker({ failureThreshold: 2 });
    h.recordFailure('m/x@a', { kind: 'server' });
    h.recordFailure('m/x@a', { kind: 'server' });
    const sel = selectEndpoints(model([ep('a', 1), ep('b', 2)]), R, undefined, h, { random: () => 0 });
    expect(ids(sel.endpoints)).toEqual(['b']);
    expect(sel.skipped[0]?.reason).toMatch(/circuit open/);
  });
});

describe('default (price × health) ordering', () => {
  it('samples with weight ∝ 1/price² (OpenRouter-style)', () => {
    const cheap = ep('cheap', 1);
    const pricey = ep('pricey', 2);
    const h = new HealthTracker();
    const random = rng(42);
    let cheapFirst = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) if (weightedOrder([pricey, cheap], R, h, random)[0] === cheap) cheapFirst++;
    // weights 1 : 1/4  ⇒  P(cheap first) = 0.8
    expect(cheapFirst / N).toBeGreaterThan(0.76);
    expect(cheapFirst / N).toBeLessThan(0.84);
  });

  it('always returns every endpoint exactly once', () => {
    const eps = [ep('a', 1), ep('b', 2), ep('c', 3), ep('d', 0)];
    const out = weightedOrder(eps, R, new HealthTracker(), rng(7));
    expect(new Set(out).size).toBe(4);
    expect(out[0]?.provider).toBe('d'); // free endpoints dominate
  });

  it('moves degraded endpoints behind healthy ones', () => {
    const h = new HealthTracker();
    h.recordFailure('m/x@cheap', { kind: 'server' });
    h.recordFailure('m/x@cheap', { kind: 'timeout' });
    const out = weightedOrder([ep('cheap', 0.1), ep('pricey', 10)], R, h, () => 0);
    expect(ids(out)).toEqual(['pricey', 'cheap']);
  });
});
