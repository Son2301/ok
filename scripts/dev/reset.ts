/**
 * Wipe all local data and reseed:  pnpm dev:reset --yes
 * Refuses to run against anything but a local database.
 */
import { rmSync } from 'node:fs';
import { createDb } from '@minh/db';
import { CREDENTIALS_FILE, c, dbUrlForDisplay, isLocalDatabase, loadEnv, log } from './lib';
import { seedDev } from './seed';

const env = loadEnv();
if (!env.DATABASE_URL || !isLocalDatabase(env.DATABASE_URL)) {
  log.fail(
    `Refusing to reset a non-local database (${env.DATABASE_URL ? dbUrlForDisplay(env.DATABASE_URL) : 'unset'}).`,
  );
  process.exit(1);
}
if (!process.argv.includes('--yes')) {
  log.warn(
    `This deletes ALL data in ${c.bold(dbUrlForDisplay(env.DATABASE_URL))}. Stop \`pnpm dev\`, then rerun with --yes.`,
  );
  process.exit(1);
}
const handle = await createDb(env.DATABASE_URL);
await handle.execInTransaction(
  ['core', 'gateway', 'agents', 'safe', 'review']
    .map((s) => `DROP SCHEMA IF EXISTS ${s} CASCADE;`)
    .join('\n'),
);
await handle.close();
rmSync(CREDENTIALS_FILE, { force: true });
log.ok('Dropped schemas core, gateway, agents, safe, review');
const seeded = await seedDev(env);
log.ok(`Reseeded: ${seeded.email} / ${seeded.password}, new API key ${c.bold(seeded.apiKey)}`);
log.step('Services re-create their own tables on next start: run `pnpm dev`.');
