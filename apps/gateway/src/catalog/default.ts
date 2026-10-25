import type { Capabilities, CatalogEndpoint, CatalogModel, EndpointQuirks, PricePer1M } from './types';

/*
 * Default model catalog.
 *
 * ⚠️  PRICES ARE PLACEHOLDERS TO BE VERIFIED. `cost` values were transcribed from
 * each provider's public list prices as best known at the time of writing and will
 * drift; `price` (what we charge) defaults to cost × DEFAULT_MARKUP. Upstream model
 * slugs, context windows and capability flags are likewise taken from public docs
 * and must be verified against each live API before going to production. No
 * endpoint below has been exercised against a live API yet (`verified: false`).
 *
 * Override or extend any of this at deploy time with a `CATALOG_PATH` JSON file
 * (see README → "Catalog overrides").
 */

/** Default margin applied on top of upstream cost. Placeholder business decision. */
export const DEFAULT_MARKUP = 1.05;

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const markup = (cost: PricePer1M, m = DEFAULT_MARKUP): PricePer1M => ({
  input: round(cost.input * m),
  output: round(cost.output * m),
});

const FULL: Capabilities = { tools: true, vision: true, json: true, streaming: true };
const TEXT: Capabilities = { tools: true, vision: false, json: true, streaming: true };
const VISION_NO_TOOLS: Capabilities = { tools: false, vision: true, json: true, streaming: true };
const REASONING_TEXT: Capabilities = { tools: false, vision: false, json: true, streaming: true };
const EMBEDDING: Capabilities = { tools: false, vision: false, json: false, streaming: false };

/** OpenAI reasoning models (gpt-5*, o-series) reject non-default sampling params. */
const OPENAI_REASONING: EndpointQuirks = {
  dropParams: ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'logit_bias'],
};
/** Newer Claude models reject sampling params and forced tool use (see README). */
const CLAUDE_5_5: EndpointQuirks = {
  dropParams: ['temperature', 'top_p', 'top_k'],
  noForcedToolChoice: true,
};
const CLAUDE_SAMPLING_DEFAULTS_ONLY: EndpointQuirks = { dropParams: ['temperature', 'top_p', 'top_k'] };

interface EpOptions {
  ctx: number;
  out?: number;
  caps: Capabilities;
  price?: PricePer1M;
  quirks?: EndpointQuirks;
}

/** Build an endpoint from upstream cost `[input, output]` (USD / 1M tokens). */
function ep(provider: string, upstreamModel: string, cost: [number, number], o: EpOptions): CatalogEndpoint {
  const c = { input: cost[0], output: cost[1] };
  return {
    provider,
    upstreamModel,
    cost: c,
    price: o.price ?? markup(c),
    contextLength: o.ctx,
    ...(o.out ? { maxOutputTokens: o.out } : {}),
    capabilities: o.caps,
    ...(o.quirks ? { quirks: o.quirks } : {}),
    verified: false,
  };
}

export const DEFAULT_CATALOG: CatalogModel[] = [
  // ------------------------------------------------------------------ OpenAI
  {
    id: 'openai/gpt-5',
    name: 'GPT-5',
    type: 'chat',
    auto: { tiers: ['frontier', 'reasoning'], quality: 92, strengths: ['code', 'math', 'tools'] },
    endpoints: [
      ep('openai', 'gpt-5', [1.25, 10], { ctx: 400_000, out: 128_000, caps: FULL, quirks: OPENAI_REASONING }),
      ep('azure', 'gpt-5', [1.25, 10], { ctx: 400_000, out: 128_000, caps: FULL, quirks: OPENAI_REASONING }),
      ep('openrouter', 'openai/gpt-5', [1.25, 10], {
        ctx: 400_000,
        out: 128_000,
        caps: FULL,
        quirks: OPENAI_REASONING,
      }),
    ],
  },
  {
    id: 'openai/gpt-5-mini',
    name: 'GPT-5 mini',
    type: 'chat',
    auto: { tiers: ['balanced'], quality: 82, strengths: ['code', 'tools'] },
    endpoints: [
      ep('openai', 'gpt-5-mini', [0.25, 2], {
        ctx: 400_000,
        out: 128_000,
        caps: FULL,
        quirks: OPENAI_REASONING,
      }),
      ep('azure', 'gpt-5-mini', [0.25, 2], {
        ctx: 400_000,
        out: 128_000,
        caps: FULL,
        quirks: OPENAI_REASONING,
      }),
      ep('openrouter', 'openai/gpt-5-mini', [0.25, 2], {
        ctx: 400_000,
        out: 128_000,
        caps: FULL,
        quirks: OPENAI_REASONING,
      }),
    ],
  },
  {
    id: 'openai/gpt-5-nano',
    name: 'GPT-5 nano',
    type: 'chat',
    auto: { tiers: ['fast'], quality: 64 },
    endpoints: [
      ep('openai', 'gpt-5-nano', [0.05, 0.4], {
        ctx: 400_000,
        out: 128_000,
        caps: FULL,
        quirks: OPENAI_REASONING,
      }),
    ],
  },
  {
    id: 'openai/gpt-4.1',
    name: 'GPT-4.1',
    type: 'chat',
    auto: { tiers: ['frontier'], quality: 85, strengths: ['code', 'long_context', 'tools'] },
    endpoints: [
      ep('openai', 'gpt-4.1', [2, 8], { ctx: 1_047_576, out: 32_768, caps: FULL }),
      ep('azure', 'gpt-4.1', [2, 8], { ctx: 1_047_576, out: 32_768, caps: FULL }),
      ep('openrouter', 'openai/gpt-4.1', [2, 8], { ctx: 1_047_576, out: 32_768, caps: FULL }),
    ],
  },
  {
    id: 'openai/gpt-4.1-mini',
    name: 'GPT-4.1 mini',
    type: 'chat',
    auto: { tiers: ['balanced'], quality: 76, strengths: ['long_context', 'tools'] },
    endpoints: [
      ep('openai', 'gpt-4.1-mini', [0.4, 1.6], { ctx: 1_047_576, out: 32_768, caps: FULL }),
      ep('azure', 'gpt-4.1-mini', [0.4, 1.6], { ctx: 1_047_576, out: 32_768, caps: FULL }),
    ],
  },
  {
    id: 'openai/gpt-4.1-nano',
    name: 'GPT-4.1 nano',
    type: 'chat',
    auto: { tiers: ['fast'], quality: 62, strengths: ['long_context'] },
    endpoints: [ep('openai', 'gpt-4.1-nano', [0.1, 0.4], { ctx: 1_047_576, out: 32_768, caps: FULL })],
  },
  {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    type: 'chat',
    auto: { tiers: ['frontier'], quality: 82, strengths: ['multilingual', 'vision', 'tools'] },
    endpoints: [
      ep('openai', 'gpt-4o', [2.5, 10], { ctx: 128_000, out: 16_384, caps: FULL }),
      ep('azure', 'gpt-4o', [2.5, 10], { ctx: 128_000, out: 16_384, caps: FULL }),
      ep('openrouter', 'openai/gpt-4o', [2.5, 10], { ctx: 128_000, out: 16_384, caps: FULL }),
    ],
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o mini',
    type: 'chat',
    auto: { tiers: ['fast'], quality: 68, strengths: ['multilingual', 'vision', 'tools'] },
    endpoints: [
      ep('openai', 'gpt-4o-mini', [0.15, 0.6], { ctx: 128_000, out: 16_384, caps: FULL }),
      ep('azure', 'gpt-4o-mini', [0.15, 0.6], { ctx: 128_000, out: 16_384, caps: FULL }),
      ep('openrouter', 'openai/gpt-4o-mini', [0.15, 0.6], { ctx: 128_000, out: 16_384, caps: FULL }),
    ],
  },
  {
    id: 'openai/o4-mini',
    name: 'o4-mini',
    type: 'chat',
    auto: { tiers: ['reasoning'], quality: 86, strengths: ['math', 'code'] },
    endpoints: [
      ep('openai', 'o4-mini', [1.1, 4.4], {
        ctx: 200_000,
        out: 100_000,
        caps: FULL,
        quirks: OPENAI_REASONING,
      }),
      ep('azure', 'o4-mini', [1.1, 4.4], {
        ctx: 200_000,
        out: 100_000,
        caps: FULL,
        quirks: OPENAI_REASONING,
      }),
    ],
  },
  {
    id: 'openai/gpt-oss-120b',
    name: 'gpt-oss-120b',
    type: 'chat',
    auto: { tiers: ['balanced', 'reasoning'], quality: 78, strengths: ['math', 'code'] },
    endpoints: [
      ep('groq', 'openai/gpt-oss-120b', [0.15, 0.75], { ctx: 131_072, out: 32_768, caps: TEXT }),
      ep('together', 'openai/gpt-oss-120b', [0.15, 0.6], { ctx: 131_072, out: 32_768, caps: TEXT }),
      ep('fireworks', 'accounts/fireworks/models/gpt-oss-120b', [0.15, 0.6], {
        ctx: 131_072,
        out: 32_768,
        caps: TEXT,
      }),
    ],
  },
  {
    id: 'openai/gpt-oss-20b',
    name: 'gpt-oss-20b',
    type: 'chat',
    auto: { tiers: ['fast'], quality: 60, strengths: ['math'] },
    endpoints: [
      ep('groq', 'openai/gpt-oss-20b', [0.075, 0.3], { ctx: 131_072, out: 32_768, caps: TEXT }),
      ep('together', 'openai/gpt-oss-20b', [0.05, 0.2], { ctx: 131_072, out: 32_768, caps: TEXT }),
      ep('fireworks', 'accounts/fireworks/models/gpt-oss-20b', [0.07, 0.3], {
        ctx: 131_072,
        out: 32_768,
        caps: TEXT,
      }),
    ],
  },

  // --------------------------------------------------------------- Anthropic
  {
    id: 'anthropic/claude-opus-5.5',
    name: 'Claude Opus 5.5',
    type: 'chat',
    aliases: ['claude-opus-5-5', 'claude-opus'],
    auto: {
      tiers: ['frontier', 'reasoning'],
      quality: 97,
      strengths: ['code', 'math', 'tools', 'long_context', 'multilingual'],
    },
    endpoints: [
      ep('anthropic', 'claude-opus-5-5', [4, 20], {
        ctx: 1_000_000,
        out: 128_000,
        caps: FULL,
        quirks: CLAUDE_5_5,
      }),
    ],
  },
  {
    id: 'anthropic/claude-sonnet-5.5',
    name: 'Claude Sonnet 5.5',
    type: 'chat',
    aliases: ['claude-sonnet-5-5', 'claude-sonnet'],
    auto: { tiers: ['frontier'], quality: 93, strengths: ['code', 'tools', 'long_context', 'multilingual'] },
    endpoints: [
      ep('anthropic', 'claude-sonnet-5-5', [2, 10], {
        ctx: 1_000_000,
        out: 128_000,
        caps: FULL,
        quirks: CLAUDE_5_5,
      }),
    ],
  },
  {
    id: 'anthropic/claude-haiku-5.5',
    name: 'Claude Haiku 5.5',
    type: 'chat',
    aliases: ['claude-haiku-5-5', 'claude-haiku'],
    // List price applies to prompts up to 100K tokens; longer prompts are billed higher upstream
    // ($0.50 / $2.50). Tiered upstream pricing is not modelled yet — see README "Known gaps".
    auto: { tiers: ['fast', 'balanced'], quality: 80, strengths: ['code', 'tools', 'multilingual'] },
    endpoints: [
      ep('anthropic', 'claude-haiku-5-5', [0.1, 0.5], {
        ctx: 1_000_000,
        out: 128_000,
        caps: FULL,
        quirks: CLAUDE_SAMPLING_DEFAULTS_ONLY,
      }),
    ],
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    type: 'chat',
    aliases: ['claude-sonnet-4-6'],
    auto: { tiers: ['frontier'], quality: 88, strengths: ['code', 'tools', 'long_context'] },
    endpoints: [
      ep('anthropic', 'claude-sonnet-4-6', [3, 15], { ctx: 1_000_000, out: 64_000, caps: FULL }),
      ep('openrouter', 'anthropic/claude-sonnet-4.6', [3, 15], { ctx: 1_000_000, out: 64_000, caps: FULL }),
    ],
  },
  {
    id: 'anthropic/claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    type: 'chat',
    aliases: ['claude-haiku-4-5'],
    auto: { tiers: ['balanced'], quality: 72, strengths: ['code', 'tools'] },
    endpoints: [ep('anthropic', 'claude-haiku-4-5', [1, 5], { ctx: 200_000, out: 64_000, caps: FULL })],
  },

  // ------------------------------------------------------------------ Google
  {
    id: 'google/gemini-3-pro',
    name: 'Gemini 3 Pro (preview)',
    type: 'chat',
    auto: {
      tiers: ['frontier', 'reasoning'],
      quality: 94,
      strengths: ['math', 'code', 'long_context', 'multilingual', 'vision'],
    },
    // Upstream list price doubles above 200K prompt tokens; not modelled yet.
    endpoints: [ep('google', 'gemini-3-pro-preview', [2, 12], { ctx: 1_048_576, out: 65_536, caps: FULL })],
  },
  {
    id: 'google/gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    type: 'chat',
    auto: {
      tiers: ['frontier', 'reasoning'],
      quality: 89,
      strengths: ['math', 'code', 'long_context', 'multilingual', 'vision'],
    },
    endpoints: [
      ep('google', 'gemini-2.5-pro', [1.25, 10], { ctx: 1_048_576, out: 65_536, caps: FULL }),
      ep('openrouter', 'google/gemini-2.5-pro', [1.25, 10], { ctx: 1_048_576, out: 65_536, caps: FULL }),
    ],
  },
  {
    id: 'google/gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    type: 'chat',
    auto: { tiers: ['balanced'], quality: 79, strengths: ['multilingual', 'vision', 'long_context'] },
    endpoints: [
      ep('google', 'gemini-2.5-flash', [0.3, 2.5], { ctx: 1_048_576, out: 65_536, caps: FULL }),
      ep('openrouter', 'google/gemini-2.5-flash', [0.3, 2.5], { ctx: 1_048_576, out: 65_536, caps: FULL }),
    ],
  },
  {
    id: 'google/gemini-2.5-flash-lite',
    name: 'Gemini 2.5 Flash-Lite',
    type: 'chat',
    auto: { tiers: ['fast'], quality: 66, strengths: ['multilingual', 'vision', 'long_context'] },
    endpoints: [
      ep('google', 'gemini-2.5-flash-lite', [0.1, 0.4], { ctx: 1_048_576, out: 65_536, caps: FULL }),
    ],
  },

  // ---------------------------------------------------------------- DeepSeek
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek V3 (chat)',
    type: 'chat',
    aliases: ['deepseek-v3'],
    auto: { tiers: ['balanced'], quality: 80, strengths: ['code', 'math'] },
    endpoints: [
      ep('deepseek', 'deepseek-chat', [0.28, 0.42], { ctx: 128_000, out: 8_192, caps: TEXT }),
      ep('together', 'deepseek-ai/DeepSeek-V3.1', [0.6, 1.7], { ctx: 128_000, out: 8_192, caps: TEXT }),
      ep('fireworks', 'accounts/fireworks/models/deepseek-v3p1', [0.56, 1.68], {
        ctx: 128_000,
        out: 8_192,
        caps: TEXT,
      }),
    ],
  },
  {
    id: 'deepseek/deepseek-reasoner',
    name: 'DeepSeek Reasoner',
    type: 'chat',
    aliases: ['deepseek-r1'],
    auto: { tiers: ['reasoning'], quality: 83, strengths: ['math', 'code'] },
    endpoints: [
      ep('deepseek', 'deepseek-reasoner', [0.28, 0.42], {
        ctx: 128_000,
        out: 64_000,
        caps: REASONING_TEXT,
        quirks: { dropParams: ['temperature', 'top_p'] },
      }),
      ep('together', 'deepseek-ai/DeepSeek-R1', [3, 7], { ctx: 128_000, out: 32_768, caps: REASONING_TEXT }),
    ],
  },

  // -------------------------------------------------------------------- Meta
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    name: 'Llama 3.3 70B Instruct',
    type: 'chat',
    auto: { tiers: ['balanced'], quality: 70, strengths: ['tools'] },
    endpoints: [
      ep('groq', 'llama-3.3-70b-versatile', [0.59, 0.79], { ctx: 131_072, out: 32_768, caps: TEXT }),
      ep('together', 'meta-llama/Llama-3.3-70B-Instruct-Turbo', [0.88, 0.88], {
        ctx: 131_072,
        out: 32_768,
        caps: TEXT,
      }),
      ep('fireworks', 'accounts/fireworks/models/llama-v3p3-70b-instruct', [0.9, 0.9], {
        ctx: 131_072,
        out: 32_768,
        caps: TEXT,
      }),
    ],
  },
  {
    id: 'meta-llama/llama-3.1-8b-instruct',
    name: 'Llama 3.1 8B Instruct',
    type: 'chat',
    auto: { tiers: ['fast'], quality: 48 },
    endpoints: [
      ep('groq', 'llama-3.1-8b-instant', [0.05, 0.08], { ctx: 131_072, out: 8_192, caps: TEXT }),
      ep('together', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', [0.18, 0.18], {
        ctx: 131_072,
        out: 8_192,
        caps: TEXT,
      }),
    ],
  },

  // ------------------------------------------------------- Alibaba (Qwen)
  {
    id: 'qwen/qwen-max',
    name: 'Qwen Max',
    type: 'chat',
    auto: { tiers: ['frontier'], quality: 81, strengths: ['multilingual', 'code'] },
    endpoints: [ep('dashscope', 'qwen-max', [1.6, 6.4], { ctx: 32_768, out: 8_192, caps: TEXT })],
  },
  {
    id: 'qwen/qwen-plus',
    name: 'Qwen Plus',
    type: 'chat',
    auto: { tiers: ['balanced'], quality: 76, strengths: ['multilingual'] },
    endpoints: [ep('dashscope', 'qwen-plus', [0.4, 1.2], { ctx: 131_072, out: 16_384, caps: TEXT })],
  },
  {
    id: 'qwen/qwen-turbo',
    name: 'Qwen Turbo',
    type: 'chat',
    auto: { tiers: ['fast'], quality: 58, strengths: ['multilingual', 'long_context'] },
    endpoints: [ep('dashscope', 'qwen-turbo', [0.05, 0.2], { ctx: 1_000_000, out: 16_384, caps: TEXT })],
  },
  {
    id: 'qwen/qwen-vl-max',
    name: 'Qwen VL Max',
    type: 'chat',
    auto: { tiers: ['balanced'], quality: 72, strengths: ['vision', 'multilingual'] },
    endpoints: [
      ep('dashscope', 'qwen-vl-max', [0.8, 3.2], { ctx: 131_072, out: 8_192, caps: VISION_NO_TOOLS }),
    ],
  },
  {
    id: 'qwen/qwen3-coder-plus',
    name: 'Qwen3 Coder Plus',
    type: 'chat',
    auto: { tiers: ['balanced'], quality: 79, strengths: ['code', 'tools', 'long_context'] },
    endpoints: [ep('dashscope', 'qwen3-coder-plus', [1, 5], { ctx: 1_000_000, out: 65_536, caps: TEXT })],
  },

  // ------------------------------------------------- ByteDance (BytePlus)
  {
    id: 'bytedance/seed-1.6',
    name: 'Seed 1.6',
    type: 'chat',
    auto: { tiers: ['balanced'], quality: 77, strengths: ['multilingual', 'vision'] },
    endpoints: [ep('byteplus', 'seed-1-6-250615', [0.25, 2], { ctx: 256_000, out: 32_768, caps: FULL })],
  },
  {
    id: 'bytedance/seed-1.6-flash',
    name: 'Seed 1.6 Flash',
    type: 'chat',
    auto: { tiers: ['fast'], quality: 63, strengths: ['multilingual', 'vision'] },
    endpoints: [
      ep('byteplus', 'seed-1-6-flash-250615', [0.075, 0.3], { ctx: 256_000, out: 16_384, caps: FULL }),
    ],
  },

  // --------------------------------------------------------------------- xAI
  {
    id: 'x-ai/grok-4',
    name: 'Grok 4',
    type: 'chat',
    auto: { tiers: ['frontier', 'reasoning'], quality: 90, strengths: ['math', 'code'] },
    endpoints: [
      ep('xai', 'grok-4', [3, 15], {
        ctx: 256_000,
        out: 64_000,
        caps: FULL,
        quirks: { dropParams: ['presence_penalty', 'frequency_penalty', 'stop'] },
      }),
    ],
  },
  {
    id: 'x-ai/grok-3-mini',
    name: 'Grok 3 mini',
    type: 'chat',
    auto: { tiers: ['balanced', 'reasoning'], quality: 71, strengths: ['math'] },
    endpoints: [ep('xai', 'grok-3-mini', [0.3, 0.5], { ctx: 131_072, out: 32_768, caps: TEXT })],
  },

  // ----------------------------------------------------------------- Mistral
  {
    id: 'mistralai/mistral-large',
    name: 'Mistral Large',
    type: 'chat',
    auto: { tiers: ['frontier'], quality: 79, strengths: ['multilingual', 'code'] },
    endpoints: [ep('mistral', 'mistral-large-latest', [2, 6], { ctx: 131_072, out: 32_768, caps: TEXT })],
  },
  {
    id: 'mistralai/mistral-medium',
    name: 'Mistral Medium',
    type: 'chat',
    auto: { tiers: ['balanced'], quality: 75, strengths: ['multilingual'] },
    endpoints: [ep('mistral', 'mistral-medium-latest', [0.4, 2], { ctx: 131_072, out: 32_768, caps: FULL })],
  },
  {
    id: 'mistralai/mistral-small',
    name: 'Mistral Small',
    type: 'chat',
    auto: { tiers: ['fast'], quality: 61, strengths: ['multilingual'] },
    endpoints: [ep('mistral', 'mistral-small-latest', [0.1, 0.3], { ctx: 131_072, out: 32_768, caps: FULL })],
  },
  {
    id: 'mistralai/codestral',
    name: 'Codestral',
    type: 'chat',
    auto: { tiers: ['balanced'], quality: 72, strengths: ['code'] },
    endpoints: [ep('mistral', 'codestral-latest', [0.3, 0.9], { ctx: 256_000, out: 32_768, caps: TEXT })],
  },

  // -------------------------------------------------------------------- Mock
  {
    id: 'mock/echo',
    name: 'Mock echo (offline)',
    type: 'chat',
    description: 'Echoes the last user message. Always available; used for development and tests.',
    auto: { tiers: ['fast'], quality: 1 },
    endpoints: [
      ep('mock', 'echo', [0, 0], { ctx: 1_000_000, out: 32_768, caps: FULL, price: { input: 1, output: 2 } }),
    ],
  },

  // -------------------------------------------------------------- Embeddings
  {
    id: 'openai/text-embedding-3-small',
    name: 'OpenAI text-embedding-3-small',
    type: 'embedding',
    endpoints: [
      ep('openai', 'text-embedding-3-small', [0.02, 0], { ctx: 8_191, caps: EMBEDDING }),
      ep('azure', 'text-embedding-3-small', [0.02, 0], { ctx: 8_191, caps: EMBEDDING }),
    ],
  },
  {
    id: 'openai/text-embedding-3-large',
    name: 'OpenAI text-embedding-3-large',
    type: 'embedding',
    endpoints: [
      ep('openai', 'text-embedding-3-large', [0.13, 0], { ctx: 8_191, caps: EMBEDDING }),
      ep('azure', 'text-embedding-3-large', [0.13, 0], { ctx: 8_191, caps: EMBEDDING }),
    ],
  },
  {
    id: 'mistralai/mistral-embed',
    name: 'Mistral Embed',
    type: 'embedding',
    endpoints: [ep('mistral', 'mistral-embed', [0.1, 0], { ctx: 8_192, caps: EMBEDDING })],
  },
  {
    id: 'qwen/text-embedding-v3',
    name: 'Qwen text-embedding-v3',
    type: 'embedding',
    endpoints: [ep('dashscope', 'text-embedding-v3', [0.07, 0], { ctx: 8_192, caps: EMBEDDING })],
  },
  {
    id: 'mock/embed',
    name: 'Mock embeddings (offline)',
    type: 'embedding',
    description: 'Deterministic hash-based vectors. Always available.',
    endpoints: [
      ep('mock', 'embed', [0, 0], { ctx: 1_000_000, caps: EMBEDDING, price: { input: 0.01, output: 0 } }),
    ],
  },
];
