import { baseEnvSchema } from '@ok/shared';
import { z } from 'zod';

const optional = z.string().trim().min(1).optional();
const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);
const flag = z
  .enum(['0', '1', 'true', 'false', 'yes', 'no'])
  .optional()
  .transform((v) => (v === undefined ? undefined : ['1', 'true', 'yes'].includes(v)));

/**
 * Gateway configuration. Provider credentials are optional: a provider's
 * endpoints are routable only when its credentials are present, and with none
 * at all every model resolves to the offline mock provider.
 */
export const envSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(4000),

  // Catalog & routing
  CATALOG_PATH: optional,
  MOCK_PROVIDER: z.enum(['auto', 'always', 'never']).default('auto'),
  MOCK_LATENCY_MS: int(0),
  MOCK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  MAX_ATTEMPTS: int(6, 1),
  // Reasoning models can think for minutes before the first token; keep these generous.
  UPSTREAM_TIMEOUT_MS: int(300_000, 1),
  FIRST_BYTE_TIMEOUT_MS: int(120_000, 1),
  STREAM_IDLE_TIMEOUT_MS: int(120_000, 1),
  CIRCUIT_FAILURE_THRESHOLD: int(5, 1),
  CIRCUIT_COOLDOWN_MS: int(30_000, 1),
  HEALTH_WINDOW_MS: int(300_000, 1_000),
  MAX_BODY_BYTES: int(20 * 1024 * 1024, 1_024),
  ANTHROPIC_DEFAULT_MAX_TOKENS: int(16_000, 1),

  // Wallet: VietQR top-ups auto-confirmed by SePay (https://sepay.vn). Disabled until a bank account is set.
  VND_PER_USD: int(26_000, 1),
  TOPUP_BANK_ID: optional,
  TOPUP_BANK_ACCOUNT_NO: optional,
  TOPUP_BANK_ACCOUNT_NAME: optional,
  SEPAY_API_KEY: optional,

  // Platform org that funds free tiers across products; created on boot if missing.
  PLATFORM_ORG_ID: optional,
  PLATFORM_ORG_INITIAL_CREDIT_USD: z.coerce.number().min(0).default(0),

  // Dev seeding: create an org + API key on boot and log the key (never in production).
  DEV_SEED_API_KEY: flag,
  DEV_SEED_CREDIT_USD: z.coerce.number().positive().default(10),

  // Provider credentials (all optional). Base URLs can be overridden with <PROVIDER>_BASE_URL.
  OPENAI_API_KEY: optional,
  OPENAI_BASE_URL: optional,
  AZURE_OPENAI_API_KEY: optional,
  AZURE_OPENAI_ENDPOINT: optional,
  AZURE_OPENAI_API_VERSION: optional,
  AZURE_OPENAI_DEPLOYMENTS: optional.transform((v, ctx) => {
    if (!v) return undefined;
    try {
      const parsed = JSON.parse(v) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed as Record<string, string>;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a JSON object mapping model id → deployment name' });
      return z.NEVER;
    }
  }),
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_BASE_URL: optional,
  ANTHROPIC_VERSION: optional,
  GEMINI_API_KEY: optional,
  GOOGLE_API_KEY: optional,
  GEMINI_BASE_URL: optional,
  DEEPSEEK_API_KEY: optional,
  GROQ_API_KEY: optional,
  TOGETHER_API_KEY: optional,
  FIREWORKS_API_KEY: optional,
  OPENROUTER_API_KEY: optional,
  DASHSCOPE_API_KEY: optional,
  BYTEPLUS_API_KEY: optional,
  XAI_API_KEY: optional,
  MISTRAL_API_KEY: optional,
});

export type Env = z.infer<typeof envSchema>;
