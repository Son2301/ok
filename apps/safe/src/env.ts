import { baseEnvSchema } from '@ok/shared';
import { z } from 'zod';

/** Env booleans: only "true"/"1" are true. (z.coerce.boolean would treat "false" as true.) */
const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
    .default(def ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1' || v === 'yes');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined));

export const safeEnvSchema = baseEnvSchema.extend({
  PORT: z.coerce.number().int().positive().default(4200),

  // LLM via the platform gateway. Unset GATEWAY_URL → LLM analysis is skipped.
  GATEWAY_URL: optionalString,
  SAFE_LLM_MODEL: z.string().default('gpt-4o-mini'),
  SAFE_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  /** Org billed for LLM usage of free (anonymous / console / Telegram) checks. */
  SAFE_PLATFORM_ORG_ID: optionalString,

  // Client IP / free tier
  TRUST_PROXY: bool(false),
  /** Which X-Forwarded-For entry to trust, counted from the right (1 = added by our closest proxy). */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(1).max(10).default(1),
  SAFE_ANON_DAILY_CHECKS: z.coerce.number().int().min(0).default(30),
  SAFE_ANON_DAILY_MEDIA: z.coerce.number().int().min(0).default(5),
  SAFE_ANON_DAILY_REPORTS: z.coerce.number().int().min(0).default(10),
  SAFE_INTERNAL_DAILY_CHECKS: z.coerce.number().int().min(0).default(500),
  SAFE_TELEGRAM_DAILY_CHECKS: z.coerce.number().int().min(0).default(30),
  /** JSON object overriding per-check prices in micro-USD, e.g. {"url":1000,"image":10000}. */
  SAFE_PRICES: optionalString,

  // SSRF-safe fetcher
  SAFE_FETCH_ENABLED: bool(true),
  SAFE_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  SAFE_FETCH_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(512 * 1024),
  SAFE_FETCH_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(5),
  SAFE_MAX_UPLOAD_MB: z.coerce.number().positive().max(100).default(20),

  // Reputation sources (each one is skipped when its credential is missing)
  SAFE_RDAP_ENABLED: bool(true),
  SAFE_RDAP_BASE_URL: z.string().default('https://rdap.org'),
  GOOGLE_SAFE_BROWSING_API_KEY: optionalString,
  VIRUSTOTAL_API_KEY: optionalString,
  URLHAUS_AUTH_KEY: optionalString,
  PHISHTANK_APP_KEY: optionalString,
  /** OpenPhish community feed needs no key; set this to enable importing it. */
  OPENPHISH_FEED_URL: optionalString,
  SAFE_FEED_IMPORT_INTERVAL_MIN: z.coerce.number().int().min(0).default(0),

  // Media detectors (unverified adapters)
  HIVE_API_KEY: optionalString,
  SIGHTENGINE_API_USER: optionalString,
  SIGHTENGINE_API_SECRET: optionalString,
  REALITY_DEFENDER_API_KEY: optionalString,
  REALITY_DEFENDER_MAX_WAIT_MS: z.coerce.number().int().min(0).default(20_000),

  // Telegram bot
  TELEGRAM_WEBHOOK_SECRET: optionalString,

  /** Salt for hashing IPs / reporter fingerprints. Defaults to a value derived from INTERNAL_TOKEN. */
  SAFE_FINGERPRINT_SALT: optionalString,
  /** Comma-separated browser origins allowed to call the API directly. */
  SAFE_CORS_ORIGINS: optionalString,
});

export type SafeEnv = z.infer<typeof safeEnvSchema>;

/** Parse env with defaults; tests pass a partial override map. */
export function parseSafeEnv(source: Record<string, string | undefined> = {}): SafeEnv {
  return safeEnvSchema.parse(source);
}
