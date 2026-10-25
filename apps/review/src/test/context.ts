import { Core } from '@ok/core';
import { createDb, type DbHandle } from '@ok/db';
import type { LlmClient } from '@ok/llm';
import { createLogger } from '@ok/shared';
import { createHeuristicMockLlm } from '../mock-llm';
import { createRuntime, type Runtime } from '../runtime';
import { FakeGitHub } from './fake-github';

export const INTERNAL_TOKEN = 'internal-token-for-review-tests';
export const WEBHOOK_SECRET = 'webhook-secret-for-tests';

export interface TestContext {
  handle: DbHandle;
  core: Core;
  github: FakeGitHub;
  runtime: Runtime;
  /** Org ids LLM clients were created for (who got billed). */
  llmOrgs: string[];
  setLlm(llm: LlmClient): void;
  close(): Promise<void>;
}

export interface TestContextOptions {
  githubConfigured?: boolean;
  platformOrgId?: string | null;
  freeReviewsPerMonth?: number;
  minBalanceMicros?: number;
  maxAttempts?: number;
  concurrency?: number;
  now?: () => number;
}

/**
 * One migrated PGlite per test file (module state is per file in vitest), wiped
 * between tests — booting PGlite takes ~1-2s, truncating takes milliseconds.
 */
let shared: Promise<{ handle: DbHandle; core: Core; tables: string }> | null = null;

async function freshDb() {
  shared ??= (async () => {
    const handle = await createDb('memory://');
    const core = new Core(handle);
    await core.migrate();
    const { reviewMigrations } = await import('../db/migrations');
    const { migrate } = await import('@ok/db');
    await migrate(handle, 'review', reviewMigrations);
    const rows = await handle.query<{ t: string }>(
      `SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
       WHERE table_schema IN ('core', 'review') AND table_name <> '_migrations' AND table_type = 'BASE TABLE'`,
    );
    return { handle, core, tables: rows.map((r) => r.t).join(', ') };
  })();
  const db = await shared;
  await db.handle.query(`TRUNCATE ${db.tables} CASCADE`);
  return db;
}

export async function createTestContext(opts: TestContextOptions = {}): Promise<TestContext> {
  const { handle, core } = await freshDb();
  const github = new FakeGitHub();
  let llm: LlmClient = createHeuristicMockLlm();
  const llmOrgs: string[] = [];
  const configured = opts.githubConfigured ?? true;
  const runtime = createRuntime({
    handle,
    core,
    logger: createLogger('review-test'),
    internalToken: INTERNAL_TOKEN,
    github: configured ? github : null,
    webhookSecret: configured ? WEBHOOK_SECRET : null,
    llmFor: (orgId) => {
      llmOrgs.push(orgId);
      return { chat: (req, o) => llm.chat(req, o), stream: (req, o) => llm.stream(req, o) };
    },
    consoleUrl: 'https://console.test',
    billing: {
      platformOrgId: opts.platformOrgId === undefined ? null : opts.platformOrgId,
      freeReviewsPerMonth: opts.freeReviewsPerMonth ?? 20,
      minBalanceMicros: opts.minBalanceMicros ?? 1,
    },
    stateSecret: 'state-secret-for-review-tests',
    linkWindowMs: 60 * 60 * 1000,
    queue: { concurrency: opts.concurrency ?? 2, maxAttempts: opts.maxAttempts ?? 2, backoffMs: () => 1 },
    service: { checkRuns: true },
    now: opts.now,
  });
  await runtime.store.migrate();
  return {
    handle,
    core,
    github,
    runtime,
    llmOrgs,
    setLlm: (l) => {
      llm = l;
    },
    close: async () => {
      // The shared database is wiped by the next createTestContext(), not closed.
      await runtime.queue.stop();
    },
  };
}

export const REPO = 'acme/api';
export const REPO_ID = 42;
export const INSTALLATION_ID = 7;

/** Installation + repo rows, optionally linked to a fresh org with `balance` micro-USD. */
export async function seedInstallation(
  ctx: TestContext,
  opts: { link?: boolean; balance?: number; installationId?: number } = {},
) {
  const installationId = opts.installationId ?? INSTALLATION_ID;
  await ctx.runtime.store.upsertInstallation({
    id: installationId,
    accountLogin: 'acme',
    accountType: 'Organization',
    accountId: 99,
    eventAt: new Date(),
  });
  await ctx.runtime.store.upsertRepos(installationId, [{ id: REPO_ID, fullName: REPO, private: true }]);
  let orgId: string | null = null;
  if (opts.link ?? true) {
    const org = await ctx.core.createOrg('Acme', opts.balance ?? 5_000_000);
    orgId = org.id;
    await ctx.runtime.store.linkInstallation(installationId, org.id);
  }
  return { installationId, orgId };
}

export function job(
  over: Partial<import('../github/webhook').ReviewJobPayload> = {},
): import('../github/webhook').ReviewJobPayload {
  return {
    installationId: INSTALLATION_ID,
    repoId: REPO_ID,
    owner: 'acme',
    repo: 'api',
    number: 1,
    trigger: 'opened',
    mode: 'auto',
    ...over,
  };
}
