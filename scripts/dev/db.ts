import { spawnSync } from 'node:child_process';
import { createDb } from '@minh/db';
import { c, DEV_COMPOSE, dbUrlForDisplay, dockerAvailable, isLocalDatabase, log, ROOT } from './lib';

async function canConnect(url: string): Promise<string | null> {
  try {
    const handle = await createDb(url);
    try {
      await Promise.race([
        handle.query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 3000)),
      ]);
      return null;
    } finally {
      await handle.close().catch(() => {});
    }
  } catch (err) {
    return (err as Error).message || String(err);
  }
}

/**
 * Make sure DATABASE_URL answers. If it points at the dev container and Docker
 * is available, start docker-compose.dev.yml and wait for it.
 */
export async function ensureDatabase(url: string | undefined): Promise<void> {
  if (!url) throw new Error('DATABASE_URL is not set. Run `pnpm dev:setup` first.');
  if (url.startsWith('memory://') || url.startsWith('pglite://')) {
    throw new Error(
      'DATABASE_URL uses PGlite, which is single-process. The full dev stack runs five processes that must share one Postgres: use the dev container or a local Postgres 16.',
    );
  }
  const firstError = await canConnect(url);
  if (!firstError) {
    log.ok(`Postgres reachable at ${c.dim(dbUrlForDisplay(url))}`);
    return;
  }
  const port = new URL(url).port;
  const isDevContainer = isLocalDatabase(url) && port === '5433';
  if (!isDevContainer) {
    throw new Error(`Cannot reach Postgres at ${dbUrlForDisplay(url)}: ${firstError}`);
  }
  if (!dockerAvailable()) {
    throw new Error(
      [
        `Cannot reach Postgres at ${dbUrlForDisplay(url)} and Docker is not running.`,
        'Either start Docker (then rerun), or point DATABASE_URL in .env at a Postgres 16 you already have, e.g.',
        '  createuser -s minh && createdb -O minh minh   # then',
        '  DATABASE_URL=postgres://minh@localhost:5432/minh',
      ].join('\n'),
    );
  }
  log.step('Starting Postgres (docker-compose.dev.yml)…');
  const r = spawnSync('docker', ['compose', '-f', DEV_COMPOSE, 'up', '-d', '--wait'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error('docker compose failed to start Postgres');
  for (let i = 0; i < 30; i++) {
    if (!(await canConnect(url))) {
      log.ok(`Postgres is up at ${c.dim(dbUrlForDisplay(url))}`);
      return;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error('Postgres container started but did not accept connections within 30s');
}
