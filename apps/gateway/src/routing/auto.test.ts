import { describe, expect, it } from 'vitest';
import { Catalog } from '../catalog/catalog';
import { DEFAULT_CATALOG } from '../catalog/default';
import { resolveProviders } from '../providers/config';
import type { ChatCompletionRequest } from '../schemas';
import { adjustTier, autoRoute, classify, extractSignals, isVietnamese, parseAutoModel } from './auto';
import { requirementsFor } from './select';

/** No credentials ⇒ every catalog model is served by the mock provider (all enabled). */
const offline = new Catalog(DEFAULT_CATALOG, resolveProviders({ env: {} }));

const user = (content: string, extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest => ({
  model: 'auto',
  messages: [{ role: 'user', content }],
  ...extra,
});

const tierOf = (req: ChatCompletionRequest) => classify(extractSignals(req, requirementsFor(req))).tier;
const route = (
  req: ChatCompletionRequest,
  variant: 'default' | 'cheap' | 'best' = 'default',
  catalog = offline,
) => autoRoute(req, catalog, variant, requirementsFor(req));

describe('parseAutoModel', () => {
  it('recognises auto variants only', () => {
    expect(parseAutoModel('auto')).toBe('default');
    expect(parseAutoModel('AUTO:cheap')).toBe('cheap');
    expect(parseAutoModel('auto:best')).toBe('best');
    expect(parseAutoModel('auto:fast')).toBeNull();
    expect(parseAutoModel('openai/gpt-4o')).toBeNull();
  });
});

describe('Vietnamese detection', () => {
  it('detects Vietnamese and not other Latin-script languages', () => {
    expect(isVietnamese('Xin chào, bạn có khỏe không?')).toBe(true);
    expect(isVietnamese('Tôi muốn đặt một bàn cho hai người tối nay')).toBe(true);
    // decomposed (NFD) input is normalized first
    expect(isVietnamese('Cảm ơn bạn rất nhiều'.normalize('NFD'))).toBe(true);
    expect(isVietnamese('Hello, how are you today?')).toBe(false);
    expect(isVietnamese('Ça va très bien, merci beaucoup à vous')).toBe(false);
    expect(isVietnamese('¿Dónde está la estación de tren?')).toBe(false);
  });
});

describe('classifier tiers', () => {
  it('fast: greetings and short simple prompts', () => {
    expect(tierOf(user('hi!'))).toBe('fast');
    expect(tierOf(user('What is the capital of France?'))).toBe('fast');
    expect(tierOf(user('Xin chào'))).toBe('fast');
  });

  it('balanced: code, tools, JSON, images, moderate length', () => {
    expect(tierOf(user('Why does this fail?\n```ts\nconst x: number = "1";\n```'))).toBe('balanced');
    expect(tierOf(user('Viết hàm Python tính số Fibonacci thứ n'))).toBe('balanced');
    const tools = [
      { type: 'function' as const, function: { name: 'get_weather', parameters: { type: 'object' } } },
    ];
    expect(tierOf(user('Weather in Hanoi?', { tools }))).toBe('balanced');
    expect(tierOf(user('List three colors', { response_format: { type: 'json_object' } }))).toBe('balanced');
    expect(
      tierOf({
        model: 'auto',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image_url', image_url: { url: 'https://x/cat.png' } },
            ],
          },
        ],
      }),
    ).toBe('balanced');
    expect(tierOf(user(`Summarize: ${'lorem ipsum dolor sit amet '.repeat(300)}`))).toBe('balanced');
  });

  it('frontier: substantial code or complex analysis, very long prompts', () => {
    const bigCode = `\`\`\`python\n${'def f(x):\n    return x * 2\n'.repeat(700)}\`\`\`\nRefactor this module.`;
    expect(tierOf(user(bigCode))).toBe('frontier');
    expect(
      tierOf(
        user(
          'Design a comprehensive architecture for a multi-region payments platform and analyze the trade-offs.',
        ),
      ),
    ).toBe('frontier');
    expect(tierOf(user('word '.repeat(120_000)))).toBe('frontier');
  });

  it('reasoning: proofs, heavy math, explicit step-by-step problem solving', () => {
    expect(tierOf(user('Prove that the square root of 2 is irrational.'))).toBe('reasoning');
    expect(tierOf(user('Compute the integral of x^2 from 0 to 3, step by step.'))).toBe('reasoning');
    expect(tierOf(user('Chứng minh rằng có vô số số nguyên tố.'))).toBe('reasoning');
    expect(tierOf(user('Solve \\frac{x}{2} + 3 = 7 and calculate the probability that x is even'))).toBe(
      'reasoning',
    );
  });

  it('variants shift one tier', () => {
    expect(adjustTier('frontier', 'cheap')).toBe('balanced');
    expect(adjustTier('balanced', 'cheap')).toBe('fast');
    expect(adjustTier('reasoning', 'cheap')).toBe('reasoning');
    expect(adjustTier('fast', 'best')).toBe('balanced');
    expect(adjustTier('balanced', 'best')).toBe('frontier');
    expect(adjustTier('reasoning', 'best')).toBe('reasoning');
  });
});

describe('autoRoute', () => {
  const tierModels = (tier: string) =>
    offline
      .list({ type: 'chat' })
      .filter((m) => m.auto?.tiers.includes(tier as never))
      .map((m) => m.id);

  it('maps tiers to enabled catalog models with a short reason', () => {
    const d = route(user('hello there'));
    expect(d.tier).toBe('fast');
    expect(tierModels('fast')).toContain(d.models[0]);
    expect(d.models).toHaveLength(3);
    expect(d.models.some((m) => m.startsWith('mock/'))).toBe(false);
    expect(d.reason).toMatch(/^fast: .* → /);
    expect(d.reason).toContain(d.models[0]!);
  });

  it('is deterministic', () => {
    const req = user('Explain the trade-offs between Raft and Paxos in detail.');
    expect(route(req)).toEqual(route(req));
  });

  it('prefers models strong in what the request needs (code, multilingual)', () => {
    const code = route(user('Fix this bug:\n```js\nconst a = [1,2,3].map(x => x * 2;\n```'));
    expect(code.tier).toBe('balanced');
    expect(offline.get(code.models[0]!)!.auto!.strengths).toContain('code');
    const vi = route(user('Xin chào, hôm nay thời tiết ở Hà Nội thế nào?'));
    expect(vi.signals.vietnamese).toBe(true);
    expect(vi.reason).toContain('Vietnamese');
    expect(offline.get(vi.models[0]!)!.auto!.strengths).toContain('multilingual');
  });

  it('only picks models whose enabled endpoints satisfy hard requirements', () => {
    const req: ChatCompletionRequest = {
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe the image' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    };
    for (const id of route(req).models) {
      expect(offline.get(id)!.endpoints.some((e) => e.enabled && e.capabilities.vision)).toBe(true);
    }
  });

  it('auto:cheap picks the cheapest model of the cheaper tier; auto:best the strongest of the higher tier', () => {
    const req = user(
      'Design a comprehensive architecture for a ride-sharing backend and evaluate the trade-offs.',
    );
    const cheap = route(req, 'cheap');
    expect(cheap.tier).toBe('balanced');
    const priceOf = (id: string) =>
      Math.min(
        ...offline
          .get(id)!
          .endpoints.filter((e) => e.enabled)
          .map((e) => (3 * e.price.input + e.price.output) / 4),
      );
    const balancedPrices = tierModels('balanced').map(priceOf);
    expect(priceOf(cheap.models[0]!)).toBe(Math.min(...balancedPrices));

    const best = route(user('hey'), 'best');
    expect(best.tier).toBe('balanced');
    const bestQuality = Math.max(
      ...offline
        .list({ type: 'chat' })
        .filter((m) => m.auto?.tiers.includes('balanced'))
        .map((m) => m.auto!.quality),
    );
    expect(offline.get(best.models[0]!)!.auto!.quality).toBe(bestQuality);
  });

  it('respects which providers are actually configured', () => {
    const groqOnly = new Catalog(DEFAULT_CATALOG, resolveProviders({ env: { GROQ_API_KEY: 'k' } }));
    expect(groqOnly.mockFallback).toBe(false);
    const d = route(user('Prove that there are infinitely many primes.'), 'default', groqOnly);
    expect(d.tier).toBe('reasoning');
    expect(d.models.length).toBeGreaterThan(0);
    for (const id of d.models) {
      const providers = groqOnly
        .get(id)!
        .endpoints.filter((e) => e.enabled)
        .map((e) => e.provider);
      expect(providers.some((p) => p === 'groq')).toBe(true);
    }
  });

  it('walks to neighbouring tiers when the requested tier has no enabled model', () => {
    const groqOnly = new Catalog(DEFAULT_CATALOG, resolveProviders({ env: { GROQ_API_KEY: 'k' } }));
    // No groq model is tagged frontier.
    const d = route(
      user('Design a comprehensive architecture and analyze trade-offs for a bank core system.'),
      'default',
      groqOnly,
    );
    expect(d.tier).toBe('frontier');
    expect(d.models.length).toBeGreaterThan(0);
    expect(d.reason).toMatch(/no enabled frontier model/);
  });

  it('falls back to mock/echo only when nothing else is enabled', () => {
    const mockOnly = new Catalog(DEFAULT_CATALOG, resolveProviders({ env: {} }), { mockMode: 'never' });
    expect(route(user('hi'), 'default', mockOnly).models).toEqual(['mock/echo']);
  });
});
