import type { AgentsEnv } from './env';

export const PLAN_IDS = ['starter', 'pro'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const RUNTIME_IDS = ['builtin', 'openclaw', 'hermes'] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

export interface Plan {
  id: PlanId;
  name: string;
  /** Monthly price in micro-USD, charged daily prorated. */
  monthlyPriceMicros: number;
  /** LLM tokens per agent per month included in the price (fair use, paid by the platform org). */
  monthlyTokens: number;
  /** Container limits (docker driver). */
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
}

/** Everything the control plane needs at runtime, derived from env (or built directly in tests). */
export interface AgentsConfig {
  /** Shared secret the web console uses (Authorization: Bearer + X-Org-Id). */
  internalToken: string;
  publicUrl: string;
  controlPlaneUrl: string;
  gatewayUrl: string;
  platformOrgId: string | null;
  timezone: string;
  plans: Record<PlanId, Plan>;
  turn: { maxSteps: number; tokenBudget: number; timeBudgetMs: number };
  scheduler: { enabled: boolean; intervalMs: number; heartbeatIntervalMs: number; dailySummaryHour: number };
  trustProxy: boolean;
  publicChatRpm: number;
  images: Record<RuntimeId, string>;
  docker: {
    socketPath: string;
    network: string;
    networkInternal: boolean;
    icc: boolean;
    addressMode: 'ip' | 'name';
  };
}

export function buildPlans(
  env: Pick<
    AgentsEnv,
    | 'AGENTS_PLAN_STARTER_PRICE_MICROS'
    | 'AGENTS_PLAN_STARTER_MONTHLY_TOKENS'
    | 'AGENTS_PLAN_PRO_PRICE_MICROS'
    | 'AGENTS_PLAN_PRO_MONTHLY_TOKENS'
  >,
): Record<PlanId, Plan> {
  return {
    starter: {
      id: 'starter',
      name: 'Starter',
      monthlyPriceMicros: env.AGENTS_PLAN_STARTER_PRICE_MICROS,
      monthlyTokens: env.AGENTS_PLAN_STARTER_MONTHLY_TOKENS,
      cpus: 0.5,
      memoryMb: 512,
      pidsLimit: 256,
    },
    pro: {
      id: 'pro',
      name: 'Pro',
      monthlyPriceMicros: env.AGENTS_PLAN_PRO_PRICE_MICROS,
      monthlyTokens: env.AGENTS_PLAN_PRO_MONTHLY_TOKENS,
      cpus: 1,
      memoryMb: 1024,
      pidsLimit: 512,
    },
  };
}

export function configFromEnv(env: AgentsEnv): AgentsConfig {
  return {
    internalToken: env.INTERNAL_TOKEN,
    publicUrl: env.PUBLIC_URL.replace(/\/+$/, ''),
    controlPlaneUrl: (env.CONTROL_PLANE_URL ?? env.PUBLIC_URL).replace(/\/+$/, ''),
    gatewayUrl: env.GATEWAY_URL.replace(/\/+$/, ''),
    platformOrgId: env.AGENTS_PLATFORM_ORG_ID || null,
    timezone: env.AGENTS_TIMEZONE,
    plans: buildPlans(env),
    turn: {
      maxSteps: env.AGENTS_MAX_STEPS,
      tokenBudget: env.AGENTS_TURN_TOKEN_BUDGET,
      timeBudgetMs: env.AGENTS_TURN_TIME_BUDGET_MS,
    },
    scheduler: {
      enabled: env.AGENTS_SCHEDULER_ENABLED,
      intervalMs: env.AGENTS_SCHEDULER_INTERVAL_MS,
      heartbeatIntervalMs: env.AGENTS_HEARTBEAT_INTERVAL_MIN * 60_000,
      dailySummaryHour: env.AGENTS_DAILY_SUMMARY_HOUR,
    },
    trustProxy: env.AGENTS_TRUST_PROXY,
    publicChatRpm: env.AGENTS_PUBLIC_CHAT_RPM,
    images: {
      builtin: env.AGENTS_IMAGE_BUILTIN,
      openclaw: env.AGENTS_IMAGE_OPENCLAW,
      hermes: env.AGENTS_IMAGE_HERMES,
    },
    docker: {
      socketPath: env.DOCKER_SOCKET,
      network: env.AGENTS_DOCKER_NETWORK,
      networkInternal: env.AGENTS_DOCKER_NETWORK_INTERNAL,
      icc: env.AGENTS_DOCKER_ICC,
      addressMode: env.AGENTS_DOCKER_ADDRESS_MODE,
    },
  };
}
