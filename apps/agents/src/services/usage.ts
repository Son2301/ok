import type { Db } from '@ok/db';
import type { ChatChunk, ChatRequest, ChatResponse, LlmClient, Usage } from '@ok/llm';
import { AppError, formatUsd } from '@ok/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { AgentsConfig } from '../config';
import { type AgentRow, agents, usageMonthly } from '../db/schema';
import { type Clock, localMonth } from '../lib/time';
import type { EventLog } from './events';

/** Builds the gateway client for one call, billed to `billingOrgId` and attributed to the agents product. */
export type LlmFactory = (ctx: {
  billingOrgId: string;
  agentId: string;
  conversationId?: string;
}) => LlmClient;

export type BilledTo = 'platform' | 'customer';

export class UsageService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly timezone: string,
  ) {}

  currentMonth(): string {
    return localMonth(this.clock.now(), this.timezone);
  }

  async get(agentId: string, month = this.currentMonth()) {
    const [row] = await this.db
      .select()
      .from(usageMonthly)
      .where(and(eq(usageMonthly.agentId, agentId), eq(usageMonthly.month, month)));
    return row ?? null;
  }

  async record(
    agent: { id: string; orgId: string },
    usage: { prompt: number; completion: number; total: number; costMicros: number },
    billedTo: BilledTo,
  ) {
    const month = this.currentMonth();
    const platform = billedTo === 'platform';
    const now = this.clock.now();
    await this.db
      .insert(usageMonthly)
      .values({
        agentId: agent.id,
        month,
        orgId: agent.orgId,
        requests: 1,
        promptTokens: usage.prompt,
        completionTokens: usage.completion,
        totalTokens: usage.total,
        platformTokens: platform ? usage.total : 0,
        customerTokens: platform ? 0 : usage.total,
        platformCostMicros: platform ? usage.costMicros : 0,
        customerCostMicros: platform ? 0 : usage.costMicros,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [usageMonthly.agentId, usageMonthly.month],
        set: {
          requests: sql`${usageMonthly.requests} + 1`,
          promptTokens: sql`${usageMonthly.promptTokens} + ${usage.prompt}`,
          completionTokens: sql`${usageMonthly.completionTokens} + ${usage.completion}`,
          totalTokens: sql`${usageMonthly.totalTokens} + ${usage.total}`,
          platformTokens: sql`${usageMonthly.platformTokens} + ${platform ? usage.total : 0}`,
          customerTokens: sql`${usageMonthly.customerTokens} + ${platform ? 0 : usage.total}`,
          platformCostMicros: sql`${usageMonthly.platformCostMicros} + ${platform ? usage.costMicros : 0}`,
          customerCostMicros: sql`${usageMonthly.customerCostMicros} + ${platform ? 0 : usage.costMicros}`,
          updatedAt: now,
        },
      });
  }

  async markBudgetWarned(agentId: string, month: string) {
    await this.db
      .update(usageMonthly)
      .set({ budgetWarnedAt: this.clock.now() })
      .where(and(eq(usageMonthly.agentId, agentId), eq(usageMonthly.month, month)));
  }

  listForOrg(orgId: string, month = this.currentMonth()) {
    return this.db
      .select()
      .from(usageMonthly)
      .where(and(eq(usageMonthly.orgId, orgId), eq(usageMonthly.month, month)));
  }
}

export interface BrokerHooks {
  /** Called when an agent hits 100% of its monthly budget (pause it). */
  onBudgetExhausted?(agent: AgentRow, spentMicros: number): Promise<void>;
}

const estimateUsage = (req: ChatRequest, completionChars: number): Usage => {
  const prompt = Math.ceil(JSON.stringify(req.messages).length / 4);
  const completion = Math.ceil(completionChars / 4);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
};

/**
 * Every LLM call an agent makes goes through here (inline loop directly; containers
 * and third-party runtimes via the LLM proxy route), so that before each call:
 *
 * 1. the agent must be allowed to run (not suspended/paused);
 * 2. the billing org is chosen: inside the plan's monthly token quota the
 *    platform org pays (`AGENTS_PLATFORM_ORG_ID`), beyond it the customer org pays;
 * 3. for customer-billed calls, the per-agent monthly budget cap is enforced in
 *    real time — a warning event at 80%, pause at 100% (`paused_budget`).
 *
 * After each call the tokens and cost are added to the agent's monthly usage.
 */
export class LlmBroker {
  hooks: BrokerHooks = {};

  constructor(
    private readonly db: Db,
    private readonly usage: UsageService,
    private readonly factory: LlmFactory,
    private readonly config: Pick<AgentsConfig, 'plans' | 'platformOrgId'>,
    private readonly events: EventLog,
  ) {}

  /**
   * Whether the budget cap currently blocks this agent (no side effects): only when the next
   * call would be billed to the customer (included quota used up) and the cap is reached.
   */
  async budgetBlocked(agent: AgentRow): Promise<{ blocked: boolean; spentMicros: number }> {
    const usage = await this.usage.get(agent.id);
    const spentMicros = usage?.customerCostMicros ?? 0;
    if (agent.budgetMonthlyMicros === null || agent.budgetMonthlyMicros === undefined)
      return { blocked: false, spentMicros };
    const quota = this.config.plans[agent.plan as keyof AgentsConfig['plans']]?.monthlyTokens ?? 0;
    const inQuota = Boolean(this.config.platformOrgId) && (usage?.platformTokens ?? 0) < quota;
    return { blocked: !inQuota && spentMicros >= agent.budgetMonthlyMicros, spentMicros };
  }

  /** Pre-call checks + billing decision. Throws if the agent may not call the LLM now. */
  async prepare(agentId: string): Promise<{ agent: AgentRow; billingOrgId: string; billedTo: BilledTo }> {
    const [agent] = await this.db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) throw new AppError('not_found', 'Agent not found');
    if (agent.status === 'suspended_billing')
      throw new AppError(
        'payment_required',
        'Agent is suspended: the subscription payment failed. Top up the wallet and start the agent again.',
      );
    if (agent.status === 'paused_budget')
      throw new AppError(
        'payment_required',
        'Agent is paused: its monthly budget is used up. Raise the budget or wait for next month.',
      );
    const month = this.usage.currentMonth();
    const usage = await this.usage.get(agent.id, month);

    const quota = this.config.plans[agent.plan as keyof AgentsConfig['plans']]?.monthlyTokens ?? 0;
    const platformOrg = this.config.platformOrgId;
    if (platformOrg && (usage?.platformTokens ?? 0) < quota) {
      return { agent, billingOrgId: platformOrg, billedTo: 'platform' };
    }

    // Beyond the included quota the customer pays: enforce the per-agent budget cap before the call.
    if (agent.budgetMonthlyMicros !== null && agent.budgetMonthlyMicros !== undefined) {
      const spent = usage?.customerCostMicros ?? 0;
      const budget = agent.budgetMonthlyMicros;
      if (spent >= budget) {
        await this.events.record(
          agent,
          'error',
          'budget_exhausted',
          `Monthly budget of ${formatUsd(budget)} reached (${formatUsd(spent)} spent); agent paused.`,
          { budget, spent, month },
        );
        await this.hooks.onBudgetExhausted?.(agent, spent);
        throw new AppError(
          'payment_required',
          `Agent monthly budget reached (${formatUsd(spent)} of ${formatUsd(budget)}). The agent is paused.`,
        );
      }
      if (spent >= budget * 0.8 && !usage?.budgetWarnedAt) {
        await this.events.record(
          agent,
          'warn',
          'budget_warning',
          `80% of the monthly budget used (${formatUsd(spent)} of ${formatUsd(budget)}).`,
          { budget, spent, month },
        );
        await this.usage.markBudgetWarned(agent.id, month);
      }
    }
    return { agent, billingOrgId: agent.orgId, billedTo: 'customer' };
  }

  private async record(agent: AgentRow, billedTo: BilledTo, u: Usage) {
    await this.usage.record(
      agent,
      {
        prompt: u.prompt_tokens,
        completion: u.completion_tokens,
        total: u.total_tokens || u.prompt_tokens + u.completion_tokens,
        costMicros: u.cost_micros ?? 0,
      },
      billedTo,
    );
  }

  /** Non-streaming call. The agent's configured model always wins over the request's. */
  async chat(
    agentId: string,
    req: ChatRequest,
    opts: { signal?: AbortSignal; conversationId?: string } = {},
  ): Promise<ChatResponse> {
    const { agent, billingOrgId, billedTo } = await this.prepare(agentId);
    const client = this.factory({ billingOrgId, agentId, conversationId: opts.conversationId });
    const res = await client.chat({ ...req, model: agent.model, models: undefined }, { signal: opts.signal });
    const text = typeof res.choices[0]?.message.content === 'string' ? res.choices[0].message.content : '';
    await this.record(
      agent,
      billedTo,
      res.usage ??
        estimateUsage(req, text.length + JSON.stringify(res.choices[0]?.message.tool_calls ?? '').length),
    );
    return res;
  }

  async *stream(
    agentId: string,
    req: ChatRequest,
    opts: { signal?: AbortSignal; conversationId?: string } = {},
  ): AsyncIterable<ChatChunk> {
    const { agent, billingOrgId, billedTo } = await this.prepare(agentId);
    const client = this.factory({ billingOrgId, agentId, conversationId: opts.conversationId });
    let usage: Usage | null = null;
    let chars = 0;
    try {
      for await (const chunk of client.stream(
        { ...req, model: agent.model, models: undefined },
        { signal: opts.signal },
      )) {
        if (chunk.usage) usage = chunk.usage;
        const d = chunk.choices?.[0]?.delta;
        chars +=
          (typeof d?.content === 'string' ? d.content.length : 0) +
          (d?.tool_calls ? JSON.stringify(d.tool_calls).length : 0);
        yield chunk;
      }
    } finally {
      await this.record(agent, billedTo, usage ?? estimateUsage(req, chars));
    }
  }

  /** An LlmClient bound to one agent (used by the inline driver). */
  clientFor(agentId: string, conversationId?: string): LlmClient {
    return {
      chat: (req, o) => this.chat(agentId, req, { signal: o?.signal, conversationId }),
      stream: (req, o) => this.stream(agentId, req, { signal: o?.signal, conversationId }),
    };
  }
}
