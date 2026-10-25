import type { Db } from '@ok/db';
import { AppError, newId } from '@ok/shared';
import { and, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { type ApprovalRow, type ApprovalStatus, agents, approvals, messages } from '../db/schema';
import { truncate } from '../lib/text';
import type { Clock } from '../lib/time';
import type { EventLog } from './events';
import type { ToolService } from './tools';

export function serializeApproval(a: ApprovalRow) {
  return {
    id: a.id,
    agentId: a.agentId,
    conversationId: a.conversationId,
    tool: a.tool,
    integrationId: a.integrationId,
    arguments: a.arguments,
    mode: a.mode,
    status: a.status,
    result: a.result ?? null,
    error: a.error,
    decidedBy: a.decidedBy,
    decisionNote: a.decisionNote,
    decidedAt: a.decidedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

/**
 * Human-in-the-loop for risky tool calls. `approve`-level calls arrive as
 * `pending`, `draft`-level calls as `drafted`; the owner approves (the tool
 * then runs with the stored arguments) or rejects. The outcome is noted in the
 * conversation so the agent knows on its next turn.
 */
export class ApprovalService {
  constructor(
    private readonly db: Db,
    private readonly tools: ToolService,
    private readonly events: EventLog,
    private readonly clock: Clock,
  ) {}

  list(orgId: string, filter: { status?: ApprovalStatus | 'open'; agentId?: string; limit?: number } = {}) {
    const conds: SQL[] = [eq(approvals.orgId, orgId)];
    if (filter.status === 'open') conds.push(inArray(approvals.status, ['pending', 'drafted']));
    else if (filter.status) conds.push(eq(approvals.status, filter.status));
    if (filter.agentId) conds.push(eq(approvals.agentId, filter.agentId));
    return this.db
      .select()
      .from(approvals)
      .where(and(...conds))
      .orderBy(desc(approvals.createdAt))
      .limit(Math.min(filter.limit ?? 50, 200));
  }

  async get(orgId: string, id: string): Promise<ApprovalRow> {
    const [row] = await this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.orgId, orgId), eq(approvals.id, id)));
    if (!row) throw new AppError('not_found', 'Approval not found');
    return row;
  }

  /** Atomically take the decision (first decider wins). */
  private async claim(
    orgId: string,
    id: string,
    decidedBy: string,
    note: string | undefined,
  ): Promise<ApprovalRow> {
    const current = await this.get(orgId, id);
    if (current.status !== 'pending' && current.status !== 'drafted')
      throw new AppError('conflict', `Approval is already ${current.status}`);
    const [row] = await this.db
      .update(approvals)
      .set({ decidedAt: this.clock.now(), decidedBy, decisionNote: note ?? null })
      .where(
        and(
          eq(approvals.id, id),
          isNull(approvals.decidedAt),
          inArray(approvals.status, ['pending', 'drafted']),
        ),
      )
      .returning();
    if (!row) throw new AppError('conflict', 'Approval was already decided');
    return row;
  }

  private async note(a: ApprovalRow, text: string) {
    if (!a.conversationId) return;
    await this.db.insert(messages).values({
      id: newId('msg'),
      conversationId: a.conversationId,
      agentId: a.agentId,
      orgId: a.orgId,
      role: 'system',
      content: text,
      createdAt: this.clock.now(),
    });
  }

  async approve(orgId: string, id: string, by: { decidedBy: string; note?: string }) {
    const claimed = await this.claim(orgId, id, by.decidedBy, by.note);
    const [agent] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, claimed.agentId), eq(agents.orgId, orgId)));
    if (!agent) throw new AppError('not_found', 'Agent no longer exists');
    const outcome = await this.tools.execute(agent, claimed.tool, claimed.arguments, {
      conversationId: claimed.conversationId,
      toolCallId: claimed.toolCallId,
      source: 'approval',
      bypassTrust: true,
    });
    const status: ApprovalStatus = outcome.ok ? 'executed' : 'failed';
    const [row] = await this.db
      .update(approvals)
      .set({ status, result: outcome.ok ? (outcome.result ?? null) : null, error: outcome.error ?? null })
      .where(eq(approvals.id, id))
      .returning();
    await this.note(
      row!,
      outcome.ok
        ? `[Owner approved ${claimed.tool} (${id}); it was executed. Result: ${truncate(JSON.stringify(outcome.result ?? null), 500)}]`
        : `[Owner approved ${claimed.tool} (${id}) but it failed: ${outcome.error}]`,
    );
    await this.events.record(
      agent,
      outcome.ok ? 'info' : 'warn',
      'approval_executed',
      `${claimed.tool} approved by ${by.decidedBy}: ${status}`,
      { approvalId: id },
    );
    return row!;
  }

  async reject(orgId: string, id: string, by: { decidedBy: string; note?: string }) {
    await this.claim(orgId, id, by.decidedBy, by.note);
    const [row] = await this.db
      .update(approvals)
      .set({ status: 'rejected' })
      .where(eq(approvals.id, id))
      .returning();
    await this.note(
      row!,
      `[Owner rejected ${row!.tool} (${id})${by.note ? `: ${by.note}` : ''}. Do not retry it; tell the user if relevant.]`,
    );
    return row!;
  }
}
