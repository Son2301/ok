import { AnthropicAdapter } from './anthropic';
import type { ProviderSpec } from './config';
import { GoogleAdapter } from './google';
import { MockAdapter, type MockScript } from './mock';
import { AzureOpenAIAdapter, OpenAICompatibleAdapter } from './openai-compatible';
import type { ProviderAdapter } from './types';

export interface CreateAdaptersOptions {
  /** Scripted replies for the mock provider (tests / demos). */
  mockScript?: MockScript;
  random?: () => number;
  anthropicDefaultMaxTokens?: number;
}

/** Instantiate one adapter per enabled provider. */
export function createAdapters(
  providers: Map<string, ProviderSpec>,
  opts: CreateAdaptersOptions = {},
): Map<string, ProviderAdapter> {
  const out = new Map<string, ProviderAdapter>();
  for (const p of providers.values()) {
    if (!p.enabled) continue;
    out.set(p.id, createAdapter(p, opts));
  }
  return out;
}

export function createAdapter(p: ProviderSpec, opts: CreateAdaptersOptions = {}): ProviderAdapter {
  switch (p.kind) {
    case 'openai-compatible':
      return new OpenAICompatibleAdapter({
        id: p.id,
        baseUrl: p.baseUrl!,
        apiKey: p.apiKey,
        headers: p.headers,
        supportsStreamUsage: p.supportsStreamUsage,
      });
    case 'azure-openai':
      return new AzureOpenAIAdapter({
        id: p.id,
        endpoint: p.baseUrl!,
        apiKey: p.apiKey ?? '',
        apiVersion: p.apiVersion ?? '2024-10-21',
        headers: p.headers,
        supportsStreamUsage: p.supportsStreamUsage,
      });
    case 'anthropic':
      return new AnthropicAdapter({
        id: p.id,
        baseUrl: p.baseUrl!,
        apiKey: p.apiKey ?? '',
        version: p.apiVersion ?? '2023-06-01',
        headers: p.headers,
        defaultMaxTokens: opts.anthropicDefaultMaxTokens,
      });
    case 'google':
      return new GoogleAdapter({ id: p.id, baseUrl: p.baseUrl!, apiKey: p.apiKey ?? '', headers: p.headers });
    case 'mock':
      return new MockAdapter({
        id: p.id,
        latencyMs: p.mock?.latencyMs,
        failureRate: p.mock?.failureRate,
        random: opts.random,
        script: opts.mockScript,
      });
  }
}
