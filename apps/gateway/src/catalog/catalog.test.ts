import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasRealProvider, KNOWN_PROVIDERS, resolveProviders } from '../providers/config';
import { Catalog, customProviders, loadCatalogFile, mergeCatalog } from './catalog';
import { DEFAULT_CATALOG } from './default';
import type { CatalogModel } from './types';

describe('default catalog integrity', () => {
  const known = new Set([...KNOWN_PROVIDERS.map((p) => p.id), 'mock']);

  it('has unique ids and only references known providers', () => {
    const ids = DEFAULT_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of DEFAULT_CATALOG) {
      expect(m.endpoints.length).toBeGreaterThan(0);
      for (const e of m.endpoints) expect(known.has(e.provider), `${m.id}@${e.provider}`).toBe(true);
    }
  });

  it('never prices below upstream cost and marks live endpoints unverified', () => {
    for (const m of DEFAULT_CATALOG) {
      for (const e of m.endpoints) {
        expect(e.price.input, `${m.id}@${e.provider}`).toBeGreaterThanOrEqual(e.cost.input);
        expect(e.price.output, `${m.id}@${e.provider}`).toBeGreaterThanOrEqual(e.cost.output);
        expect(e.contextLength).toBeGreaterThan(0);
        if (e.provider !== 'mock') expect(e.verified).toBe(false);
      }
    }
  });

  it('covers every auto tier with chat models and spans the required providers', () => {
    for (const tier of ['fast', 'balanced', 'frontier', 'reasoning'] as const) {
      expect(DEFAULT_CATALOG.some((m) => m.type === 'chat' && m.auto?.tiers.includes(tier))).toBe(true);
    }
    const used = new Set(DEFAULT_CATALOG.flatMap((m) => m.endpoints.map((e) => e.provider)));
    for (const p of [
      'openai',
      'azure',
      'anthropic',
      'google',
      'deepseek',
      'groq',
      'together',
      'fireworks',
      'openrouter',
      'dashscope',
      'byteplus',
      'xai',
      'mistral',
      'mock',
    ]) {
      expect(used.has(p), p).toBe(true);
    }
  });
});

describe('resolveProviders', () => {
  it('enables providers only when credentials exist; mock is always on', () => {
    const none = resolveProviders({ env: {} });
    expect(hasRealProvider(none)).toBe(false);
    expect(none.get('mock')!.enabled).toBe(true);
    expect(none.get('openai')!.enabled).toBe(false);

    const some = resolveProviders({
      env: {
        OPENAI_API_KEY: 'sk',
        OPENAI_BASE_URL: 'http://proxy/v1',
        GOOGLE_API_KEY: 'g',
        AZURE_OPENAI_API_KEY: 'a',
      },
    });
    expect(some.get('openai')).toMatchObject({ enabled: true, baseUrl: 'http://proxy/v1', apiKey: 'sk' });
    expect(some.get('google')!.enabled).toBe(true); // GOOGLE_API_KEY is accepted as an alias
    expect(some.get('azure')!.enabled).toBe(false); // key without AZURE_OPENAI_ENDPOINT
    expect(some.get('anthropic')!.apiVersion).toBe('2023-06-01');
    expect(hasRealProvider(some)).toBe(true);
  });

  it('adds custom providers whose key comes from a named env var', () => {
    const p = resolveProviders({
      env: { VLLM_KEY: 'x' },
      custom: {
        vllm: { kind: 'openai-compatible', baseUrl: 'http://vllm:8000/v1', apiKeyEnv: 'VLLM_KEY' },
        local: { kind: 'openai-compatible', baseUrl: 'http://ollama/v1', keyless: true },
      },
    });
    expect(p.get('vllm')).toMatchObject({ enabled: true, apiKey: 'x', supportsStreamUsage: true });
    expect(p.get('local')!.enabled).toBe(true);
    expect(() => resolveProviders({ env: {}, custom: { mock: { kind: 'mock' } } })).toThrow(
      /Invalid custom provider/,
    );
  });
});

describe('Catalog', () => {
  it('enables endpoints by provider credentials and lists only available models', () => {
    const c = new Catalog(DEFAULT_CATALOG, resolveProviders({ env: { ANTHROPIC_API_KEY: 'k' } }));
    expect(c.mockFallback).toBe(false);
    const sonnet = c.get('anthropic/claude-sonnet-4.6')!;
    expect(sonnet.endpoints.find((e) => e.provider === 'anthropic')!.enabled).toBe(true);
    expect(sonnet.endpoints.find((e) => e.provider === 'openrouter')!.enabled).toBe(false);
    expect(c.list().every((m) => m.endpoints.some((e) => e.enabled))).toBe(true);
    expect(c.list().some((m) => m.id === 'openai/gpt-4o')).toBe(false);
    expect(c.list({ includeDisabled: true }).some((m) => m.id === 'openai/gpt-4o')).toBe(true);
    expect(c.list({ type: 'embedding' }).map((m) => m.id)).toEqual(['mock/embed']);
  });

  it('falls back to mock endpoints priced like the real model when nothing is configured', () => {
    const c = new Catalog(DEFAULT_CATALOG, resolveProviders({ env: {} }));
    expect(c.mockFallback).toBe(true);
    const m = c.get('openai/gpt-4o')!;
    const mock = m.endpoints.find((e) => e.provider === 'mock')!;
    expect(mock).toMatchObject({
      enabled: true,
      upstreamModel: 'echo',
      price: m.endpoints[0]!.price,
      cost: { input: 0, output: 0 },
    });
    expect(
      c.get('openai/text-embedding-3-small')!.endpoints.find((e) => e.provider === 'mock')!.upstreamModel,
    ).toBe('embed');
    expect(
      new Catalog(DEFAULT_CATALOG, resolveProviders({ env: {} }), { mockMode: 'never' })
        .list()
        .map((m) => m.id)
        .sort(),
    ).toEqual(['mock/echo', 'mock/embed']);
  });

  it('resolves ids, aliases and bare names case-insensitively', () => {
    const c = new Catalog(DEFAULT_CATALOG, resolveProviders({ env: {} }));
    expect(c.get('openai/gpt-4o-mini')!.id).toBe('openai/gpt-4o-mini');
    expect(c.get('GPT-4o-mini')!.id).toBe('openai/gpt-4o-mini');
    expect(c.get('claude-sonnet-4-6')!.id).toBe('anthropic/claude-sonnet-4.6');
    expect(c.get('claude-opus')!.id).toBe('anthropic/claude-opus-5.5');
    expect(c.get('nope/nothing')).toBeUndefined();
    expect(c.endpoint('openai/gpt-4o@mock')).toBeDefined();
  });

  it('applies Azure deployment overrides and rejects unknown providers', () => {
    const providers = resolveProviders({
      env: { AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_ENDPOINT: 'https://r.openai.azure.com' },
    });
    const c = new Catalog(DEFAULT_CATALOG, providers, { azureDeployments: { 'openai/gpt-4o': 'prod-4o' } });
    expect(c.endpoint('openai/gpt-4o@azure')).toMatchObject({ upstreamModel: 'prod-4o', enabled: true });
    expect(c.endpoint('openai/gpt-4o-mini@azure')!.upstreamModel).toBe('gpt-4o-mini');
    const bad: CatalogModel[] = [
      {
        id: 'x/y',
        name: 'Y',
        type: 'chat',
        endpoints: [{ ...DEFAULT_CATALOG[0]!.endpoints[0]!, provider: 'nope' }],
      },
    ];
    expect(() => new Catalog(bad, providers)).toThrow(/unknown provider "nope"/);
  });
});

describe('catalog overrides (CATALOG_PATH)', () => {
  const base: CatalogModel[] = [
    {
      id: 'v/m',
      name: 'M',
      type: 'chat',
      endpoints: [
        {
          provider: 'openai',
          upstreamModel: 'm',
          price: { input: 1, output: 2 },
          cost: { input: 0.5, output: 1 },
          contextLength: 1000,
          capabilities: { tools: true, vision: false, json: true, streaming: true },
        },
        {
          provider: 'groq',
          upstreamModel: 'm-groq',
          price: { input: 1, output: 1 },
          cost: { input: 1, output: 1 },
          contextLength: 1000,
          capabilities: { tools: false, vision: false, json: false, streaming: true },
        },
      ],
    },
    { id: 'v/gone', name: 'Gone', type: 'chat', endpoints: [] },
  ];

  it('merges endpoints by provider, adds/removes endpoints and models', () => {
    const out = mergeCatalog(base, {
      remove: ['v/gone'],
      models: [
        {
          id: 'v/m',
          name: 'M2',
          endpoints: [
            { provider: 'openai', price: { input: 3, output: 4 }, capabilities: { vision: true } },
            { provider: 'groq', remove: true },
            { provider: 'together', upstreamModel: 't', price: { input: 2, output: 2 }, contextLength: 500 },
          ],
        },
        {
          id: 'v/new',
          name: 'New',
          type: 'embedding',
          endpoints: [
            { provider: 'openai', upstreamModel: 'e', price: { input: 0.1, output: 0 }, contextLength: 8000 },
          ],
        },
      ],
    });
    expect(out.map((m) => m.id)).toEqual(['v/m', 'v/new']);
    const m = out[0]!;
    expect(m.name).toBe('M2');
    expect(m.endpoints.map((e) => e.provider)).toEqual(['openai', 'together']);
    expect(m.endpoints[0]).toMatchObject({
      upstreamModel: 'm',
      price: { input: 3, output: 4 },
      cost: { input: 0.5, output: 1 },
      capabilities: { tools: true, vision: true },
    });
    expect(m.endpoints[1]).toMatchObject({
      cost: { input: 2, output: 2 },
      capabilities: { tools: false, streaming: true },
      verified: false,
    });
    expect(base[0]!.endpoints).toHaveLength(2); // input untouched
  });

  it('can replace endpoint lists and validates new entries', () => {
    const out = mergeCatalog(base, {
      models: [
        {
          id: 'v/m',
          replaceEndpoints: true,
          endpoints: [
            { provider: 'mistral', upstreamModel: 'x', price: { input: 1, output: 1 }, contextLength: 10 },
          ],
        },
      ],
    });
    expect(out[0]!.endpoints.map((e) => e.provider)).toEqual(['mistral']);
    expect(() => mergeCatalog(base, { models: [{ id: 'v/m', endpoints: [{ provider: 'xai' }] }] })).toThrow(
      /needs upstreamModel/,
    );
    expect(() => mergeCatalog(base, { models: [{ id: 'v/other' }] })).toThrow(/needs a name/);
  });

  it('loads and validates a JSON file, including custom providers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-catalog-'));
    const good = join(dir, 'catalog.json');
    writeFileSync(
      good,
      JSON.stringify({
        providers: {
          vllm: { kind: 'openai-compatible', baseUrl: 'http://vllm:8000/v1', apiKeyEnv: 'VLLM_KEY' },
        },
        models: [
          {
            id: 'local/llama',
            name: 'Local Llama',
            endpoints: [
              {
                provider: 'vllm',
                upstreamModel: 'llama',
                price: { input: 0.1, output: 0.1 },
                contextLength: 8192,
              },
            ],
          },
        ],
      }),
    );
    const file = loadCatalogFile(good);
    const providers = resolveProviders({ env: { VLLM_KEY: 'k' }, custom: customProviders(file) });
    const c = new Catalog(mergeCatalog(DEFAULT_CATALOG, file), providers);
    expect(c.get('local/llama')!.endpoints[0]!.enabled).toBe(true);

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ models: [{ id: 'no-slash', name: 'x' }] }));
    expect(() => loadCatalogFile(bad)).toThrow(/Invalid catalog file/);
    expect(() => loadCatalogFile(join(dir, 'missing.json'))).toThrow(/Cannot read CATALOG_PATH/);
  });
});
