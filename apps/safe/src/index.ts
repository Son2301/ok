import { serve } from '@hono/node-server';
import { Core } from '@minh/core';
import { createDb, migrate } from '@minh/db';
import { createLogger, loadEnv } from '@minh/shared';
import { createApp, createSafeContext } from './app';
import { safeMigrations } from './db/migrations';
import { safeEnvSchema } from './env';

const env = loadEnv(safeEnvSchema);
const logger = createLogger('safe', env.LOG_LEVEL);

const handle = await createDb(env.DATABASE_URL);
const core = new Core(handle);
await core.migrate();
await migrate(handle, 'safe', safeMigrations);

const deps = { handle, core, env, logger };
const ctx = createSafeContext(deps);
await ctx.reloadBrands();
const app = createApp(deps, ctx);

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('listening', {
    port: info.port,
    llm: env.GATEWAY_URL ? 'gateway' : 'disabled',
    platformOrg: env.SAFE_PLATFORM_ORG_ID ? 'set' : 'unset',
    sources: {
      googleSafeBrowsing: Boolean(env.GOOGLE_SAFE_BROWSING_API_KEY),
      virusTotal: Boolean(env.VIRUSTOTAL_API_KEY),
      urlhaus: Boolean(env.URLHAUS_AUTH_KEY),
      feeds: Boolean(env.OPENPHISH_FEED_URL || env.PHISHTANK_APP_KEY),
      telegram: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
    },
  });
});

// Background jobs: phishing feed import and housekeeping.
const timers: NodeJS.Timeout[] = [];
if (env.SAFE_FEED_IMPORT_INTERVAL_MIN > 0 && (env.OPENPHISH_FEED_URL || env.PHISHTANK_APP_KEY)) {
  const runImport = () =>
    ctx.feeds
      .importAll(
        { openPhishUrl: env.OPENPHISH_FEED_URL, phishTankAppKey: env.PHISHTANK_APP_KEY },
        (i, init) => fetch(i, init),
      )
      .then((results) => logger.info('feed_import', { results }))
      .catch((err) => logger.error('feed_import_failed', { err: String(err) }));
  void runImport();
  timers.push(setInterval(runImport, env.SAFE_FEED_IMPORT_INTERVAL_MIN * 60_000));
}
timers.push(
  setInterval(() => {
    Promise.all([ctx.cache.prune(), ctx.limiter.prune(), ctx.feeds.prune()]).catch((err) =>
      logger.error('housekeeping_failed', { err: String(err) }),
    );
  }, 60 * 60_000),
);
for (const t of timers) t.unref();

const shutdown = (signal: string) => {
  logger.info('shutting_down', { signal });
  for (const t of timers) clearInterval(t);
  server.close(() => {
    handle.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
