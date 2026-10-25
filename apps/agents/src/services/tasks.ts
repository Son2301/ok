import type { Db } from '@ok/db';
import { AppError, newId } from '@ok/shared';
import { and, asc, desc, eq, gte, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import {
  type AgentRow,
  agents,
  type ReportKind,
  type ReportRow,
  reports,
  type TaskPriority,
  type TaskRow,
  type TaskStatus,
  taskComments,
  tasks,
} from '../db/schema';
import type { Clock } from '../lib/time';

export const OPEN_STATUSES: TaskStatus[] = ['todo', 'in_progress', 'blocked'];
const PRIORITY_ORDER = sql`CASE ${tasks.priority} WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

export interface TaskInput {
  title: string;
  description?: string;
  assigneeAgentId?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueAt?: string | null;
  parentTaskId?: string | null;
}

export type Actor = { type: 'user'; id: string | null } | { type: 'agent'; id: string };

export function serializeTask(t: TaskRow) {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    assigneeAgentId: t.assigneeAgentId,
    createdBy: { type: t.createdByType, id: t.createdById },
    status: t.status,
    priority: t.priority,
    dueAt: t.dueAt?.toISOString() ?? null,
    parentTaskId: t.parentTaskId,
    completedAt: t.completedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function serializeReport(r: ReportRow) {
  return {
    id: r.id,
    agentId: r.agentId,
    managerAgentId: r.managerAgentId,
    kind: r.kind,
    title: r.title,
    body: r.body,
    taskId: r.taskId,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Task board, comments and reports for AI employees. Owner operations are
 * unrestricted within the org; agent operations enforce the org chart:
 * agents work on their own tasks, delegate only to direct reports, and
 * report to their manager (or the human owner).
 */
export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
  ) {}

  private async agentInOrg(orgId: string, agentId: string): Promise<AgentRow> {
    const [a] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
    if (!a) throw new AppError('bad_request', `Agent ${agentId} not found in this organization`);
    return a;
  }

  private async taskInOrg(orgId: string, taskId: string): Promise<TaskRow> {
    const [t] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.orgId, orgId)));
    if (!t) throw new AppError('not_found', `Task ${taskId} not found`);
    return t;
  }

  directReports(agent: { id: string; orgId: string }): Promise<AgentRow[]> {
    return this.db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, agent.orgId), eq(agents.reportsTo, agent.id)))
      .orderBy(asc(agents.name));
  }

  // ------------------------------------------------------------- owner API

  async create(orgId: string, input: TaskInput, by: Actor): Promise<TaskRow> {
    if (input.assigneeAgentId) await this.agentInOrg(orgId, input.assigneeAgentId);
    if (input.parentTaskId) await this.taskInOrg(orgId, input.parentTaskId);
    const now = this.clock.now();
    const status = input.status ?? 'todo';
    const [row] = await this.db
      .insert(tasks)
      .values({
        id: newId('tsk'),
        orgId,
        title: input.title,
        description: input.description ?? '',
        assigneeAgentId: input.assigneeAgentId ?? null,
        createdByType: by.type,
        createdById: by.id,
        status,
        priority: input.priority ?? 'medium',
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        parentTaskId: input.parentTaskId ?? null,
        completedAt: status === 'done' ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row!;
  }

  list(
    orgId: string,
    filter: {
      assigneeAgentId?: string;
      status?: TaskStatus | 'open';
      parentTaskId?: string;
      limit?: number;
    } = {},
  ) {
    const conds: SQL[] = [eq(tasks.orgId, orgId)];
    if (filter.assigneeAgentId) conds.push(eq(tasks.assigneeAgentId, filter.assigneeAgentId));
    if (filter.status === 'open') conds.push(inArray(tasks.status, OPEN_STATUSES));
    else if (filter.status) conds.push(eq(tasks.status, filter.status));
    if (filter.parentTaskId) conds.push(eq(tasks.parentTaskId, filter.parentTaskId));
    return this.db
      .select()
      .from(tasks)
      .where(and(...conds))
      .orderBy(desc(tasks.createdAt))
      .limit(Math.min(filter.limit ?? 100, 500));
  }

  async get(orgId: string, taskId: string) {
    const task = await this.taskInOrg(orgId, taskId);
    const comments = await this.db
      .select()
      .from(taskComments)
      .where(eq(taskComments.taskId, taskId))
      .orderBy(asc(taskComments.createdAt));
    const subtasks = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.parentTaskId, taskId))
      .orderBy(asc(tasks.createdAt));
    return {
      ...serializeTask(task),
      comments: comments.map((c) => ({
        id: c.id,
        author: { type: c.authorType, id: c.authorId },
        body: c.body,
        createdAt: c.createdAt.toISOString(),
      })),
      subtasks: subtasks.map(serializeTask),
    };
  }

  async update(orgId: string, taskId: string, patch: Partial<TaskInput>): Promise<TaskRow> {
    const task = await this.taskInOrg(orgId, taskId);
    if (patch.assigneeAgentId) await this.agentInOrg(orgId, patch.assigneeAgentId);
    if (patch.parentTaskId) {
      if (patch.parentTaskId === taskId) throw new AppError('bad_request', 'A task cannot be its own parent');
      await this.taskInOrg(orgId, patch.parentTaskId);
    }
    const now = this.clock.now();
    const set: Partial<typeof tasks.$inferInsert> = { updatedAt: now };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.assigneeAgentId !== undefined) set.assigneeAgentId = patch.assigneeAgentId;
    if (patch.priority !== undefined) set.priority = patch.priority;
    if (patch.dueAt !== undefined) set.dueAt = patch.dueAt ? new Date(patch.dueAt) : null;
    if (patch.parentTaskId !== undefined) set.parentTaskId = patch.parentTaskId;
    if (patch.status !== undefined && patch.status !== task.status) {
      set.status = patch.status;
      set.completedAt = patch.status === 'done' ? now : null;
    }
    const [row] = await this.db.update(tasks).set(set).where(eq(tasks.id, taskId)).returning();
    return row!;
  }

  async delete(orgId: string, taskId: string) {
    await this.taskInOrg(orgId, taskId);
    await this.db.delete(tasks).where(eq(tasks.id, taskId));
  }

  async addComment(orgId: string, taskId: string, author: Actor, body: string) {
    await this.taskInOrg(orgId, taskId);
    const [row] = await this.db
      .insert(taskComments)
      .values({
        id: newId('tcm'),
        taskId,
        orgId,
        authorType: author.type,
        authorId: author.id,
        body,
        createdAt: this.clock.now(),
      })
      .returning();
    await this.db.update(tasks).set({ updatedAt: this.clock.now() }).where(eq(tasks.id, taskId));
    return {
      id: row!.id,
      taskId,
      author: { type: row!.authorType, id: row!.authorId },
      body: row!.body,
      createdAt: row!.createdAt.toISOString(),
    };
  }

  listReports(
    orgId: string,
    filter: { agentId?: string; managerAgentId?: string | null; kind?: ReportKind; limit?: number } = {},
  ) {
    const conds: SQL[] = [eq(reports.orgId, orgId)];
    if (filter.agentId) conds.push(eq(reports.agentId, filter.agentId));
    if (filter.managerAgentId === null) conds.push(isNull(reports.managerAgentId));
    else if (filter.managerAgentId) conds.push(eq(reports.managerAgentId, filter.managerAgentId));
    if (filter.kind) conds.push(eq(reports.kind, filter.kind));
    return this.db
      .select()
      .from(reports)
      .where(and(...conds))
      .orderBy(desc(reports.createdAt))
      .limit(Math.min(filter.limit ?? 50, 500));
  }

  // ------------------------------------------------------------- agent API (rules enforced)

  async listForAgent(agent: AgentRow, status: 'open' | TaskStatus | 'all' = 'open') {
    const conds: SQL[] = [eq(tasks.orgId, agent.orgId), eq(tasks.assigneeAgentId, agent.id)];
    if (status === 'open') conds.push(inArray(tasks.status, OPEN_STATUSES));
    else if (status !== 'all') conds.push(eq(tasks.status, status));
    const rows = await this.db
      .select()
      .from(tasks)
      .where(and(...conds))
      .orderBy(PRIORITY_ORDER, asc(tasks.createdAt))
      .limit(50);
    return rows.map(serializeTask);
  }

  openTasksForAgent(agent: { id: string; orgId: string }) {
    return this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.orgId, agent.orgId),
          eq(tasks.assigneeAgentId, agent.id),
          inArray(tasks.status, OPEN_STATUSES),
        ),
      )
      .orderBy(PRIORITY_ORDER, asc(tasks.createdAt));
  }

  private async canAccess(agent: AgentRow, task: TaskRow): Promise<boolean> {
    if (task.assigneeAgentId === agent.id) return true;
    if (task.createdByType === 'agent' && task.createdById === agent.id) return true;
    if (task.assigneeAgentId) {
      const [assignee] = await this.db
        .select({ reportsTo: agents.reportsTo })
        .from(agents)
        .where(eq(agents.id, task.assigneeAgentId));
      if (assignee?.reportsTo === agent.id) return true;
    }
    return false;
  }

  async updateByAgent(
    agent: AgentRow,
    taskId: string,
    patch: { status?: TaskStatus; priority?: TaskPriority; note?: string },
  ) {
    const task = await this.taskInOrg(agent.orgId, taskId);
    const isAssignee = task.assigneeAgentId === agent.id;
    const isCreator = task.createdByType === 'agent' && task.createdById === agent.id;
    if (!isAssignee && !isCreator)
      throw new AppError('forbidden', 'You can only update tasks assigned to you or that you delegated');
    const updated = await this.update(agent.orgId, taskId, {
      status: patch.status,
      priority: patch.priority,
    });
    if (patch.note) await this.addComment(agent.orgId, taskId, { type: 'agent', id: agent.id }, patch.note);
    return serializeTask(updated);
  }

  async commentByAgent(agent: AgentRow, taskId: string, body: string) {
    const task = await this.taskInOrg(agent.orgId, taskId);
    if (!(await this.canAccess(agent, task)))
      throw new AppError(
        'forbidden',
        'You can only comment on your tasks, tasks you delegated, or tasks of your direct reports',
      );
    return this.addComment(agent.orgId, taskId, { type: 'agent', id: agent.id }, body);
  }

  async createSubtaskByAgent(
    agent: AgentRow,
    input: {
      parentTaskId: string;
      title: string;
      description?: string;
      priority?: TaskPriority;
      dueAt?: string;
    },
  ) {
    const parent = await this.taskInOrg(agent.orgId, input.parentTaskId);
    if (parent.assigneeAgentId !== agent.id)
      throw new AppError('forbidden', 'You can only create subtasks under tasks assigned to you');
    const row = await this.create(
      agent.orgId,
      {
        title: input.title,
        description: input.description,
        priority: input.priority ?? parent.priority,
        dueAt: input.dueAt,
        parentTaskId: parent.id,
        assigneeAgentId: agent.id,
      },
      { type: 'agent', id: agent.id },
    );
    return serializeTask(row);
  }

  async delegateByAgent(
    agent: AgentRow,
    input: {
      assigneeAgentId: string;
      title: string;
      description?: string;
      parentTaskId?: string;
      priority?: TaskPriority;
      dueAt?: string;
    },
  ) {
    const reportsList = await this.directReports(agent);
    const assignee = reportsList.find((r) => r.id === input.assigneeAgentId);
    if (!assignee) {
      const names = reportsList.map((r) => `${r.name} (${r.id})`).join(', ');
      throw new AppError(
        'forbidden',
        reportsList.length
          ? `You can only delegate to your direct reports: ${names}`
          : 'You have no direct reports, so you cannot delegate. Ask your manager or the owner instead.',
      );
    }
    if (input.parentTaskId) {
      const parent = await this.taskInOrg(agent.orgId, input.parentTaskId);
      if (parent.assigneeAgentId !== agent.id)
        throw new AppError('forbidden', 'The parent task must be one of your tasks');
    }
    const row = await this.create(
      agent.orgId,
      {
        title: input.title,
        description: input.description,
        priority: input.priority,
        dueAt: input.dueAt,
        parentTaskId: input.parentTaskId ?? null,
        assigneeAgentId: assignee.id,
      },
      { type: 'agent', id: agent.id },
    );
    return serializeTask(row);
  }

  async createReport(
    agent: AgentRow,
    input: { kind: ReportKind; title: string; body: string; taskId?: string | null },
  ) {
    if (input.taskId) await this.taskInOrg(agent.orgId, input.taskId);
    const [row] = await this.db
      .insert(reports)
      .values({
        id: newId('rpt'),
        orgId: agent.orgId,
        agentId: agent.id,
        managerAgentId: agent.reportsTo,
        kind: input.kind,
        title: input.title,
        body: input.body,
        taskId: input.taskId ?? null,
        createdAt: this.clock.now(),
      })
      .returning();
    return row!;
  }

  async reportToManager(agent: AgentRow, input: { title: string; body: string; taskId?: string }) {
    const row = await this.createReport(agent, { kind: 'report', ...input });
    return {
      ...serializeReport(row),
      deliveredTo: agent.reportsTo ? { type: 'agent', id: agent.reportsTo } : { type: 'owner' },
    };
  }

  /** Recent reports addressed to `manager` by its direct reports (shown in the manager's context). */
  recentReportsFor(manager: { id: string; orgId: string }, since: Date, limit = 10) {
    return this.db
      .select({ report: reports, agentName: agents.name })
      .from(reports)
      .innerJoin(agents, eq(agents.id, reports.agentId))
      .where(
        and(
          eq(reports.orgId, manager.orgId),
          eq(reports.managerAgentId, manager.id),
          gte(reports.createdAt, since),
        ),
      )
      .orderBy(desc(reports.createdAt))
      .limit(limit);
  }
}
