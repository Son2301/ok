import type { Core } from '@minh/core';
import { usdToMicros } from '@minh/shared';

export interface DevSeed {
  orgId: string;
  apiKeyId: string;
  apiKey: string;
}

/** Create a funded org and a gateway API key. Development only — never call in production. */
export async function seedDevOrg(core: Core, opts: { creditUsd: number; name?: string }): Promise<DevSeed> {
  const org = await core.createOrg(opts.name ?? 'Dev Org', usdToMicros(opts.creditUsd));
  const { key, record } = await core.createApiKey(org.id, { name: 'dev', scopes: ['gateway'] });
  return { orgId: org.id, apiKeyId: record.id, apiKey: key };
}

/** Seed on boot when explicitly asked, or by default for an ephemeral in-memory dev database. */
export function shouldSeed(env: {
  NODE_ENV: string;
  DATABASE_URL: string;
  DEV_SEED_API_KEY?: boolean;
}): boolean {
  if (env.NODE_ENV !== 'development') return false;
  if (env.DEV_SEED_API_KEY !== undefined) return env.DEV_SEED_API_KEY;
  return env.DATABASE_URL === 'memory://' || env.DATABASE_URL === '';
}
