import { baseEnvSchema } from '@minh/shared';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1' || v === 'yes'));

const int = (def: number, min = 0) => z.coerce.number().int().min(min).default(def);

export const envSchema = baseEnvSchema.extend({
  PORT: int(4100, 1),
  /** Public base URL of this service (webhooks, widget, MCP URLs shown to customers). */
  PUBLIC_URL: z.string().url().default('http://localhost:4100'),
  /** URL agent containers use to reach the control plane (tool proxy, LLM proxy, MCP). Defaults to PUBLIC_URL. */
  CONTROL_PLANE_URL: z.string().url().optional(),
  /** Platform gateway base URL (OpenAI-compatible, including `/v1`). */
  GATEWAY_URL: z.string().url().default('http://localhost:4000/v1'),

  /** 32-byte key (base64 or hex) for AES-256-GCM encryption of integration credentials. Required in production. */
  AGENTS_ENCRYPTION_KEY: z.string().optional(),
  /** Previous key, still accepted for decryption during key rotation. */
  AGENTS_ENCRYPTION_KEY_PREVIOUS: z.string().optional(),
  /** Org that pays for LLM usage inside each plan's included quota. Unset → customers pay for all usage. */
  AGENTS_PLATFORM_ORG_ID: z.string().optional(),

  /** `auto` uses Docker when the socket answers, otherwise the in-process inline driver. */
  AGENTS_RUNTIME_DRIVER: z.enum(['auto', 'inline', 'docker']).default('auto'),
  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  AGENTS_DOCKER_NETWORK: z.string().default('minh-agents'),
  AGENTS_DOCKER_NETWORK_INTERNAL: bool(false),
  /** Allow agent containers to reach each other on the agents network (inter-container communication). */
  AGENTS_DOCKER_ICC: bool(false),
  /** How the control plane reaches agent containers: their IP on the agents network, or their container name. */
  AGENTS_DOCKER_ADDRESS_MODE: z.enum(['ip', 'name']).default('ip'),
  AGENTS_IMAGE_BUILTIN: z.string().default('ok/agents-runtime:latest'),
  AGENTS_IMAGE_OPENCLAW: z.string().default('ok/agents-runtime-openclaw:latest'),
  AGENTS_IMAGE_HERMES: z.string().default('ok/agents-runtime-hermes:latest'),

  AGENTS_SCHEDULER_ENABLED: bool(true),
  AGENTS_SCHEDULER_INTERVAL_MS: int(60_000, 1000),
  AGENTS_HEARTBEAT_INTERVAL_MIN: int(60, 1),
  /** Local hour (Asia/Ho_Chi_Minh) after which the daily summary report is posted. */
  AGENTS_DAILY_SUMMARY_HOUR: int(18, 0).pipe(z.number().max(23)),
  AGENTS_TIMEZONE: z.string().default('Asia/Ho_Chi_Minh'),

  AGENTS_MAX_STEPS: int(8, 1),
  AGENTS_TURN_TOKEN_BUDGET: int(60_000, 1000),
  AGENTS_TURN_TIME_BUDGET_MS: int(90_000, 1000),

  /** Trust `X-Forwarded-For` for client IPs (set when running behind a reverse proxy). */
  AGENTS_TRUST_PROXY: bool(false),
  AGENTS_PUBLIC_CHAT_RPM: int(20, 1),

  AGENTS_PLAN_STARTER_PRICE_MICROS: int(8_000_000),
  AGENTS_PLAN_STARTER_MONTHLY_TOKENS: int(3_000_000),
  AGENTS_PLAN_PRO_PRICE_MICROS: int(20_000_000),
  AGENTS_PLAN_PRO_MONTHLY_TOKENS: int(10_000_000),
});

export type AgentsEnv = z.infer<typeof envSchema>;
