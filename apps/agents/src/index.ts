import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { Core } from '@minh/core';
import { createDb } from '@minh/db';
import { createLlmClient } from '@minh/llm';
import { createLogger, loadEnv } from '@minh/shared';
import { createApp } from './app';
import { configFromEnv } from './config';
import { migrateAgents } from './db/migrations';
import { envSchema } from './env';
import { SecretBox } from './lib/crypto';
import { systemClock } from './lib/time';
import { createPlatform } from './platform';
import { DockerDriver } from './runtime/drivers/docker';
import { DockerEngineClient } from './runtime/drivers/docker-client';
import { InlineDriver } from './runtime/drivers/inline';
import type { RuntimeDriver } from './runtime/drivers/types';

const env = loadEnv(envSchema);
const logger = createLogger('agents', env.LOG_LEVEL);
const config = configFromEnv(env);

const handle = await createDb(env.DATABASE_URL);
const core = new Core(handle);
await core.migrate();
await migrateAgents(handle);

const { box, ephemeral } = SecretBox.fromEnv({
  key: env.AGENTS_ENCRYPTION_KEY,
  previousKey: env.AGENTS_ENCRYPTION_KEY_PREVIOUS,
  production: env.NODE_ENV === 'production',
});
if (ephemeral)
  logger.warn(
    'AGENTS_ENCRYPTION_KEY not set: using an ephemeral key; stored integration credentials will not survive a restart',
  );
if (!config.platformOrgId)
  logger.warn('AGENTS_PLATFORM_ORG_ID not set: all LLM usage is billed to customer orgs (no included quota)');

async function chooseDriver(): Promise<RuntimeDriver> {
  if (env.AGENTS_RUNTIME_DRIVER === 'inline') return new InlineDriver(systemClock);
  const client = new DockerEngineClient(config.docker.socketPath);
  const reachable = existsSync(config.docker.socketPath) && (await client.ping());
  if (reachable) {
    return new DockerDriver({
      client,
      images: config.images,
      network: config.docker.network,
      networkInternal: config.docker.networkInternal,
      icc: config.docker.icc,
      controlPlaneUrl: config.controlPlaneUrl,
      addressMode: config.docker.addressMode,
    });
  }
  if (env.AGENTS_RUNTIME_DRIVER === 'docker')
    throw new Error(
      `AGENTS_RUNTIME_DRIVER=docker but the Docker socket ${config.docker.socketPath} is not reachable`,
    );
  logger.warn('Docker not available: using the inline driver (agents run in-process, without isolation)');
  return new InlineDriver(systemClock);
}

const driver = await chooseDriver();
const platform = createPlatform({
  handle,
  core,
  config,
  box,
  driver,
  logger,
  llm: ({ billingOrgId, agentId, conversationId }) =>
    createLlmClient({
      baseUrl: config.gatewayUrl,
      apiKey: env.INTERNAL_TOKEN,
      headers: {
        'x-org-id': billingOrgId,
        'x-minh-product': 'agents',
        'x-minh-agent-id': agentId,
        ...(conversationId ? { 'x-minh-conversation-id': conversationId } : {}),
      },
    }),
});

const reconciled = await platform.agents.reconcile();
if (reconciled.length) logger.info('reconciled agents', { reconciled });
if (config.scheduler.enabled) platform.scheduler.start();

const app = createApp(platform);
const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('agents control plane listening', {
    port: info.port,
    driver: driver.name,
    publicUrl: config.publicUrl,
  });
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });
  platform.scheduler.stop();
  server.close();
  await Promise.race([platform.bg.drain(), new Promise((r) => setTimeout(r, 10_000))]);
  await handle.close().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
