import type { ChatRequest } from '@minh/llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { integrationCredentials } from './db/schema';
import { createTestPlatform, fakeFetch, INTERNAL_TOKEN, type TestPlatform } from './test/helpers';

/** Scripted LLM: answers by looking at the latest user/tool message. */
function scriptedLlm(req: ChatRequest) {
  const last = req.messages[req.messages.length - 1]!;
  const text = typeof last.content === 'string' ? last.content : '';
  if (last.role === 'tool') {
    const toolName = last.name;
    if (toolName === 'search_knowledge') {
      const res = JSON.parse(text) as { results: { citation: string; content: string }[] };
      return `Theo chính sách ${res.results[0]?.citation ?? ''}: đổi trả trong 7 ngày.`;
    }
    if (toolName === 'telegram_send_message') return 'Tin nhắn đang chờ chủ cửa hàng duyệt.';
    return 'Đã xong.';
  }
  if (/doi tra|đổi trả/i.test(text))
    return {
      tool_calls: [
        { id: 'call_kb', function: { name: 'search_knowledge', arguments: JSON.stringify({ query: text }) } },
      ],
    };
  if (/nhắn telegram/i.test(text))
    return {
      tool_calls: [
        {
          id: 'call_tg',
          function: {
            name: 'telegram_send_message',
            arguments: '{"chatId":"42","text":"Đơn của bạn đã sẵn sàng"}',
          },
        },
      ],
    };
  return `Bạn nói: ${text}`;
}

let t: TestPlatform;
const tgFetch = fakeFetch((call) =>
  call.url.includes('api.telegram.org') ? { ok: true, result: { message_id: 99 } } : { ok: true },
);

beforeAll(async () => {
  t = await createTestPlatform({ llm: scriptedLlm, fetch: tgFetch.fetch });
});
afterAll(() => t.close());

describe('auth', () => {
  it('rejects missing/invalid keys and keys scoped to another product', async () => {
    expect((await t.app.request('/v1/agents')).status).toBe(401);
    expect(
      (await t.app.request('/v1/agents', { headers: { authorization: 'Bearer sk-minh-nope' } })).status,
    ).toBe(401);
    const { key: safeOnly } = await t.core.createApiKey(t.org.id, { name: 'safe', scopes: ['safe'] });
    expect(
      (await t.app.request('/v1/agents', { headers: { authorization: `Bearer ${safeOnly}` } })).status,
    ).toBe(403);
  });

  it('accepts the internal token with X-Org-Id (web console)', async () => {
    const res = await t.app.request('/v1/agents', {
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, 'x-org-id': t.org.id },
    });
    expect(res.status).toBe(200);
  });

  it('isolates organisations', async () => {
    const agent = await t.createAgent({ name: 'Private' }, false);
    const other = await t.core.createOrg('Other Co', 10_000_000);
    const { key } = await t.core.createApiKey(other.id, { name: 'k' });
    const res = await t.app.request(`/v1/agents/${agent.id}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(404);
    const list = await (
      await t.app.request('/v1/agents', { headers: { authorization: `Bearer ${key}` } })
    ).json();
    expect((list as { data: unknown[] }).data).toHaveLength(0);
  });
});

describe('agents CRUD', () => {
  it('creates with defaults, lists, updates and deletes', async () => {
    const created = await t.request('POST', '/v1/agents', {
      name: 'Minh',
      role: 'Sales',
      jobDescription: 'Bán hàng online.',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Minh',
      model: 'auto',
      runtime: 'builtin',
      plan: 'starter',
      status: 'draft',
      reportsTo: null,
    });
    expect(created.body.id).toMatch(/^agt_/);

    const list = await t.request('GET', '/v1/agents');
    expect(list.body.data.some((a: { id: string }) => a.id === created.body.id)).toBe(true);

    const patched = await t.request('PATCH', `/v1/agents/${created.body.id}`, {
      plan: 'pro',
      model: 'openai/gpt-4o-mini',
      settings: { language: 'en' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      plan: 'pro',
      model: 'openai/gpt-4o-mini',
      settings: { language: 'en' },
      requiresRedeploy: false,
    });

    const detail = await t.request('GET', `/v1/agents/${created.body.id}`);
    expect(detail.body.integrationStatus.map((i: { integrationId: string }) => i.integrationId)).toEqual([
      'core',
      'team',
    ]);

    expect((await t.request('DELETE', `/v1/agents/${created.body.id}`)).status).toBe(204);
    expect((await t.request('GET', `/v1/agents/${created.body.id}`)).status).toBe(404);
  });

  it('validates input: unknown fields, integrations, reportsTo cycles', async () => {
    expect((await t.request('POST', '/v1/agents', { name: '' })).status).toBe(400);
    expect((await t.request('POST', '/v1/agents', { name: 'X', runtime: 'nope' })).status).toBe(400);
    expect((await t.request('POST', '/v1/agents', { name: 'X', bogus: 1 })).status).toBe(400);
    const unknownIntegration = await t.request('POST', '/v1/agents', {
      name: 'X',
      integrations: { myspace: { enabled: true } },
    });
    expect(unknownIntegration.status).toBe(400);
    expect(unknownIntegration.body.error.message).toMatch(/Unknown integration/);
    const badConfig = await t.request('POST', '/v1/agents', {
      name: 'X',
      integrations: { shopify: { config: { shopDomain: 'evil.com' } } },
    });
    expect(badConfig.status).toBe(400);

    const boss = await t.createAgent({ name: 'Boss' }, false);
    const mid = await t.createAgent({ name: 'Mid', reportsTo: boss.id }, false);
    const cycle = await t.request('PATCH', `/v1/agents/${boss.id}`, { reportsTo: mid.id });
    expect(cycle.status).toBe(400);
    expect(cycle.body.error.message).toMatch(/cycle/);
    expect((await t.request('PATCH', `/v1/agents/${boss.id}`, { reportsTo: boss.id })).status).toBe(400);
    const chart = await t.request('GET', '/v1/org-chart');
    const bossNode = chart.body.data.find((n: { id: string }) => n.id === boss.id);
    expect(bossNode.directReports.map((n: { id: string }) => n.id)).toEqual([mid.id]);
  });
});

describe('lifecycle', () => {
  it('deploys (charging today’s prorated fee), stops, starts, restarts and reports status/logs', async () => {
    const before = await t.core.getBalance(t.org.id);
    const agent = await t.createAgent({ name: 'Life' }, false);
    const dep = await t.request('POST', `/v1/agents/${agent.id}/deploy`);
    expect(dep.status).toBe(200);
    expect(dep.body.agent.status).toBe('running');
    expect(dep.body.runtime.state).toBe('running');
    // Oct 2026 has 31 days: 8 USD / 31.
    expect(before - (await t.core.getBalance(t.org.id))).toBe(Math.round(8_000_000 / 31));
    // Redeploying the same day does not charge again.
    await t.request('POST', `/v1/agents/${agent.id}/restart`);
    expect(before - (await t.core.getBalance(t.org.id))).toBe(Math.round(8_000_000 / 31));

    expect((await t.request('POST', `/v1/agents/${agent.id}/stop`)).body.agent.status).toBe('stopped');
    const msg = await t.request('POST', `/v1/agents/${agent.id}/messages`, { message: 'hi' });
    expect(msg.status).toBe(409);
    expect((await t.request('POST', `/v1/agents/${agent.id}/start`)).body.agent.status).toBe('running');

    const status = await t.request('GET', `/v1/agents/${agent.id}/status`);
    expect(status.body).toMatchObject({ status: 'running', driver: 'inline', runtime: { state: 'running' } });
    expect(status.body.logs.some((l: { message: string }) => l.message.includes('deployed'))).toBe(true);
    expect(status.body.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(['deployed', 'stopped', 'started']),
    );
    const charges = await t.request('GET', `/v1/billing/charges?agentId=${agent.id}`);
    expect(charges.body.data).toHaveLength(1);
    expect(charges.body.data[0]).toMatchObject({
      status: 'charged',
      day: '2026-10-25',
      amountMicros: 258065,
    });
  });

  it('refuses to deploy without funds', async () => {
    const poor = await t.core.createOrg('Poor Co', 0);
    const { key } = await t.core.createApiKey(poor.id, { name: 'k' });
    const h = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    const created = (await (
      await t.app.request('/v1/agents', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ name: 'Broke' }),
      })
    ).json()) as { id: string };
    const dep = await t.app.request(`/v1/agents/${created.id}/deploy`, { method: 'POST', headers: h });
    expect(dep.status).toBe(402);
  });
});

describe('conversations', () => {
  let agentId: string;
  beforeAll(async () => {
    agentId = (await t.createAgent({ name: 'Chat' })).id;
    await t.request('PUT', '/v1/company', {
      companyName: 'Cửa hàng An',
      companyDescription: 'Shop thời trang ở Sài Gòn',
    });
    const up = await t.request('POST', `/v1/agents/${agentId}/knowledge`, {
      filename: 'chinh-sach.md',
      content:
        '# Chính sách đổi trả\n\nKhách hàng được đổi trả miễn phí trong vòng 7 ngày kể từ khi nhận hàng.\n\n# Giao hàng\n\nGiao hàng toàn quốc 2-4 ngày.',
    });
    expect(up.status).toBe(201);
  });

  it('replies synchronously, using tools, and persists history per (agent, channel, user)', async () => {
    const res = await t.request('POST', `/v1/agents/${agentId}/messages`, {
      message: 'Chinh sach doi tra the nao?',
      userId: 'u1',
    });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe('Theo chính sách [1]: đổi trả trong 7 ngày.');
    expect(res.body.toolCalls).toEqual([expect.objectContaining({ name: 'search_knowledge', ok: true })]);
    expect(res.body.stopReason).toBe('final');
    expect(res.body.disclosure).toBeNull(); // API channel: the developer's own UI

    // System prompt: JD, company, date in Asia/Ho_Chi_Minh, tool guidance.
    const first = t.llmCalls.at(-2)!.req;
    const system = first.messages[0]!.content as string;
    expect(system).toContain('Trả lời khách hàng về sản phẩm và đơn hàng.');
    expect(system).toContain('Cửa hàng An');
    expect(system).toContain('Sunday, 2026-10-25 10:00 (Asia/Ho_Chi_Minh, UTC+07:00)');
    expect(system).toContain('search_knowledge');
    expect(first.tools?.map((x) => x.function.name)).toEqual(
      expect.arrayContaining(['search_knowledge', 'get_current_time', 'list_my_tasks']),
    );

    const again = await t.request('POST', `/v1/agents/${agentId}/messages`, {
      message: 'Cảm ơn',
      userId: 'u1',
    });
    expect(again.body.conversationId).toBe(res.body.conversationId);
    // History (user, assistant tool call, tool result, assistant) is sent on the next turn.
    const roles = t.llmCalls.at(-1)!.req.messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);

    const other = await t.request('POST', `/v1/agents/${agentId}/messages`, {
      message: 'Xin chào',
      userId: 'u2',
    });
    expect(other.body.conversationId).not.toBe(res.body.conversationId);

    const convs = await t.request('GET', `/v1/agents/${agentId}/conversations`);
    expect(convs.body.data.length).toBe(2);
    const msgs = await t.request(
      'GET',
      `/v1/agents/${agentId}/conversations/${res.body.conversationId}/messages`,
    );
    expect(msgs.body.data.map((m: { role: string }) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(msgs.body.data[1].toolCalls[0].function.name).toBe('search_knowledge');

    const traces = await t.request('GET', `/v1/agents/${agentId}/tool-calls`);
    expect(traces.body.data[0]).toMatchObject({
      tool: 'search_knowledge',
      ok: true,
      outcome: 'executed',
      source: 'inline',
      conversationId: res.body.conversationId,
    });
  });

  it('streams a reply over SSE', async () => {
    const res = await t.app.request(`/v1/agents/${agentId}/messages/stream`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'xin chao ban', userId: 'sse' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    const events = text
      .split('\n\n')
      .filter(Boolean)
      .map((block) => ({
        event: block.match(/^event: (.*)$/m)?.[1],
        data: JSON.parse(block.match(/^data: (.*)$/m)?.[1] ?? 'null'),
      }));
    expect(events[0]).toMatchObject({ event: 'start' });
    const deltas = events
      .filter((e) => e.event === 'delta')
      .map((e) => e.data.text)
      .join('');
    expect(deltas).toBe('Bạn nói: xin chao ban');
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { reply: 'Bạn nói: xin chao ban' } });
  });
});

describe('knowledge base', () => {
  it('uploads text/markdown/csv/html and searches with or without diacritics', async () => {
    const agent = await t.createAgent({ name: 'KB' }, false);
    const csv = await t.request('POST', `/v1/agents/${agent.id}/knowledge`, {
      filename: 'bang-gia.csv',
      content: 'Sản phẩm,Giá\nÁo sơ mi trắng,250000\nQuần tây đen,400000',
    });
    expect(csv.body).toMatchObject({ mimeType: 'text/csv', chunkCount: 1 });
    await t.request('POST', `/v1/agents/${agent.id}/knowledge`, {
      filename: 'gio.html',
      content: '<h1>Giờ mở cửa</h1><p>Mở cửa từ 8 giờ sáng đến 9 giờ tối.</p><script>evil()</script>',
    });
    const form = new FormData();
    form.set(
      'file',
      new File(['Bảo hành điện thoại 12 tháng tại cửa hàng.'], 'bao-hanh.txt', { type: 'text/plain' }),
    );
    const multipart = await t.app.request(`/v1/agents/${agent.id}/knowledge`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.key}` },
      body: form,
    });
    expect(multipart.status).toBe(201);
    await t.request('POST', '/v1/knowledge', {
      title: 'Thông tin chung',
      content: 'Hotline hỗ trợ khách hàng: 1900 1234.',
    });
    expect(
      (await t.request('POST', `/v1/agents/${agent.id}/knowledge`, { filename: 'x.pdf', content: '%PDF' }))
        .status,
    ).toBe(400);

    const search = async (q: string) =>
      (await t.request('GET', `/v1/agents/${agent.id}/knowledge/search?q=${encodeURIComponent(q)}`)).body
        .data as { title: string; content: string }[];
    expect((await search('gia ao so mi'))[0]!.content).toContain('Áo sơ mi trắng');
    expect((await search('giá áo sơ mi'))[0]!.content).toContain('Áo sơ mi trắng');
    expect((await search('MO CUA LUC MAY GIO'))[0]!.content).toContain('Mở cửa từ 8 giờ sáng');
    expect((await search('bao hanh dien thoai'))[0]!.content).toContain('12 tháng');
    expect((await search('hotline'))[0]!.title).toBe('Thông tin chung'); // org-wide docs are shared
    expect(await search('xyzzy')).toEqual([]);
    expect((await search('gio mo cua'))[0]!.content).not.toContain('evil');

    const docs = await t.request('GET', `/v1/agents/${agent.id}/knowledge`);
    expect(docs.body.data).toHaveLength(3);
    expect((await t.request('DELETE', `/v1/agents/${agent.id}/knowledge/${csv.body.id}`)).status).toBe(204);
    expect((await search('ao so mi')).length).toBe(0);
  });
});

describe('integrations & credentials', () => {
  it('lists the catalog', async () => {
    const res = await t.request('GET', '/v1/integrations');
    const zalo = res.body.data.find((i: { id: string }) => i.id === 'zalo_oa');
    expect(zalo).toMatchObject({
      name: 'Zalo Official Account',
      category: 'messaging',
      verified: false,
      channel: 'zalo',
    });
    expect(zalo.tools[0]).toMatchObject({ name: 'zalo_send_message', defaultTrust: 'approve' });
  });

  it('stores credentials encrypted and only ever returns them masked', async () => {
    const agent = await t.createAgent({ name: 'Creds' }, false);
    const secret = '123456:SUPERSECRETBOTTOKEN_abcdefghijklmn';
    const put = await t.request('PUT', `/v1/agents/${agent.id}/integrations/telegram`, {
      credentials: { botToken: secret },
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      integrationId: 'telegram',
      enabled: true,
      ready: true,
      credentials: { configured: true, fields: { botToken: '••••klmn' } },
    });
    expect(put.text).not.toContain('SUPERSECRET');
    for (const path of [`/v1/agents/${agent.id}`, `/v1/agents/${agent.id}/integrations`]) {
      const res = await t.request('GET', path);
      expect(res.text).not.toContain('SUPERSECRET');
    }
    const [row] = await t.handle.db.select().from(integrationCredentials);
    expect(row!.ciphertext).not.toContain('SUPERSECRET');
    expect(await t.platform.credentials.get({ id: agent.id, orgId: t.org.id }, 'telegram')).toEqual({
      botToken: secret,
    });

    const bad = await t.request('PUT', `/v1/agents/${agent.id}/integrations/telegram`, {
      credentials: { botToken: 'nope-not-a-token' },
    });
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain('nope-not-a-token');
    expect(
      (
        await t.request('PUT', `/v1/agents/${agent.id}/integrations/telegram`, {
          tools: { telegram_send_message: 'yolo' },
        })
      ).status,
    ).toBe(400);
  });
});

describe('trust levels & approvals', () => {
  it('queues approve-level tool calls, runs them when the owner approves, and records the outcome', async () => {
    const agent = await t.createAgent({ name: 'Careful' });
    await t.request('PUT', `/v1/agents/${agent.id}/integrations/telegram`, {
      credentials: { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij' },
    });
    const sentBefore = tgFetch.calls.length;
    const res = await t.request('POST', `/v1/agents/${agent.id}/messages`, {
      message: 'Nhắn telegram cho khách 42 nhé',
      userId: 'owner',
    });
    expect(res.body.reply).toBe('Tin nhắn đang chờ chủ cửa hàng duyệt.');
    expect(res.body.toolCalls[0]).toMatchObject({
      name: 'telegram_send_message',
      ok: true,
      outcome: 'pending_approval',
    });
    expect(tgFetch.calls.length).toBe(sentBefore); // nothing sent yet
    // The model saw the approval note.
    const toolMsg = t.llmCalls.at(-1)!.req.messages.at(-1)!;
    expect(JSON.parse(toolMsg.content as string)).toMatchObject({ status: 'pending_approval' });
    // The tool description told the model up front.
    const def = t.llmCalls.at(-1)!.req.tools!.find((x) => x.function.name === 'telegram_send_message')!;
    expect(def.function.description).toMatch(/Requires owner approval/);

    const pending = await t.request('GET', '/v1/approvals?status=pending');
    const approval = pending.body.data.find((a: { agentId: string }) => a.agentId === agent.id);
    expect(approval).toMatchObject({
      tool: 'telegram_send_message',
      mode: 'approve',
      status: 'pending',
      arguments: { chatId: '42', text: 'Đơn của bạn đã sẵn sàng' },
    });

    const approved = await t.request('POST', `/v1/approvals/${approval.id}/approve`, { note: 'ok' });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: 'executed',
      result: { messageIds: [99] },
      decidedBy: expect.stringMatching(/^api_key:/),
    });
    const sent = tgFetch.calls.at(-1)!;
    expect(sent.url).toContain('/sendMessage');
    expect(sent.json()).toEqual({ chat_id: '42', text: 'Đơn của bạn đã sẵn sàng' });
    expect((await t.request('POST', `/v1/approvals/${approval.id}/approve`)).status).toBe(409);

    // The conversation got a note so the agent knows on its next turn.
    const msgs = await t.request(
      'GET',
      `/v1/agents/${agent.id}/conversations/${res.body.conversationId}/messages`,
    );
    expect(msgs.body.data.at(-1)).toMatchObject({
      role: 'system',
      content: expect.stringContaining('Owner approved telegram_send_message'),
    });
  });

  it('supports draft mode, auto mode, rejection, and hides commerce write tools unless enabled', async () => {
    const agent = await t.createAgent({ name: 'Drafty' });
    await t.request('PUT', `/v1/agents/${agent.id}/integrations/telegram`, {
      credentials: { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij' },
      tools: { telegram_send_message: 'draft' },
    });
    const res = await t.request('POST', `/v1/agents/${agent.id}/messages`, {
      message: 'Nhắn telegram giúp mình',
      userId: 'd',
    });
    expect(res.body.toolCalls[0].outcome).toBe('drafted');
    const drafts = await t.request('GET', `/v1/approvals?status=drafted&agentId=${agent.id}`);
    expect(drafts.body.data).toHaveLength(1);
    const rejected = await t.request('POST', `/v1/approvals/${drafts.body.data[0].id}/reject`, {
      note: 'sai nội dung',
    });
    expect(rejected.body.status).toBe('rejected');

    await t.request('PUT', `/v1/agents/${agent.id}/integrations/telegram`, {
      tools: { telegram_send_message: 'auto' },
    });
    const auto = await t.request('POST', `/v1/agents/${agent.id}/messages`, {
      message: 'Nhắn telegram lần nữa',
      userId: 'd2',
    });
    expect(auto.body.toolCalls[0].outcome).toBe('executed');

    await t.request('PUT', `/v1/agents/${agent.id}/integrations/telegram`, {
      tools: { telegram_send_message: 'off' },
    });
    const agentRow = await t.platform.agents.get(t.org.id, agent.id);
    expect(
      (await t.platform.tools.resolve(agentRow)).some((r) => r.tool.name === 'telegram_send_message'),
    ).toBe(false);
    const denied = await t.platform.tools.execute(
      agentRow,
      'telegram_send_message',
      { chatId: '1', text: 'x' },
      { source: 'proxy' },
    );
    expect(denied).toMatchObject({ ok: false, outcome: 'denied' });

    // Commerce: read tools exposed, write tools off by default; enabling explicitly works.
    await t.request('PUT', `/v1/agents/${agent.id}/integrations/kiotviet`, {
      credentials: { clientId: 'client-id-123', clientSecret: 'client-secret-456' },
      config: { retailer: 'shopan' },
    });
    let names = (await t.platform.tools.resolve(await t.platform.agents.get(t.org.id, agent.id))).map(
      (r) => r.tool.name,
    );
    expect(names).toContain('kiotviet_search_products');
    expect(names).not.toContain('kiotviet_create_order');
    const view = await t.request('PUT', `/v1/agents/${agent.id}/integrations/kiotviet`, {
      tools: { kiotviet_create_order: 'approve' },
    });
    expect(view.body.tools.find((x: { name: string }) => x.name === 'kiotviet_create_order')).toMatchObject({
      defaultTrust: 'off',
      trust: 'approve',
    });
    names = (await t.platform.tools.resolve(await t.platform.agents.get(t.org.id, agent.id))).map(
      (r) => r.tool.name,
    );
    expect(names).toContain('kiotviet_create_order');
  });
});

describe('runtime tokens', () => {
  it('issues external tokens once, lists them masked and revokes them', async () => {
    const agent = await t.createAgent({ name: 'Tok' });
    const created = await t.request('POST', `/v1/agents/${agent.id}/runtime-tokens`, {
      label: 'self-hosted openclaw',
    });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^agrt_/);
    expect(created.body.mcpUrl).toBe(`https://agents.test/mcp/${agent.id}`);
    const list = await t.request('GET', `/v1/agents/${agent.id}/runtime-tokens`);
    expect(list.text).not.toContain(created.body.token);
    expect(list.body.data.map((x: { kind: string }) => x.kind).sort()).toEqual(['container', 'external']);
    // Token works on the tool proxy for this agent only.
    const call = (id: string, token: string) =>
      t.app.request(`/internal/agents/${id}/tools/get_current_time`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{"arguments":{}}',
      });
    expect((await call(agent.id, created.body.token)).status).toBe(200);
    const other = await t.createAgent({ name: 'Other' });
    expect((await call(other.id, created.body.token)).status).toBe(401);
    expect(
      (await t.request('DELETE', `/v1/agents/${agent.id}/runtime-tokens/${created.body.id}`)).status,
    ).toBe(204);
    expect((await call(agent.id, created.body.token)).status).toBe(401);
  });
});
