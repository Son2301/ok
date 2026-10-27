import { BRAND } from '@minh/shared';

export type ProviderKind = 'openai-compatible' | 'azure-openai' | 'anthropic' | 'google' | 'mock';

/** A configured upstream provider instance (credentials resolved from env). */
export interface ProviderSpec {
  id: string;
  name: string;
  kind: ProviderKind;
  /** Base URL (OpenAI-compatible: up to and including `/v1`; Azure: resource endpoint). */
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Azure `api-version` query param or the `anthropic-version` header. */
  apiVersion?: string;
  /** Whether the upstream accepts `stream_options: { include_usage: true }`. */
  supportsStreamUsage?: boolean;
  /** Endpoints of this provider are routable only when enabled (credentials present). */
  enabled: boolean;
  /** `true` once the adapter was exercised against the live API. */
  verified: boolean;
  /** Mock provider knobs. */
  mock?: { latencyMs: number; failureRate: number };
}

/** Declarative description of a provider we know how to configure from env vars. */
export interface ProviderDefinition {
  id: string;
  name: string;
  kind: ProviderKind;
  defaultBaseUrl?: string;
  /** Env vars holding the API key, first match wins. */
  keyEnv?: string[];
  /** Env var overriding the base URL (proxies, regional endpoints, tests). */
  baseUrlEnv?: string;
  apiVersionEnv?: string;
  defaultApiVersion?: string;
  headers?: Record<string, string>;
  supportsStreamUsage?: boolean;
  /** A provider that needs no key (local inference server). */
  keyless?: boolean;
}

/**
 * Providers the gateway can talk to out of the box. None of these have been
 * exercised against the live API from this codebase yet (verified: false);
 * request/response handling follows each provider's public documentation.
 */
export const KNOWN_PROVIDERS: ProviderDefinition[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyEnv: ['OPENAI_API_KEY'],
    baseUrlEnv: 'OPENAI_BASE_URL',
    supportsStreamUsage: true,
  },
  {
    id: 'azure',
    name: 'Azure OpenAI',
    kind: 'azure-openai',
    keyEnv: ['AZURE_OPENAI_API_KEY'],
    baseUrlEnv: 'AZURE_OPENAI_ENDPOINT',
    apiVersionEnv: 'AZURE_OPENAI_API_VERSION',
    defaultApiVersion: '2024-10-21',
    supportsStreamUsage: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    keyEnv: ['ANTHROPIC_API_KEY'],
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    apiVersionEnv: 'ANTHROPIC_VERSION',
    defaultApiVersion: '2023-06-01',
  },
  {
    id: 'google',
    name: 'Google AI Studio (Gemini)',
    kind: 'google',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    baseUrlEnv: 'GEMINI_BASE_URL',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    keyEnv: ['DEEPSEEK_API_KEY'],
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    supportsStreamUsage: true,
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: ['GROQ_API_KEY'],
    baseUrlEnv: 'GROQ_BASE_URL',
    supportsStreamUsage: true,
  },
  {
    id: 'together',
    name: 'Together AI',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.together.xyz/v1',
    keyEnv: ['TOGETHER_API_KEY'],
    baseUrlEnv: 'TOGETHER_BASE_URL',
    supportsStreamUsage: true,
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
    keyEnv: ['FIREWORKS_API_KEY'],
    baseUrlEnv: 'FIREWORKS_BASE_URL',
    supportsStreamUsage: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: ['OPENROUTER_API_KEY'],
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    headers: { 'HTTP-Referer': `https://${BRAND.domain}`, 'X-Title': BRAND.name },
    supportsStreamUsage: true,
  },
  {
    id: 'dashscope',
    name: 'Alibaba Cloud Model Studio (DashScope, intl)',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyEnv: ['DASHSCOPE_API_KEY'],
    baseUrlEnv: 'DASHSCOPE_BASE_URL',
    supportsStreamUsage: true,
  },
  {
    id: 'byteplus',
    name: 'BytePlus ModelArk',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    keyEnv: ['BYTEPLUS_API_KEY', 'ARK_API_KEY'],
    baseUrlEnv: 'BYTEPLUS_BASE_URL',
    supportsStreamUsage: true,
  },
  {
    id: 'xai',
    name: 'xAI',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.x.ai/v1',
    keyEnv: ['XAI_API_KEY'],
    baseUrlEnv: 'XAI_BASE_URL',
    supportsStreamUsage: true,
  },
  // Mistral returns usage on the final chunk by default and rejects unknown params, so no stream_options.
  {
    id: 'mistral',
    name: 'Mistral AI',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    keyEnv: ['MISTRAL_API_KEY'],
    baseUrlEnv: 'MISTRAL_BASE_URL',
    supportsStreamUsage: false,
  },
];

/** Shape of a custom provider declared in the `CATALOG_PATH` JSON file. */
export interface CustomProviderInput {
  name?: string;
  kind: ProviderKind;
  baseUrl?: string;
  /** Name of the env var holding the key (keys never live in the catalog file). */
  apiKeyEnv?: string;
  apiVersion?: string;
  headers?: Record<string, string>;
  supportsStreamUsage?: boolean;
  /** Local inference servers that need no key. */
  keyless?: boolean;
}

export interface ResolveProvidersOptions {
  env: Record<string, string | undefined>;
  custom?: Record<string, CustomProviderInput>;
  mock?: { latencyMs?: number; failureRate?: number };
}

/** Resolve every known + custom provider against the environment. The mock provider is always present. */
export function resolveProviders(opts: ResolveProvidersOptions): Map<string, ProviderSpec> {
  const { env } = opts;
  const out = new Map<string, ProviderSpec>();
  const pick = (names?: string[]) => names?.map((n) => env[n]?.trim()).find((v) => v);

  for (const def of KNOWN_PROVIDERS) {
    const apiKey = pick(def.keyEnv);
    const baseUrl = (def.baseUrlEnv ? env[def.baseUrlEnv]?.trim() : undefined) || def.defaultBaseUrl;
    const enabled = Boolean((apiKey || def.keyless) && baseUrl);
    out.set(def.id, {
      id: def.id,
      name: def.name,
      kind: def.kind,
      baseUrl,
      apiKey,
      headers: def.headers,
      apiVersion: (def.apiVersionEnv ? env[def.apiVersionEnv]?.trim() : undefined) || def.defaultApiVersion,
      supportsStreamUsage: def.supportsStreamUsage,
      enabled,
      verified: false,
    });
  }

  for (const [id, p] of Object.entries(opts.custom ?? {})) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id) || id === 'mock')
      throw new Error(`Invalid custom provider id: ${id}`);
    const apiKey = p.apiKeyEnv ? env[p.apiKeyEnv]?.trim() : undefined;
    out.set(id, {
      id,
      name: p.name ?? id,
      kind: p.kind,
      baseUrl: p.baseUrl,
      apiKey,
      headers: p.headers,
      apiVersion: p.apiVersion,
      supportsStreamUsage: p.supportsStreamUsage ?? p.kind === 'openai-compatible',
      enabled: Boolean((apiKey || p.keyless) && (p.baseUrl || p.kind === 'mock')),
      verified: false,
    });
  }

  out.set('mock', {
    id: 'mock',
    name: 'Mock (offline)',
    kind: 'mock',
    enabled: true,
    verified: true,
    mock: { latencyMs: opts.mock?.latencyMs ?? 0, failureRate: opts.mock?.failureRate ?? 0 },
  });
  return out;
}

/** True when at least one provider other than `mock` has credentials. */
export function hasRealProvider(providers: Map<string, ProviderSpec>): boolean {
  for (const p of providers.values()) if (p.kind !== 'mock' && p.enabled) return true;
  return false;
}
