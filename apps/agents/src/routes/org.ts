import { type AuthContext, type AuthEnv, getAuth } from '@ok/core';
import { AppError, parseJson } from '@ok/shared';
import { Hono } from 'hono';
import type { PlanId } from '../config';
import type { ApprovalStatus, ReportKind, TaskStatus } from '../db/schema';
import type { Platform } from '../platform';
import { serializeApproval } from '../services/approvals';
import { serializeReport, serializeTask } from '../services/tasks';
import { readUpload } from './agents';
import { commentSchema, companySchema, createTaskSchema, decisionSchema, updateTaskSchema } from './schemas';

const decidedBy = (auth: AuthContext) =>
  auth.via === 'api_key' && auth.apiKey ? `api_key:${auth.apiKey.id}` : 'console';
const actorOf = (auth: AuthContext) => ({
  type: 'user' as const,
  id: auth.via === 'api_key' && auth.apiKey ? `api_key:${auth.apiKey.id}` : 'console',
});

const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'open'];
const APPROVAL_STATUSES = ['pending', 'drafted', 'executed', 'failed', 'rejected', 'open'];

export function orgRoutes(p: Platform) {
  const r = new Hono<AuthEnv>();

  // ------------------------------------------------------------- catalog & plans
  r.get('/integrations', (c) => c.json({ data: p.catalog.list() }));
  r.get('/integrations/:id', (c) => {
    const i = p.catalog.get(c.req.param('id'));
    if (!i) throw new AppError('not_found', 'Integration not found');
    return c.json(p.catalog.describe(i));
  });
  r.get('/plans', (c) =>
    c.json({
      data: Object.values(p.config.plans).map((plan) => ({
        id: plan.id,
        name: plan.name,
        monthlyPriceMicros: plan.monthlyPriceMicros,
        dailyPriceMicros: p.billing.dailyAmount(plan.id as PlanId),
        includedTokensPerMonth: plan.monthlyTokens,
        limits: { cpus: plan.cpus, memoryMb: plan.memoryMb },
      })),
    }),
  );

  // ------------------------------------------------------------- company profile
  r.get('/company', async (c) => c.json(await p.company.get(getAuth(c).orgId)));
  r.put('/company', async (c) => {
    const body = await parseJson(c, companySchema);
    return c.json(await p.company.update(getAuth(c).orgId, body));
  });

  // ------------------------------------------------------------- org-wide knowledge
  r.get('/knowledge', async (c) => c.json({ data: await p.knowledge.list(getAuth(c).orgId, null) }));
  r.post('/knowledge', async (c) => {
    const upload = await readUpload(c);
    return c.json(await p.knowledge.addDocument({ orgId: getAuth(c).orgId, agentId: null, ...upload }), 201);
  });
  r.get('/knowledge/:docId', async (c) =>
    c.json(await p.knowledge.getDocument(getAuth(c).orgId, c.req.param('docId'))),
  );
  r.delete('/knowledge/:docId', async (c) => {
    await p.knowledge.delete(getAuth(c).orgId, c.req.param('docId'), null);
    return c.body(null, 204);
  });

  // ------------------------------------------------------------- tasks
  r.get('/tasks', async (c) => {
    const status = c.req.query('status');
    if (status && !TASK_STATUSES.includes(status))
      throw new AppError('bad_request', `status must be one of ${TASK_STATUSES.join(', ')}`);
    const rows = await p.tasks.list(getAuth(c).orgId, {
      assigneeAgentId: c.req.query('assigneeAgentId'),
      status: status as TaskStatus | 'open' | undefined,
      parentTaskId: c.req.query('parentTaskId'),
      limit: Number(c.req.query('limit') ?? 100) || 100,
    });
    return c.json({ data: rows.map(serializeTask) });
  });
  r.post('/tasks', async (c) => {
    const body = await parseJson(c, createTaskSchema);
    const auth = getAuth(c);
    return c.json(serializeTask(await p.tasks.create(auth.orgId, body, actorOf(auth))), 201);
  });
  r.get('/tasks/:id', async (c) => c.json(await p.tasks.get(getAuth(c).orgId, c.req.param('id'))));
  r.patch('/tasks/:id', async (c) => {
    const body = await parseJson(c, updateTaskSchema);
    return c.json(serializeTask(await p.tasks.update(getAuth(c).orgId, c.req.param('id'), body)));
  });
  r.delete('/tasks/:id', async (c) => {
    await p.tasks.delete(getAuth(c).orgId, c.req.param('id'));
    return c.body(null, 204);
  });
  r.post('/tasks/:id/comments', async (c) => {
    const body = await parseJson(c, commentSchema);
    const auth = getAuth(c);
    return c.json(await p.tasks.addComment(auth.orgId, c.req.param('id'), actorOf(auth), body.body), 201);
  });

  // ------------------------------------------------------------- reports & org chart
  r.get('/reports', async (c) => {
    const kind = c.req.query('kind');
    if (kind && kind !== 'report' && kind !== 'daily_summary')
      throw new AppError('bad_request', 'kind must be report or daily_summary');
    const rows = await p.tasks.listReports(getAuth(c).orgId, {
      agentId: c.req.query('agentId'),
      managerAgentId: c.req.query('managerAgentId') === 'owner' ? null : c.req.query('managerAgentId'),
      kind: kind as ReportKind | undefined,
      limit: Number(c.req.query('limit') ?? 50) || 50,
    });
    return c.json({ data: rows.map(serializeReport) });
  });
  r.get('/org-chart', async (c) => c.json({ data: await p.agents.orgChart(getAuth(c).orgId) }));

  // ------------------------------------------------------------- approvals
  r.get('/approvals', async (c) => {
    const status = c.req.query('status');
    if (status && !APPROVAL_STATUSES.includes(status))
      throw new AppError('bad_request', `status must be one of ${APPROVAL_STATUSES.join(', ')}`);
    const rows = await p.approvals.list(getAuth(c).orgId, {
      status: status as ApprovalStatus | 'open' | undefined,
      agentId: c.req.query('agentId'),
      limit: Number(c.req.query('limit') ?? 50) || 50,
    });
    return c.json({ data: rows.map(serializeApproval) });
  });
  r.get('/approvals/:id', async (c) =>
    c.json(serializeApproval(await p.approvals.get(getAuth(c).orgId, c.req.param('id')))),
  );
  r.post('/approvals/:id/approve', async (c) => {
    const body = await parseJson(c, decisionSchema).catch(() => ({ note: undefined }));
    const auth = getAuth(c);
    return c.json(
      serializeApproval(
        await p.approvals.approve(auth.orgId, c.req.param('id'), {
          decidedBy: decidedBy(auth),
          note: body.note,
        }),
      ),
    );
  });
  r.post('/approvals/:id/reject', async (c) => {
    const body = await parseJson(c, decisionSchema).catch(() => ({ note: undefined }));
    const auth = getAuth(c);
    return c.json(
      serializeApproval(
        await p.approvals.reject(auth.orgId, c.req.param('id'), {
          decidedBy: decidedBy(auth),
          note: body.note,
        }),
      ),
    );
  });

  // ------------------------------------------------------------- usage & billing
  r.get('/usage', async (c) => {
    const orgId = getAuth(c).orgId;
    const month = c.req.query('month') ?? p.usage.currentMonth();
    if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError('bad_request', 'month must be YYYY-MM');
    const [rows, agentRows] = await Promise.all([p.usage.listForOrg(orgId, month), p.agents.list(orgId)]);
    const byAgent = new Map(rows.map((u) => [u.agentId, u]));
    return c.json({
      month,
      data: agentRows.map((a) => {
        const u = byAgent.get(a.id);
        const included = p.config.plans[a.plan as PlanId].monthlyTokens;
        return {
          agentId: a.id,
          name: a.name,
          plan: a.plan,
          includedTokens: included,
          requests: u?.requests ?? 0,
          totalTokens: u?.totalTokens ?? 0,
          platformTokens: u?.platformTokens ?? 0,
          customerTokens: u?.customerTokens ?? 0,
          customerCostMicros: u?.customerCostMicros ?? 0,
          remainingIncludedTokens: Math.max(0, included - (u?.platformTokens ?? 0)),
          budgetMonthlyMicros: a.budgetMonthlyMicros,
        };
      }),
    });
  });
  r.get('/billing/charges', async (c) => {
    const rows = await p.billing.listCharges(getAuth(c).orgId, {
      agentId: c.req.query('agentId'),
      limit: Number(c.req.query('limit') ?? 100) || 100,
    });
    return c.json({ data: rows.map((b) => ({ ...b, createdAt: b.createdAt.toISOString() })) });
  });

  return r;
}
