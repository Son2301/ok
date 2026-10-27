import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Core } from '@minh/core';
import { createDb } from '@minh/db';
import { formatVnd, usdToMicros } from '@minh/shared';
import { CREDENTIALS_FILE, DEMO, DEV_DIR } from './lib';

export interface DevCredentials {
  email: string;
  password: string;
  orgId: string;
  apiKey: string;
}

/**
 * Idempotent demo data: the platform org, a demo shop owner with a funded
 * wallet, and an API key. The key is only shown once by the API, so it is kept
 * in .dev/credentials.json (git-ignored) for the dev runner to print.
 */
export async function seedDev(env: Record<string, string>): Promise<DevCredentials & { balance: string }> {
  const handle = await createDb(env.DATABASE_URL);
  try {
    const core = new Core(handle, { welcomeCreditMicros: Number(env.WELCOME_CREDIT_MICROS ?? 0) });
    await core.migrate();
    const platformId = env.PLATFORM_ORG_ID || 'org_platform';
    await core.ensureOrg(
      platformId,
      'Platform (free tier)',
      usdToMicros(Number(env.PLATFORM_ORG_INITIAL_CREDIT_USD ?? 20)),
    );

    let orgId: string;
    try {
      orgId = (await core.login(DEMO.email, DEMO.password)).orgId;
    } catch {
      const { org } = await core.signUp({
        email: DEMO.email,
        password: DEMO.password,
        name: 'Chủ shop Demo',
        orgName: DEMO.orgName,
      });
      orgId = org.id;
    }
    // ~500.000đ of credit, granted once.
    await core.credit(orgId, 20_000_000, {
      kind: 'grant',
      description: 'Dev seed credit',
      idempotencyKey: 'dev-seed-credit',
    });

    let saved: DevCredentials | null = null;
    if (existsSync(CREDENTIALS_FILE)) {
      try {
        saved = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8')) as DevCredentials;
      } catch {}
    }
    let apiKey = saved?.orgId === orgId ? saved.apiKey : '';
    if (!apiKey || !(await core.verifyApiKey(apiKey))) {
      apiKey = (await core.createApiKey(orgId, { name: 'dev (seed)', scopes: ['*'] })).key;
    }
    const creds: DevCredentials = { email: DEMO.email, password: DEMO.password, orgId, apiKey };
    mkdirSync(DEV_DIR, { recursive: true });
    writeFileSync(CREDENTIALS_FILE, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
    const balance = formatVnd(await core.getBalance(orgId), Number(env.VND_PER_USD ?? 26_000));
    return { ...creds, balance };
  } finally {
    await handle.close();
  }
}

export function readCredentials(): DevCredentials | null {
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf8')) as DevCredentials;
  } catch {
    return null;
  }
}
