import type { Core } from '@minh/core';
import type { Logger } from '@minh/shared';
import type { Billing } from '../billing';
import type { GitHubApp } from '../github/types';
import type { ReviewJobPayload } from '../github/webhook';
import type { LinkStateSigner } from '../linking';
import type { JobQueue } from '../queue';
import type { Store } from '../store';

export interface RouteDeps {
  core: Core;
  store: Store;
  logger: Logger;
  internalToken: string;
  /** Null when the GitHub App credentials are not configured. */
  github: GitHubApp | null;
  webhookSecret: string | null;
  queue: JobQueue<ReviewJobPayload>;
  linkSigner: LinkStateSigner;
  billing: Billing;
  consoleUrl: string;
  linkWindowMs: number;
  /** Injectable clock (tests). */
  now: () => number;
}
