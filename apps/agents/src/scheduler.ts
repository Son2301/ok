import type { DbHandle } from '@ok/db';
import type { Logger } from '@ok/shared';
import { eq } from 'drizzle-orm';
import type { AgentsConfig } from './config';
import { type AgentRow, agents } from './db/schema';
import { mapLimit } from './lib/async';
import { truncate } from './lib/text';
import { type Clock, describeLocalTime, localDay, localParts } from './lib/time';
import type { AgentService } from './services/agents';
import type { BillingService } from './services/billing';
import type { CompanyService } from './services/context';
import type { ConversationService } from './services/conversations';
import type { EventLog } from './services/events';
import type { TaskService } from './services/tasks';

export interface TickReport {
  skipped?: boolean;
  charged: { agentId: string; amountMicros: number }[];
  suspended: string[];
  resumed: string[];
  heartbeats: { agentId: string; ok: boolean; error?: string }[];
  summaries: string[];
}

/** Start of the local day containing `now`, as a UTC instant. */
export function startOfLocalDay(now: Date, tz: string): Date {
  const p = localParts(now, tz);
  return new Date(
    now.getTime() - ((p.hour * 60 + p.minute) * 60 + now.getUTCSeconds()) * 1000 - now.getUTCMilliseconds(),
  );
}

/**
 * Periodic background work, driven by an injectable clock (tests call
 * `tick()` directly; production uses `start()` → setInterval):
 *  1. daily prorated subscription charge for running agents (suspend on failure);
 *  2. resume agents paused for budget once they are under budget again;
 *  3. heartbeat: wake running agents that have open tasks;
 *  4. daily summary report per agent after the configured local hour.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly deps: {
      handle: DbHandle;
      agents: AgentService;
      billing: BillingService;
      conversations: ConversationService;
      tasks: TaskService;
      company: CompanyService;
      events: EventLog;
      config: AgentsConfig;
      clock: Clock;
      logger: Logger;
    },
  ) {}

  start(intervalMs = this.deps.config.scheduler.intervalMs): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) =>
        this.deps.logger.error('scheduler_tick_failed', { err: (err as Error).message }),
      );
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<TickReport> {
    const report: TickReport = { charged: [], suspended: [], resumed: [], heartbeats: [], summaries: [] };
    if (this.busy) return { ...report, skipped: true };
    this.busy = true;
    try {
      await this.runBilling(report);
      await this.resumeBudgetPaused(report);
      await this.runHeartbeats(report);
      await this.runDailySummaries(report);
    } finally {
      this.busy = false;
    }
    return report;
  }

  private async runBilling(report: TickReport) {
    for (const agent of await this.deps.billing.dueAgents()) {
      try {
        const res = await this.deps.billing.chargeDay(agent);
        if (res.status === 'charged')
          report.charged.push({ agentId: agent.id, amountMicros: res.amountMicros });
        else if (res.status === 'failed') {
          await this.deps.agents.suspendForBilling(
            agent,
            `Daily ${agent.plan} plan fee for ${res.day} could not be charged: insufficient wallet balance. Top up and start the agent again.`,
          );
          report.suspended.push(agent.id);
        }
      } catch (err) {
        this.deps.logger.error('billing_failed', { agentId: agent.id, err: (err as Error).message });
      }
    }
  }

  private async resumeBudgetPaused(report: TickReport) {
    for (const agent of await this.deps.agents.listByStatus(['paused_budget'])) {
      if (await this.deps.agents.resumeIfUnderBudget(agent)) report.resumed.push(agent.id);
    }
  }

  private async runHeartbeats(report: TickReport) {
    const now = this.deps.clock.now();
    const interval = this.deps.config.scheduler.heartbeatIntervalMs;
    const due: { agent: AgentRow; open: Awaited<ReturnType<TaskService['openTasksForAgent']>> }[] = [];
    for (const agent of await this.deps.agents.listByStatus(['running'])) {
      if (agent.lastHeartbeatAt && now.getTime() - agent.lastHeartbeatAt.getTime() < interval) continue;
      const open = (await this.deps.tasks.openTasksForAgent(agent)).filter((t) => t.status !== 'blocked');
      if (!open.length) continue;
      due.push({ agent, open });
    }
    await mapLimit(due, 3, async ({ agent, open }) => {
      // Claim the heartbeat first so a slow turn is not started twice.
      await this.deps.handle.db.update(agents).set({ lastHeartbeatAt: now }).where(eq(agents.id, agent.id));
      try {
        await this.deps.conversations.send({
          agent: { ...agent, lastHeartbeatAt: now },
          channel: 'internal',
          externalUserId: 'scheduler',
          text: this.heartbeatPrompt(agent, open, now),
        });
        report.heartbeats.push({ agentId: agent.id, ok: true });
      } catch (err) {
        const error = (err as Error).message;
        report.heartbeats.push({ agentId: agent.id, ok: false, error });
        await this.deps.events.record(agent, 'warn', 'heartbeat_failed', error.slice(0, 500));
      }
    });
  }

  heartbeatPrompt(
    agent: AgentRow,
    open: {
      id: string;
      title: string;
      description: string;
      status: string;
      priority: string;
      dueAt: Date | null;
    }[],
    now: Date,
  ): string {
    const tz = agent.settings?.timezone ?? this.deps.config.timezone;
    const lines = open
      .slice(0, 20)
      .map(
        (t) =>
          `- ${t.id} [${t.status}, ${t.priority}${t.dueAt ? `, due ${describeLocalTime(t.dueAt, tz)}` : ''}] ${t.title}${t.description ? `: ${truncate(t.description.replace(/\s+/g, ' '), 300)}` : ''}`,
      );
    return [
      `[Scheduled heartbeat — ${describeLocalTime(now, tz)}]`,
      `You have ${open.length} open task(s):`,
      ...lines,
      '',
      'Work on the most important task now: use your tools, update its status with update_task (add a short note), delegate to your direct reports when appropriate, and use report_to_manager when you finish a task or are blocked. If nothing can be done right now, reply briefly with why.',
    ].join('\n');
  }

  private async runDailySummaries(report: TickReport) {
    const now = this.deps.clock.now();
    const tz = this.deps.config.timezone;
    if (localParts(now, tz).hour < this.deps.config.scheduler.dailySummaryHour) return;
    const today = localDay(now, tz);
    const dayStart = startOfLocalDay(now, tz);
    const candidates = await this.deps.agents.listByStatus([
      'running',
      'stopped',
      'suspended_billing',
      'paused_budget',
      'error',
    ]);
    for (const agent of candidates) {
      if (agent.lastDailySummaryOn === today || !agent.deployedAt) continue;
      const stats = await this.dayStats(agent, dayStart);
      if (
        agent.status !== 'running' &&
        stats.userMessages === 0 &&
        stats.wakeups === 0 &&
        stats.toolCalls === 0
      )
        continue;
      const lang = (await this.deps.company.get(agent.orgId)).language;
      const open = await this.deps.tasks.openTasksForAgent(agent);
      await this.deps.tasks.createReport(agent, {
        kind: 'daily_summary',
        ...this.summaryText(lang, today, stats, open),
      });
      await this.deps.handle.db
        .update(agents)
        .set({ lastDailySummaryOn: today })
        .where(eq(agents.id, agent.id));
      report.summaries.push(agent.id);
    }
  }

  private async dayStats(agent: AgentRow, since: Date) {
    const [row] = await this.deps.handle.query<{
      conversations: number;
      user_messages: number;
      replies: number;
      wakeups: number;
      tokens: number;
      tool_calls: number;
      tool_errors: number;
      pending: number;
      done: number;
    }>(
      `WITH m AS (
         SELECT m.role, m.tool_calls, m.conversation_id, m.prompt_tokens, m.completion_tokens, c.channel
           FROM agents.messages m JOIN agents.conversations c ON c.id = m.conversation_id
          WHERE m.agent_id = $1 AND m.created_at >= $2
       )
       SELECT
         (SELECT count(DISTINCT conversation_id) FROM m WHERE role = 'user' AND channel <> 'internal')::int AS conversations,
         (SELECT count(*) FROM m WHERE role = 'user' AND channel <> 'internal')::int AS user_messages,
         (SELECT count(*) FROM m WHERE role = 'assistant' AND tool_calls IS NULL AND channel <> 'internal')::int AS replies,
         (SELECT count(*) FROM m WHERE role = 'user' AND channel = 'internal')::int AS wakeups,
         (SELECT coalesce(sum(coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0)), 0) FROM m)::int AS tokens,
         (SELECT count(*) FROM agents.tool_calls WHERE agent_id = $1 AND created_at >= $2)::int AS tool_calls,
         (SELECT count(*) FROM agents.tool_calls WHERE agent_id = $1 AND created_at >= $2 AND NOT ok)::int AS tool_errors,
         (SELECT count(*) FROM agents.approvals WHERE agent_id = $1 AND status IN ('pending', 'drafted'))::int AS pending,
         (SELECT count(*) FROM agents.tasks WHERE assignee_agent_id = $1 AND status = 'done' AND completed_at >= $2)::int AS done`,
      [agent.id, since.toISOString()],
    );
    return {
      conversations: Number(row?.conversations ?? 0),
      userMessages: Number(row?.user_messages ?? 0),
      replies: Number(row?.replies ?? 0),
      wakeups: Number(row?.wakeups ?? 0),
      tokens: Number(row?.tokens ?? 0),
      toolCalls: Number(row?.tool_calls ?? 0),
      toolErrors: Number(row?.tool_errors ?? 0),
      pendingApprovals: Number(row?.pending ?? 0),
      tasksDone: Number(row?.done ?? 0),
    };
  }

  private summaryText(
    lang: 'vi' | 'en',
    day: string,
    s: Awaited<ReturnType<Scheduler['dayStats']>>,
    open: { title: string; status: string }[],
  ) {
    const openList = open.slice(0, 10).map((t) => `- ${t.title} (${t.status})`);
    if (lang === 'vi') {
      return {
        title: `Báo cáo cuối ngày ${day}`,
        body: [
          `Hội thoại với khách: ${s.conversations} (tin nhắn khách: ${s.userMessages}, trả lời: ${s.replies})`,
          `Lần tự làm việc theo lịch: ${s.wakeups}`,
          `Lượt dùng công cụ: ${s.toolCalls} (lỗi: ${s.toolErrors})`,
          `Việc hoàn thành hôm nay: ${s.tasksDone}`,
          `Đang chờ chủ duyệt: ${s.pendingApprovals}`,
          `Token đã dùng: ${s.tokens.toLocaleString('vi-VN')}`,
          `Việc đang mở: ${open.length}${openList.length ? `\n${openList.join('\n')}` : ''}`,
        ].join('\n'),
      };
    }
    return {
      title: `Daily summary ${day}`,
      body: [
        `Customer conversations: ${s.conversations} (customer messages: ${s.userMessages}, replies: ${s.replies})`,
        `Scheduled work sessions: ${s.wakeups}`,
        `Tool calls: ${s.toolCalls} (failed: ${s.toolErrors})`,
        `Tasks completed today: ${s.tasksDone}`,
        `Awaiting owner approval: ${s.pendingApprovals}`,
        `Tokens used: ${s.tokens.toLocaleString('en-US')}`,
        `Open tasks: ${open.length}${openList.length ? `\n${openList.join('\n')}` : ''}`,
      ].join('\n'),
    };
  }
}
