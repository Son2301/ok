import { Catalog, customProviders, loadCatalogFile, mergeCatalog } from './catalog/catalog';
import { DEFAULT_CATALOG } from './catalog/default';
import type { Env } from './env';
import { resolveProviders } from './providers/config';
import { createAdapters } from './providers/registry';
import type { ProviderAdapter } from './providers/types';
import { HealthTracker } from './routing/health';
import type { GatewayConfig } from './services/gateway';

export interface Runtime {
  catalog: Catalog;
  adapters: Map<string, ProviderAdapter>;
  health: HealthTracker;
  config: GatewayConfig;
}

/** Wire catalog, provider adapters and health tracking from configuration. */
export function buildRuntime(env: Env, rawEnv: Record<string, string | undefined> = process.env): Runtime {
  const file = env.CATALOG_PATH ? loadCatalogFile(env.CATALOG_PATH) : undefined;
  const providers = resolveProviders({
    env: rawEnv,
    custom: customProviders(file),
    mock: { latencyMs: env.MOCK_LATENCY_MS, failureRate: env.MOCK_FAILURE_RATE },
  });
  const models = file ? mergeCatalog(DEFAULT_CATALOG, file) : DEFAULT_CATALOG;
  const catalog = new Catalog(models, providers, {
    mockMode: env.MOCK_PROVIDER,
    azureDeployments: env.AZURE_OPENAI_DEPLOYMENTS,
  });
  return {
    catalog,
    adapters: createAdapters(providers, { anthropicDefaultMaxTokens: env.ANTHROPIC_DEFAULT_MAX_TOKENS }),
    health: new HealthTracker({
      windowMs: env.HEALTH_WINDOW_MS,
      failureThreshold: env.CIRCUIT_FAILURE_THRESHOLD,
      cooldownMs: env.CIRCUIT_COOLDOWN_MS,
    }),
    config: {
      upstreamTimeoutMs: env.UPSTREAM_TIMEOUT_MS,
      firstByteTimeoutMs: env.FIRST_BYTE_TIMEOUT_MS,
      streamIdleTimeoutMs: env.STREAM_IDLE_TIMEOUT_MS,
      maxAttempts: env.MAX_ATTEMPTS,
    },
  };
}
