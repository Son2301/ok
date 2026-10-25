import { serve } from '@hono/node-server';
import { Core } from '@ok/core';
import { createDb, migrate } from '@ok/db';
import { createLogger, loadEnv } from '@ok/shared';
import { createApp } from './app';
import { gatewayMigrations } from './db/migrations';
import { seedDevOrg, shouldSeed } from './dev-seed';
import { envSchema } from './env';
import { buildRuntime } from './runtime';

const env = loadEnv(envSchema);
const logger = createLogger('gateway', env.LOG_LEVEL);

if (env.NODE_ENV === 'production' && env.INTERNAL_TOKEN === 'dev-internal-token-change-me') {
  throw new Error('INTERNAL_TOKEN must be set to a strong secret in production');
}

const handle = await createDb(env.DATABASE_URL);
const core = new Core(handle);
await core.migrate();
await migrate(handle, 'gateway', gatewayMigrations);

const runtime = buildRuntime(env);
const enabled = [...runtime.catalog.providers.values()]
  .filter((p) => p.enabled && p.kind !== 'mock')
  .map((p) => p.id);
if (runtime.catalog.mockFallback) {
  logger.warn('no provider credentials configured: every model resolves to the offline mock provider', {
    mockProvider: env.MOCK_PROVIDER,
  });
}

if (shouldSeed(env)) {
  const seed = await seedDevOrg(core, { creditUsd: env.DEV_SEED_CREDIT_USD });
  logger.warn('development seed created (do not use in production)', {
    orgId: seed.orgId,
    apiKeyId: seed.apiKeyId,
  });
  process.stdout.write(
    `\n  DEV API KEY: ${seed.apiKey}\n  org: ${seed.orgId}, credit: $${env.DEV_SEED_CREDIT_USD}\n\n`,
  );
}

const app = createApp({
  core,
  db: handle.db,
  catalog: runtime.catalog,
  adapters: runtime.adapters,
  health: runtime.health,
  logger,
  internalToken: env.INTERNAL_TOKEN,
  config: runtime.config,
  maxBodyBytes: env.MAX_BODY_BYTES,
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('gateway listening', {
    port: info.port,
    providers: enabled,
    models: runtime.catalog.list().length,
  });
});

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(() => {
    void handle.close().finally(() => process.exit(0));
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
