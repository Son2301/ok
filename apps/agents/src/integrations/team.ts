import { z } from 'zod';
import { defineIntegration, type ToolContext, toolBuilder } from './types';

const tool = toolBuilder<ToolContext<Record<string, never>, Record<string, never>>>();

const status = z.enum(['todo', 'in_progress', 'blocked', 'done']);
const priority = z.enum(['low', 'medium', 'high', 'urgent']);

/** AI-employee tools: the task board and reporting line. Rules are enforced in TaskService. */
export const teamIntegration = defineIntegration({
  id: 'team',
  name: 'Team & tasks',
  category: 'team',
  description:
    'Task board and org chart tools for AI employees: work on assigned tasks, delegate to direct reports, report to the manager.',
  verified: true,
  status: 'available',
  alwaysEnabled: true,
  authSchema: z.object({}),
  tools: [
    tool({
      name: 'list_my_tasks',
      description: 'List tasks assigned to you. Defaults to open tasks (todo, in_progress, blocked).',
      args: z.object({
        status: z.enum(['open', 'todo', 'in_progress', 'blocked', 'done', 'all']).default('open'),
      }),
      risk: 'read',
      handler: async (ctx, args) => ({
        tasks: await ctx.services.tasks.listForAgent(ctx.agent, args.status),
      }),
    }),
    tool({
      name: 'update_task',
      description:
        'Update the status or priority of a task assigned to you (or that you delegated). Optionally add a progress note.',
      args: z.object({
        taskId: z.string().min(1),
        status: status.optional(),
        priority: priority.optional(),
        note: z.string().max(4000).optional().describe('Progress note, stored as a comment'),
      }),
      risk: 'internal_write',
      handler: async (ctx, args) => ({
        task: await ctx.services.tasks.updateByAgent(ctx.agent, args.taskId, args),
      }),
    }),
    tool({
      name: 'comment_on_task',
      description:
        'Add a comment to a task you are involved in (assigned to you, created by you, or assigned to one of your direct reports).',
      args: z.object({ taskId: z.string().min(1), body: z.string().min(1).max(4000) }),
      risk: 'internal_write',
      handler: async (ctx, args) => ({
        comment: await ctx.services.tasks.commentByAgent(ctx.agent, args.taskId, args.body),
      }),
    }),
    tool({
      name: 'create_subtask',
      description: 'Break one of your tasks into a smaller subtask assigned to yourself.',
      args: z.object({
        parentTaskId: z.string().min(1),
        title: z.string().min(1).max(200),
        description: z.string().max(4000).optional(),
        priority: priority.optional(),
        dueAt: z.string().datetime({ offset: true }).optional(),
      }),
      risk: 'internal_write',
      handler: async (ctx, args) => ({
        task: await ctx.services.tasks.createSubtaskByAgent(ctx.agent, args),
      }),
    }),
    tool({
      name: 'delegate_task',
      description:
        'Assign work to one of your direct reports (only agents that report to you). Creates a task for them.',
      args: z.object({
        assigneeAgentId: z.string().min(1).describe('Agent id of a direct report'),
        title: z.string().min(1).max(200),
        description: z.string().max(4000).optional(),
        parentTaskId: z.string().optional().describe('Your task this work belongs to'),
        priority: priority.optional(),
        dueAt: z.string().datetime({ offset: true }).optional(),
      }),
      risk: 'internal_write',
      handler: async (ctx, args) => ({ task: await ctx.services.tasks.delegateByAgent(ctx.agent, args) }),
    }),
    tool({
      name: 'report_to_manager',
      description:
        'Send a written report to your manager (or to the business owner if you have no manager agent).',
      args: z.object({
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(8000),
        taskId: z.string().optional(),
      }),
      risk: 'internal_write',
      handler: async (ctx, args) => ({ report: await ctx.services.tasks.reportToManager(ctx.agent, args) }),
    }),
  ],
});
