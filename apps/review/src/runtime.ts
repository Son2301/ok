import type { Core } from '@minh/core';
import type { DbHandle } from '@minh/db';
import type { LlmClient } from '@minh/llm';
import type { Logger } from '@minh/shared';
import type { Hono } from 'hono';
import { createApp } from './app';
import { Billing, type BillingOptions } from './billing';
import type { GitHubApp } from './github/types';
import { mergeReviewJobs, type ReviewJobPayload } from './github/webhook';
import { LinkStateSigner } from './linking';
import { JobQueue } from './queue';
import { ReviewService, type ReviewServiceOptions } from './service';
import { Store } from './store';
import { errorMessage } from './util';

export interface RuntimeOptions {
  handle: DbHandle;
  core: Core;
  logger: Logger;
  internalToken: string;
  github: GitHubApp | null;
  webhookSecret: string | null;
  llmFor: (orgId: string) => LlmClient;
  consoleUrl: string;
  billing: BillingOptions;
  stateSecret: string;
  linkWindowMs: number;
  queue?: { concurrency?: number; maxAttempts?: number; backoffMs?: (attempt: number) => number };
  service?: Partial<ReviewServiceOptions>;
  now?: () => number;
}

export interface Runtime {
  app: Hono;
  store: Store;
  billing: Billing;
  service: ReviewService;
  queue: JobQueue<ReviewJobPayload>;
  linkSigner: LinkStateSigner;
  /** Re-enqueue jobs left unfinished by a previous process. */
  recover(): Promise<number>;
}

/** Wire store → billing → service → queue → HTTP app. Used by index.ts and tests. */
export function createRuntime(o: RuntimeOptions): Runtime {
  const store = new Store(o.handle);
  const billing = new Billing(o.core, store, o.billing, o.now ? () => new Date(o.now!()) : undefined);
  const service = new ReviewService({
    store,
    github: o.github,
    billing,
    llmFor: o.llmFor,
    logger: o.logger,
    options: { consoleUrl: o.consoleUrl, ...o.service },
    now: o.now,
  });
  const queue = new JobQueue<ReviewJobPayload>(
    async (job) => {
      await service.run(job);
    },
    {
      concurrency: o.queue?.concurrency ?? 2,
      maxAttempts: o.queue?.maxAttempts ?? 3,
      backoffMs: o.queue?.backoffMs,
      merge: mergeReviewJobs,
      logger: o.logger,
      persistence: {
        save: (key, payload, status) =>
          store.saveJob(key, payload as unknown as Record<string, unknown>, status),
        mark: (key, status, patch) => store.markJob(key, status, patch),
      },
    },
  );
  const linkSigner = new LinkStateSigner(o.stateSecret, 60 * 60 * 1000, o.now);
  const app = createApp({
    core: o.core,
    store,
    logger: o.logger,
    internalToken: o.internalToken,
    github: o.github,
    webhookSecret: o.webhookSecret,
    queue,
    linkSigner,
    billing,
    consoleUrl: o.consoleUrl,
    linkWindowMs: o.linkWindowMs,
    now: o.now ?? Date.now,
  });

  return {
    app,
    store,
    billing,
    service,
    queue,
    linkSigner,
    async recover() {
      if (!o.github) return 0;
      const rows = await store.unfinishedJobs();
      for (const row of rows) {
        try {
          queue.enqueue(row.key, row.payload as unknown as ReviewJobPayload);
        } catch (err) {
          o.logger.warn('could not recover job', { key: row.key, err: errorMessage(err) });
        }
      }
      return rows.length;
    },
  };
}
