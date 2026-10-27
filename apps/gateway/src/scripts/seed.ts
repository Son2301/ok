/**
 * Create a funded dev org + gateway API key in DATABASE_URL (Postgres or an
 * on-disk PGlite directory). For `memory://` the server seeds itself on boot
 * instead, since an in-memory database is not shared between processes.
 *
 *   DATABASE_URL=postgres://… pnpm --filter @minh/gateway seed
 */
import { Core } from '@minh/core';
import { createDb, migrate } from '@minh/db';
import { loadEnv } from '@minh/shared';
import { gatewayMigrations } from '../db/migrations';
import { seedDevOrg } from '../dev-seed';
import { envSchema } from '../env';

const env = loadEnv(envSchema);
if (env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');
if (env.DATABASE_URL === 'memory://') {
  console.error(
    'DATABASE_URL=memory:// is per-process; start the server instead (it seeds itself in development).',
  );
  process.exit(1);
}

const handle = await createDb(env.DATABASE_URL);
try {
  const core = new Core(handle);
  await core.migrate();
  await migrate(handle, 'gateway', gatewayMigrations);
  const seed = await seedDevOrg(core, { creditUsd: env.DEV_SEED_CREDIT_USD });
  console.log(
    JSON.stringify(
      { orgId: seed.orgId, apiKeyId: seed.apiKeyId, apiKey: seed.apiKey, creditUsd: env.DEV_SEED_CREDIT_USD },
      null,
      2,
    ),
  );
} finally {
  await handle.close();
}
