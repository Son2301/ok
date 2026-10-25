import { baseEnvSchema } from '@ok/shared';
import { z } from 'zod';

/** Treat empty strings as unset (common with docker/compose env files). */
const optional = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().optional(),
);
const bool = (def: boolean) =>
  z.preprocess(
    (v) =>
      v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase()),
    z.boolean(),
  );
const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(min).max(max).default(def));

export const envSchema = baseEnvSchema.extend({
  PORT: int(4300, 1, 65535),
  /** Platform gateway (OpenAI-compatible); LLM usage is billed through it. */
  GATEWAY_URL: z.string().default('http://localhost:4000/v1'),
  /** Web console base URL, used in links posted on PRs. */
  CONSOLE_URL: z.string().default('http://localhost:3000'),

  GITHUB_APP_ID: optional,
  /** PEM (PKCS#1 or PKCS#8); `\n`-escaped or base64-encoded values are accepted. */
  GITHUB_PRIVATE_KEY: optional,
  GITHUB_WEBHOOK_SECRET: optional,
  GITHUB_APP_SLUG: optional,
  /** Optional: enables OAuth ownership verification in the setup callback. */
  GITHUB_CLIENT_ID: optional,
  GITHUB_CLIENT_SECRET: optional,
  /** GitHub Enterprise Server API base, e.g. https://ghe.example.com/api/v3 */
  GITHUB_API_URL: optional,

  /** Org billed for free-quota reviews of unlinked installations. Unset = no free quota. */
  REVIEW_PLATFORM_ORG_ID: optional,
  REVIEW_FREE_REVIEWS_PER_MONTH: int(20),
  REVIEW_MIN_BALANCE_MICROS: int(10_000),
  REVIEW_CONCURRENCY: int(2, 1, 32),
  REVIEW_MAX_ATTEMPTS: int(3, 1, 10),
  REVIEW_CHECK_RUNS: bool(true),
  /** Secret for signing install-state tokens (defaults to one derived from INTERNAL_TOKEN). */
  REVIEW_STATE_SECRET: optional,
  REVIEW_LINK_WINDOW_MINUTES: int(60, 1),
});

export type Env = z.infer<typeof envSchema>;

export function githubConfigured(
  env: Pick<Env, 'GITHUB_APP_ID' | 'GITHUB_PRIVATE_KEY' | 'GITHUB_WEBHOOK_SECRET'>,
): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_PRIVATE_KEY && env.GITHUB_WEBHOOK_SECRET);
}
