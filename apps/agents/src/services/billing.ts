import type { Core } from '@ok/core';
import type { Db } from '@ok/db';
import { AppError, isAppError, newId } from '@ok/shared';
import { and, desc, eq, inArray, notExists, type SQL, sql } from 'drizzle-orm';
import type { AgentsConfig, PlanId } from '../config';
import { type AgentRow, agents, billingCharges } from '../db/schema';
import { type Clock, daysInMonth, localDay, localParts } from '../lib/time';

export type ChargeResult =
  | { status: 'charged'; amountMicros: number; day: string }
  | { status: 'already_charged'; day: string }
  | { status: 'failed'; amountMicros: number; day: string; error: string };

/**
 * Subscriptions are charged daily, prorated: each local day (Asia/Ho_Chi_Minh)
 * a running agent costs `monthly price / days in that month`, debited from the
 * shared wallet via `core.debit(…, { product: 'agents', kind: 'subscription' })`.
 * A partial unique index makes the charge idempotent per agent and day, even
 * with several control-plane replicas.
 */
export class BillingService {
  constructor(
    private readonly db: Db,
    private readonly core: Core,
    private readonly config: Pick<AgentsConfig, 'plans' | 'timezone'>,
    private readonly clock: Clock,
  ) {}

  today(): string {
    return localDay(this.clock.now(), this.config.timezone);
  }

  dailyAmount(plan: PlanId, at: Date = this.clock.now()): number {
    const p = localParts(at, this.config.timezone);
    return Math.round(this.config.plans[plan].monthlyPriceMicros / daysInMonth(p.year, p.month));
  }

  async chargeDay(agent: AgentRow, day = this.today()): Promise<ChargeResult> {
    const plan = agent.plan as PlanId;
    const amount = this.dailyAmount(plan);
    const id = newId('bch');
    const claimed = await this.db
      .insert(billingCharges)
      .values({
        id,
        orgId: agent.orgId,
        agentId: agent.id,
        day,
        plan,
        amountMicros: amount,
        status: 'pending',
        createdAt: this.clock.now(),
      })
      .onConflictDoNothing()
      .returning({ id: billingCharges.id });
    if (!claimed.length) return { status: 'already_charged', day };
    try {
      await this.core.debit(agent.orgId, amount, {
        product: 'agents',
        kind: 'subscription',
        ref: `agent:${agent.id}:${day}`,
        description: `${this.config.plans[plan].name} plan — ${agent.name} — ${day}`,
        meta: { agentId: agent.id, day, plan },
      });
      await this.db.update(billingCharges).set({ status: 'charged' }).where(eq(billingCharges.id, id));
      return { status: 'charged', amountMicros: amount, day };
    } catch (err) {
      const message = (err as Error).message;
      await this.db
        .update(billingCharges)
        .set({ status: 'failed', error: message.slice(0, 500) })
        .where(eq(billingCharges.id, id));
      if (isAppError(err) && err.code === 'payment_required')
        return { status: 'failed', amountMicros: amount, day, error: message };
      throw err;
    }
  }

  /** Charge today's fee if not charged yet; throws `payment_required` if the wallet cannot pay. */
  async ensureChargedToday(agent: AgentRow): Promise<ChargeResult> {
    const res = await this.chargeDay(agent);
    if (res.status === 'failed')
      throw new AppError(
        'payment_required',
        `Insufficient balance for today's ${agent.plan} plan fee. Please top up your wallet.`,
      );
    return res;
  }

  /** Running agents that have no live charge for today. */
  dueAgents(day = this.today()): Promise<AgentRow[]> {
    return this.db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.status, 'running'),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(billingCharges)
              .where(
                and(
                  eq(billingCharges.agentId, agents.id),
                  eq(billingCharges.day, day),
                  inArray(billingCharges.status, ['pending', 'charged']),
                ),
              ),
          ),
        ),
      );
  }

  listCharges(orgId: string, filter: { agentId?: string; limit?: number } = {}) {
    const conds: SQL[] = [eq(billingCharges.orgId, orgId)];
    if (filter.agentId) conds.push(eq(billingCharges.agentId, filter.agentId));
    return this.db
      .select()
      .from(billingCharges)
      .where(and(...conds))
      .orderBy(desc(billingCharges.createdAt))
      .limit(Math.min(filter.limit ?? 100, 500));
  }
}
