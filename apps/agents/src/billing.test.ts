import { type ChatRequest, MockLlm } from '@ok/llm';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPlans } from './config';
import { createTestPlatform, type TestPlatform } from './test/helpers';

const DAILY_OCT = Math.round(8_000_000 / 31); // 258_065
const DAILY_NOV = Math.round(8_000_000 / 30); // 266_667

let t: TestPlatform | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('scheduler: daily prorated billing and suspension', () => {
  it('charges each running agent once per local day and suspends it when the wallet is empty', async () => {
    t = await createTestPlatform({ orgCreditMicros: DAILY_OCT * 2 + 1000 });
    const agent = await t.createAgent({ name: 'Billable' });
    expect(await t.core.getBalance(t.org.id)).toBe(DAILY_OCT + 1000);

    // Same day: nothing more to charge.
    let report = await t.platform.scheduler.tick();
    expect(report.charged).toEqual([]);

    // Next local day (Oct 26, 10:00 in Vietnam).
    t.clock.set('2026-10-26T03:00:00Z');
    report = await t.platform.scheduler.tick();
    expect(report.charged).toEqual([{ agentId: agent.id, amountMicros: DAILY_OCT }]);
    expect(await t.core.getBalance(t.org.id)).toBe(1000);
    expect((await t.platform.scheduler.tick()).charged).toEqual([]); // idempotent

    // Day 3: insufficient funds → suspended, runtime stopped, messages refused.
    t.clock.set('2026-10-27T03:00:00Z');
    report = await t.platform.scheduler.tick();
    expect(report.suspended).toEqual([agent.id]);
    const status = await t.request('GET', `/v1/agents/${agent.id}/status`);
    expect(status.body).toMatchObject({ status: 'suspended_billing', runtime: { state: 'stopped' } });
    expect(status.body.statusReason).toMatch(/insufficient wallet balance/);
    expect(status.body.events.some((e: { type: string }) => e.type === 'suspended_billing')).toBe(true);
    expect((await t.request('POST', `/v1/agents/${agent.id}/messages`, { message: 'hi' })).status).toBe(409);
    expect((await t.request('POST', `/v1/agents/${agent.id}/start`)).status).toBe(402);

    const entries = await t.core.listWalletEntries(t.org.id, { product: 'agents' });
    expect(entries.every((e) => e.kind === 'subscription')).toBe(true);
    expect(entries.map((e) => e.amountMicros)).toEqual([-DAILY_OCT, -DAILY_OCT]);
    const charges = await t.request('GET', '/v1/billing/charges');
    // The scheduler's attempt and the refused start are both recorded as failed attempts.
    expect(charges.body.data.map((c: { status: string; day: string }) => `${c.day}:${c.status}`)).toEqual([
      '2026-10-27:failed',
      '2026-10-27:failed',
      '2026-10-26:charged',
      '2026-10-25:charged',
    ]);

    // Top up and start again: today's fee is charged, agent runs.
    await t.core.credit(t.org.id, 5_000_000);
    const started = await t.request('POST', `/v1/agents/${agent.id}/start`);
    expect(started.status).toBe(200);
    expect(started.body.agent.status).toBe('running');
    expect(await t.core.getBalance(t.org.id)).toBe(5_001_000 - DAILY_OCT);
    // Stopped agents are not billed.
    await t.request('POST', `/v1/agents/${agent.id}/stop`);
    t.clock.set('2026-10-28T03:00:00Z');
    expect((await t.platform.scheduler.tick()).charged).toEqual([]);
  });

  it('prorates by the number of days in the local month', async () => {
    t = await createTestPlatform({ clock: undefined });
    t.clock.set('2026-11-14T20:00:00Z'); // Nov 15 03:00 in Vietnam
    expect(t.platform.billing.dailyAmount('starter')).toBe(DAILY_NOV);
    expect(t.platform.billing.dailyAmount('pro')).toBe(Math.round(20_000_000 / 30));
    t.clock.set('2026-02-10T03:00:00Z');
    expect(t.platform.billing.dailyAmount('starter')).toBe(Math.round(8_000_000 / 28));
    const plans = await t.request('GET', '/v1/plans');
    expect(
      plans.body.data.map((p: { id: string; monthlyPriceMicros: number }) => [p.id, p.monthlyPriceMicros]),
    ).toEqual([
      ['starter', 8_000_000],
      ['pro', 20_000_000],
    ]);
  });
});

describe('scheduler: heartbeat and daily summary', () => {
  it('wakes agents with open tasks, respects the interval, and posts one daily summary per agent', async () => {
    let taskId = '';
    const llm = new MockLlm((req: ChatRequest) => {
      const last = req.messages.at(-1)!;
      const text = String(last.content ?? '');
      if (last.role === 'user' && text.startsWith('[Scheduled heartbeat')) {
        return {
          tool_calls: [
            {
              id: 'hb1',
              function: {
                name: 'update_task',
                arguments: JSON.stringify({ taskId, status: 'in_progress', note: 'Bắt đầu làm' }),
              },
            },
          ],
        };
      }
      return 'Đã cập nhật công việc.';
    });
    t = await createTestPlatform({ llmClient: () => llm });
    const worker = await t.createAgent({ name: 'Worker' });
    const idle = await t.createAgent({ name: 'Idle' });
    const task = await t.request('POST', '/v1/tasks', {
      title: 'Gọi lại khách VIP',
      description: 'Khách hỏi về đơn sỉ',
      assigneeAgentId: worker.id,
      priority: 'urgent',
    });
    taskId = task.body.id;

    let report = await t.platform.scheduler.tick();
    expect(report.heartbeats).toEqual([{ agentId: worker.id, ok: true }]);
    const heartbeatMsg = llm.calls[0]!.messages.at(-1)!.content as string;
    expect(heartbeatMsg).toContain('[Scheduled heartbeat — Sunday, 2026-10-25 10:00');
    expect(heartbeatMsg).toContain(`${taskId} [todo, urgent] Gọi lại khách VIP: Khách hỏi về đơn sỉ`);
    expect(llm.calls[0]!.messages[0]!.content).toContain('internal wake-up');
    expect((await t.request('GET', `/v1/tasks/${taskId}`)).body).toMatchObject({
      status: 'in_progress',
      comments: [expect.objectContaining({ body: 'Bắt đầu làm' })],
    });
    const convs = await t.request('GET', `/v1/agents/${worker.id}/conversations?channel=internal`);
    expect(convs.body.data).toHaveLength(1);
    expect(convs.body.data[0].externalUserId).toBe('scheduler');

    // Within the heartbeat interval: no new wake-up.
    t.clock.advance(30 * 60_000);
    expect((await t.platform.scheduler.tick()).heartbeats).toEqual([]);
    t.clock.advance(31 * 60_000);
    expect((await t.platform.scheduler.tick()).heartbeats).toEqual([{ agentId: worker.id, ok: true }]);

    // No summary before 18:00 local; then exactly one per agent per day.
    expect(report.summaries).toEqual([]);
    t.clock.set('2026-10-25T11:30:00Z'); // 18:30 in Vietnam
    report = await t.platform.scheduler.tick();
    expect(report.summaries.sort()).toEqual([worker.id, idle.id].sort());
    expect((await t.platform.scheduler.tick()).summaries).toEqual([]);
    const summaries = await t.request('GET', `/v1/reports?kind=daily_summary&agentId=${worker.id}`);
    expect(summaries.body.data).toHaveLength(1);
    expect(summaries.body.data[0].title).toBe('Báo cáo cuối ngày 2026-10-25');
    // Three heartbeats ran today (10:00, 11:01, 18:30); they are not counted as customer conversations.
    expect(summaries.body.data[0].body).toContain('Hội thoại với khách: 0 (tin nhắn khách: 0, trả lời: 0)');
    expect(summaries.body.data[0].body).toContain('Lần tự làm việc theo lịch: 3');
    expect(summaries.body.data[0].body).toContain('Lượt dùng công cụ: 3 (lỗi: 0)');
    expect(summaries.body.data[0].body).toContain('Gọi lại khách VIP (in_progress)');
  });
});

describe('LLM quota split between platform org and customer org', () => {
  it('bills the platform org inside the plan quota and the customer org beyond it', async () => {
    t = await createTestPlatform({
      config: {
        plans: buildPlans({
          AGENTS_PLAN_STARTER_PRICE_MICROS: 8_000_000,
          AGENTS_PLAN_STARTER_MONTHLY_TOKENS: 400,
          AGENTS_PLAN_PRO_PRICE_MICROS: 20_000_000,
          AGENTS_PLAN_PRO_MONTHLY_TOKENS: 10_000_000,
        }),
      },
    });
    const agent = await t.createAgent({ name: 'Quota' });
    for (let i = 0; i < 4; i++)
      await t.request('POST', `/v1/agents/${agent.id}/messages`, { message: `câu hỏi số ${i}` });
    const billed = t.llmCalls.map((c) => c.billingOrgId);
    expect(billed[0]).toBe(t.platformOrg.id);
    expect(billed.at(-1)).toBe(t.org.id);
    expect(billed.indexOf(t.org.id)).toBeGreaterThan(0);

    const usage = await t.request('GET', '/v1/usage');
    const row = usage.body.data.find((u: { agentId: string }) => u.agentId === agent.id);
    expect(row.requests).toBe(4);
    expect(row.platformTokens).toBeGreaterThanOrEqual(400);
    expect(row.customerTokens).toBeGreaterThan(0);
    expect(row.platformTokens + row.customerTokens).toBe(row.totalTokens);
    expect(row.remainingIncludedTokens).toBe(0);
    expect(usage.body.month).toBe('2026-10');

    // A new month resets the included quota.
    t.clock.set('2026-11-02T03:00:00Z');
    await t.request('POST', `/v1/agents/${agent.id}/messages`, { message: 'tháng mới' });
    expect(t.llmCalls.at(-1)!.billingOrgId).toBe(t.platformOrg.id);
  });

  it('bills the customer for everything when no platform org is configured', async () => {
    t = await createTestPlatform({ config: { platformOrgId: null } });
    const agent = await t.createAgent({ name: 'NoPlatform' });
    await t.request('POST', `/v1/agents/${agent.id}/messages`, { message: 'hi' });
    expect(t.llmCalls.map((c) => c.billingOrgId)).toEqual([t.org.id]);
  });
});

describe('per-agent monthly budget cap', () => {
  it('warns at 80%, pauses at 100% before the next LLM call, and resumes next month', async () => {
    const inner = new MockLlm(() => 'ok');
    t = await createTestPlatform({
      config: { platformOrgId: null },
      llmClient: () => ({
        chat: async (req) => {
          const res = await inner.chat(req);
          return { ...res, usage: { ...res.usage!, cost_micros: 300_000 } };
        },
        stream: (req) => inner.stream(req),
      }),
    });
    const agent = await t.createAgent({ name: 'Budgeted', budgetMonthlyMicros: 1_000_000 });
    const send = (m: string) => t!.request('POST', `/v1/agents/${agent.id}/messages`, { message: m });

    for (const m of ['1', '2', '3']) expect((await send(m)).status).toBe(200); // 900k spent
    let status = await t.request('GET', `/v1/agents/${agent.id}/status`);
    expect(status.body.events.some((e: { type: string }) => e.type === 'budget_warning')).toBe(false);
    expect((await send('4')).status).toBe(200); // pre-check sees 900k ≥ 80% → warning; spent 1.2M
    status = await t.request('GET', `/v1/agents/${agent.id}/status`);
    expect(status.body.events.filter((e: { type: string }) => e.type === 'budget_warning')).toHaveLength(1);
    expect(status.body.usage.customerCostMicros).toBe(1_200_000);

    const blocked = await send('5'); // pre-check: 1.2M ≥ 1M → paused, no LLM call made
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.message).toMatch(/budget reached/);
    expect(inner.calls).toHaveLength(4);
    await t.platform.bg.drain();
    status = await t.request('GET', `/v1/agents/${agent.id}/status`);
    expect(status.body).toMatchObject({ status: 'paused_budget', runtime: { state: 'stopped' } });
    expect(status.body.events.some((e: { type: string }) => e.type === 'budget_exhausted')).toBe(true);
    expect((await send('6')).status).toBe(409);
    expect((await t.request('POST', `/v1/agents/${agent.id}/start`)).status).toBe(402);

    // Same month: scheduler keeps it paused. Next month: resumed automatically.
    expect((await t.platform.scheduler.tick()).resumed).toEqual([]);
    t.clock.set('2026-11-01T03:00:00Z');
    expect((await t.platform.scheduler.tick()).resumed).toEqual([agent.id]);
    expect((await send('7')).status).toBe(200);
  });

  it('treats a zero budget as "only what the plan includes"', async () => {
    t = await createTestPlatform({
      config: {
        plans: buildPlans({
          AGENTS_PLAN_STARTER_PRICE_MICROS: 8_000_000,
          AGENTS_PLAN_STARTER_MONTHLY_TOKENS: 400,
          AGENTS_PLAN_PRO_PRICE_MICROS: 20_000_000,
          AGENTS_PLAN_PRO_MONTHLY_TOKENS: 10_000_000,
        }),
      },
    });
    const agent = await t.createAgent({ name: 'IncludedOnly', budgetMonthlyMicros: 0 });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (await t.request('POST', `/v1/agents/${agent.id}/messages`, { message: `câu ${i}` })).status,
      );
    }
    // Works while the included quota lasts (platform-paid), then pauses before any customer-billed call.
    expect(statuses[0]).toBe(200);
    expect(statuses).toContain(402);
    expect(t.llmCalls.every((c) => c.billingOrgId === t!.platformOrg.id)).toBe(true);
    expect((await t.request('GET', `/v1/agents/${agent.id}`)).body.status).toBe('paused_budget');
    // Same month: stays paused (no flapping). New month: quota resets and the agent resumes.
    expect((await t.platform.scheduler.tick()).resumed).toEqual([]);
    t.clock.set('2026-11-01T03:00:00Z');
    expect((await t.platform.scheduler.tick()).resumed).toEqual([agent.id]);
  });

  it('lets the owner raise the cap to resume', async () => {
    const inner = new MockLlm(() => 'ok');
    t = await createTestPlatform({
      config: { platformOrgId: null },
      llmClient: () => ({
        chat: async (req) => ({
          ...(await inner.chat(req)),
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost_micros: 600_000 },
        }),
        stream: (req) => inner.stream(req),
      }),
    });
    const agent = await t.createAgent({ name: 'Raise', budgetMonthlyMicros: 500_000 });
    expect((await t.request('POST', `/v1/agents/${agent.id}/messages`, { message: 'a' })).status).toBe(200);
    expect((await t.request('POST', `/v1/agents/${agent.id}/messages`, { message: 'b' })).status).toBe(402);
    await t.request('PATCH', `/v1/agents/${agent.id}`, { budgetMonthlyMicros: 2_000_000 });
    expect((await t.request('POST', `/v1/agents/${agent.id}/start`)).body.agent.status).toBe('running');
    expect((await t.request('POST', `/v1/agents/${agent.id}/messages`, { message: 'c' })).status).toBe(200);
  });
});
