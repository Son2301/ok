import { serve } from '@hono/node-server';
import { Core } from '@minh/core';
import { createDb } from '@minh/db';
import { createLlmClient } from '@minh/llm';
import { createLogger, loadEnv } from '@minh/shared';
import { envSchema, githubConfigured } from './env';
import { createGitHubApp } from './github/octokit';
import { createRuntime } from './runtime';
import { sha256Hex } from './util';

const env = loadEnv(envSchema);
const logger = createLogger('review', env.LOG_LEVEL);
const handle = await createDb(env.DATABASE_URL);
const core = new Core(handle);
await core.migrate();

const github = githubConfigured(env)
  ? createGitHubApp({
      appId: env.GITHUB_APP_ID!,
      privateKey: env.GITHUB_PRIVATE_KEY!,
      slug: env.GITHUB_APP_SLUG ?? null,
      baseUrl: env.GITHUB_API_URL,
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    })
  : null;
if (!github) logger.warn('GitHub App not configured; webhook endpoints will answer 503 not_configured');

const runtime = createRuntime({
  handle,
  core,
  logger,
  internalToken: env.INTERNAL_TOKEN,
  github,
  webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? null,
  // Every LLM call goes through the gateway so tokens are billed to the paying org's wallet.
  llmFor: (orgId) =>
    createLlmClient({
      baseUrl: env.GATEWAY_URL,
      apiKey: env.INTERNAL_TOKEN,
      headers: { 'x-org-id': orgId, 'x-minh-product': 'review' },
    }),
  consoleUrl: env.CONSOLE_URL,
  billing: {
    platformOrgId: env.REVIEW_PLATFORM_ORG_ID ?? null,
    freeReviewsPerMonth: env.REVIEW_FREE_REVIEWS_PER_MONTH,
    minBalanceMicros: env.REVIEW_MIN_BALANCE_MICROS,
  },
  stateSecret: env.REVIEW_STATE_SECRET ?? sha256Hex(`review-state:${env.INTERNAL_TOKEN}`),
  linkWindowMs: env.REVIEW_LINK_WINDOW_MINUTES * 60_000,
  queue: { concurrency: env.REVIEW_CONCURRENCY, maxAttempts: env.REVIEW_MAX_ATTEMPTS },
  service: { checkRuns: env.REVIEW_CHECK_RUNS },
});
await runtime.store.migrate();

const server = serve({ fetch: runtime.app.fetch, port: env.PORT }, (info) => {
  logger.info('review listening', { port: info.port, github: Boolean(github) });
});

const recovered = await runtime.recover();
if (recovered) logger.info('recovered unfinished jobs', { count: recovered });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down', { signal });
  server.close();
  await runtime.queue.stop();
  await handle.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
