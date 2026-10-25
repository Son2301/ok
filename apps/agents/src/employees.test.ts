import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRow } from './db/schema';
import { createTestPlatform, type TestPlatform } from './test/helpers';

let t: TestPlatform;
let manager: AgentRow;
let report: AgentRow;
let peer: AgentRow;
let outsider: AgentRow;

const exec = (agent: AgentRow, tool: string, args: unknown) =>
  t.platform.tools.execute(agent, tool, args, { source: 'inline' });

beforeAll(async () => {
  t = await createTestPlatform();
  const m = await t.createAgent({ name: 'Quản lý Hà', role: 'Store manager' });
  const r = await t.createAgent({ name: 'Nhân viên Bình', role: 'Sales', reportsTo: m.id });
  const p = await t.createAgent({ name: 'Nhân viên Chi', role: 'Kho', reportsTo: m.id });
  const o = await t.createAgent({ name: 'Độc lập', role: 'Marketing' });
  const rows = await Promise.all([m, r, p, o].map((a) => t.platform.agents.get(t.org.id, a.id)));
  [manager, report, peer, outsider] = rows as [AgentRow, AgentRow, AgentRow, AgentRow];
});
afterAll(() => t.close());

describe('task board API', () => {
  it('creates, filters, updates and comments on tasks', async () => {
    const created = await t.request('POST', '/v1/tasks', {
      title: 'Chuẩn bị khuyến mãi 11/11',
      assigneeAgentId: manager.id,
      priority: 'high',
      dueAt: '2026-11-10T17:00:00+07:00',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'todo',
      priority: 'high',
      assigneeAgentId: manager.id,
      createdBy: { type: 'user' },
    });
    const listed = await t.request('GET', `/v1/tasks?assigneeAgentId=${manager.id}&status=open`);
    expect(listed.body.data.map((x: { id: string }) => x.id)).toContain(created.body.id);
    const done = await t.request('PATCH', `/v1/tasks/${created.body.id}`, { status: 'done' });
    expect(done.body.completedAt).not.toBeNull();
    await t.request('POST', `/v1/tasks/${created.body.id}/comments`, { body: 'Tốt lắm' });
    const detail = await t.request('GET', `/v1/tasks/${created.body.id}`);
    expect(detail.body.comments).toEqual([
      expect.objectContaining({ body: 'Tốt lắm', author: expect.objectContaining({ type: 'user' }) }),
    ]);
    expect((await t.request('POST', '/v1/tasks', { title: 'x', assigneeAgentId: 'agt_nope' })).status).toBe(
      400,
    );
    expect((await t.request('GET', '/v1/tasks?status=weird')).status).toBe(400);
  });
});

describe('agent task tools enforce the org chart', () => {
  it('delegates only to direct reports', async () => {
    const parent = await t.platform.tasks.create(
      t.org.id,
      { title: 'Chiến dịch 11/11', assigneeAgentId: manager.id },
      { type: 'user', id: null },
    );

    const ok = await exec(manager, 'delegate_task', {
      assigneeAgentId: report.id,
      title: 'Soạn tin nhắn khuyến mãi',
      parentTaskId: parent.id,
      priority: 'high',
    });
    expect(ok).toMatchObject({ ok: true, outcome: 'executed' });
    const delegated = (
      ok.result as { task: { id: string; assigneeAgentId: string; parentTaskId: string; createdBy: unknown } }
    ).task;
    expect(delegated).toMatchObject({
      assigneeAgentId: report.id,
      parentTaskId: parent.id,
      createdBy: { type: 'agent', id: manager.id },
    });

    // Not a direct report.
    const toOutsider = await exec(manager, 'delegate_task', { assigneeAgentId: outsider.id, title: 'x' });
    expect(toOutsider).toMatchObject({ ok: false, outcome: 'error' });
    expect(toOutsider.error).toMatch(/only delegate to your direct reports: .*Nhân viên Bình/);
    // Upwards (to the manager) is not allowed either.
    const upwards = await exec(report, 'delegate_task', {
      assigneeAgentId: manager.id,
      title: 'Làm giúp em',
    });
    expect(upwards.error).toMatch(/no direct reports/);
    // Sideways to a peer is not allowed.
    expect((await exec(report, 'delegate_task', { assigneeAgentId: peer.id, title: 'x' })).ok).toBe(false);
    // Parent must be one of the delegator's tasks.
    const foreign = await t.platform.tasks.create(
      t.org.id,
      { title: 'Việc của Chi', assigneeAgentId: peer.id },
      { type: 'user', id: null },
    );
    expect(
      (
        await exec(manager, 'delegate_task', {
          assigneeAgentId: report.id,
          title: 'x',
          parentTaskId: foreign.id,
        })
      ).error,
    ).toMatch(/parent task must be one of your tasks/);

    // The report sees it, works on it and comments; the manager may comment too.
    const mine = await exec(report, 'list_my_tasks', {});
    expect((mine.result as { tasks: { id: string }[] }).tasks.map((x) => x.id)).toEqual([delegated.id]);
    expect(
      (await exec(report, 'update_task', { taskId: delegated.id, status: 'in_progress', note: 'Đang soạn' }))
        .ok,
    ).toBe(true);
    expect(
      (await exec(manager, 'comment_on_task', { taskId: delegated.id, body: 'Nhớ thêm mã giảm giá' })).ok,
    ).toBe(true);
    // Unrelated agents cannot touch it.
    expect((await exec(outsider, 'update_task', { taskId: delegated.id, status: 'done' })).error).toMatch(
      /only update tasks assigned to you/,
    );
    expect((await exec(peer, 'comment_on_task', { taskId: delegated.id, body: 'hi' })).ok).toBe(false);
    // Subtasks only under one's own tasks.
    expect((await exec(report, 'create_subtask', { parentTaskId: delegated.id, title: 'Chọn ảnh' })).ok).toBe(
      true,
    );
    expect((await exec(outsider, 'create_subtask', { parentTaskId: delegated.id, title: 'x' })).ok).toBe(
      false,
    );

    const full = await t.request('GET', `/v1/tasks/${delegated.id}`);
    expect(full.body.status).toBe('in_progress');
    expect(full.body.comments.map((c: { body: string }) => c.body)).toEqual([
      'Đang soạn',
      'Nhớ thêm mã giảm giá',
    ]);
    expect(full.body.subtasks).toHaveLength(1);
  });

  it('routes reports to the manager (visible in its context) and to the owner', async () => {
    const res = await exec(report, 'report_to_manager', {
      title: 'Đã xong tin nhắn khuyến mãi',
      body: 'Gửi bản nháp cho 3 nhóm khách.',
    });
    expect(res.result).toMatchObject({ report: { managerAgentId: manager.id, kind: 'report' } });
    const fromTop = await exec(manager, 'report_to_manager', {
      title: 'Tổng kết tuần',
      body: 'Doanh số tăng 10%.',
    });
    expect(fromTop.result).toMatchObject({
      report: { managerAgentId: null, deliveredTo: { type: 'owner' } },
    });

    // The manager's system prompt shows its team and their recent reports.
    const prompt = await t.platform.context.build(manager, { channel: 'internal', tools: [] });
    expect(prompt).toContain('Your direct reports');
    expect(prompt).toContain(`Nhân viên Bình — Sales (id ${report.id})`);
    expect(prompt).toContain('Đã xong tin nhắn khuyến mãi');
    const reportPrompt = await t.platform.context.build(report, { channel: 'internal', tools: [] });
    expect(reportPrompt).toContain(`Your manager: Quản lý Hà (Store manager, id ${manager.id})`);
    expect(reportPrompt).not.toContain('Tổng kết tuần');

    // The human owner sees everything.
    const all = await t.request('GET', '/v1/reports');
    expect(all.body.data.map((r: { title: string }) => r.title)).toEqual(
      expect.arrayContaining(['Đã xong tin nhắn khuyến mãi', 'Tổng kết tuần']),
    );
    const toOwner = await t.request('GET', '/v1/reports?managerAgentId=owner');
    expect(toOwner.body.data.map((r: { title: string }) => r.title)).toEqual(['Tổng kết tuần']);
  });
});
