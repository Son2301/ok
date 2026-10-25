import type { Core } from '@ok/core';
import type { InstallationRow, Store } from './store';
import { currentPeriod } from './util';

export interface BillingOptions {
  /** Org that pays for free-quota reviews of unlinked installations (REVIEW_PLATFORM_ORG_ID). */
  platformOrgId: string | null;
  freeReviewsPerMonth: number;
  /** A linked org needs at least this balance to start a review (micro-USD). */
  minBalanceMicros: number;
}

export type BillingDecision =
  | { ok: true; orgId: string; billedTo: 'org' | 'platform'; quotaPeriod?: string; quotaUsed?: number }
  | { ok: false; status: 'insufficient_balance'; orgId: string }
  | { ok: false; status: 'quota_exceeded'; limit: number; period: string }
  | { ok: false; status: 'not_linked' };

/**
 * Who pays for a review. LLM calls go through the gateway with `x-org-id`, so the
 * gateway debits the chosen org's wallet; this class only decides which org and
 * enforces the free monthly quota for installations that are not linked yet.
 */
export class Billing {
  constructor(
    private readonly core: Core,
    private readonly store: Store,
    private readonly opts: BillingOptions,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get freeReviewsPerMonth() {
    return this.opts.freeReviewsPerMonth;
  }

  async authorize(installation: Pick<InstallationRow, 'id' | 'orgId'>): Promise<BillingDecision> {
    if (installation.orgId) {
      const balance = await this.core.getBalance(installation.orgId);
      if (balance < Math.max(1, this.opts.minBalanceMicros))
        return { ok: false, status: 'insufficient_balance', orgId: installation.orgId };
      return { ok: true, orgId: installation.orgId, billedTo: 'org' };
    }
    if (!this.opts.platformOrgId || this.opts.freeReviewsPerMonth <= 0)
      return { ok: false, status: 'not_linked' };
    const period = currentPeriod(this.now());
    const used = await this.store.consumeQuota(installation.id, period, this.opts.freeReviewsPerMonth);
    if (used === null)
      return { ok: false, status: 'quota_exceeded', limit: this.opts.freeReviewsPerMonth, period };
    return {
      ok: true,
      orgId: this.opts.platformOrgId,
      billedTo: 'platform',
      quotaPeriod: period,
      quotaUsed: used,
    };
  }

  /** Give back a free review when the run failed before producing anything. */
  async release(installationId: number, decision: BillingDecision) {
    if (decision.ok && decision.quotaPeriod)
      await this.store.refundQuota(installationId, decision.quotaPeriod);
  }
}
