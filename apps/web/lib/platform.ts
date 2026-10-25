import 'server-only';
import { Billing, Core } from '@ok/core';
import { createDb, type DbHandle } from '@ok/db';
import { env } from './env';

export interface Platform {
  handle: DbHandle;
  core: Core;
  /** Local Billing for DB-only operations (e-invoice profile). Top-ups go through the gateway, which holds the bank config. */
  billing: Billing;
}

// Next.js may evaluate this module more than once (RSC, SSR and route-handler
// layers), so the handle lives on globalThis: one pool, and one in-memory
// database when DATABASE_URL=memory://.
const g = globalThis as typeof globalThis & { __okPlatform?: Promise<Platform> };

/** Shared accounts/wallet core. Migrations run once, lazily, on first use. */
export function platform(): Promise<Platform> {
  if (!g.__okPlatform) {
    const cfg = env();
    g.__okPlatform = (async () => {
      const handle = await createDb(cfg.databaseUrl);
      const core = new Core(handle, { welcomeCreditMicros: cfg.welcomeCreditMicros });
      await core.migrate();
      const billing = new Billing(core, { vndPerUsd: cfg.vndPerUsd });
      return { handle, core, billing };
    })();
    // A failed boot (database down) must not poison every later request.
    g.__okPlatform.catch(() => {
      g.__okPlatform = undefined;
    });
  }
  return g.__okPlatform;
}
