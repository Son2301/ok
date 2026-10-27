/**
 * One-time (and re-runnable) local setup:
 *   pnpm dev:setup
 * Creates .env with generated secrets, makes sure Postgres is up, migrates and
 * seeds demo data. Never overwrites values you already set in .env.
 */
import { ensureDatabase } from './db';
import { c, ENV_FILE, ensureEnvFile, loadEnv, log } from './lib';
import { seedDev } from './seed';

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  log.fail(`Node ${process.versions.node} found; Minh AI needs Node 22 or newer (see .nvmrc).`);
  process.exit(1);
}

try {
  const added = ensureEnvFile();
  if (added.length) log.ok(`Wrote ${added.length} settings to ${c.dim(ENV_FILE)}`);
  else log.ok(`.env already complete ${c.dim(`(${ENV_FILE})`)}`);

  const env = loadEnv();
  await ensureDatabase(env.DATABASE_URL);

  log.step('Migrating and seeding demo data…');
  const seeded = await seedDev(env);
  log.ok(
    `Demo shop ready: ${c.bold(seeded.email)} / ${c.bold(seeded.password)}  (balance ${seeded.balance})`,
  );
  log.ok(`Demo API key: ${c.bold(seeded.apiKey)}  ${c.dim('(saved in .dev/credentials.json)')}`);

  console.log(`\nNext: ${c.bold('pnpm dev')}  → console at ${c.cyan('http://localhost:3000')}\n`);
} catch (err) {
  log.fail((err as Error).message);
  process.exit(1);
}
