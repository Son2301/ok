import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestPlatform, type TestPlatform } from '../test/helpers';

let t: TestPlatform;
let agentId: string;
let token: string;

async function connect(id: string, bearer: string) {
  const client = new Client({ name: 'openclaw-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`https://agents.test/mcp/${id}`), {
    fetch: async (url, init) => t.app.request(String(url), init),
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  return client;
}

beforeAll(async () => {
  t = await createTestPlatform();
  agentId = (await t.createAgent({ name: 'McpAgent' })).id;
  await t.request('POST', `/v1/agents/${agentId}/knowledge`, {
    filename: 'faq.md',
    content: '# Phí ship\n\nMiễn phí vận chuyển cho đơn từ 500.000đ.',
  });
  await t.request('PUT', `/v1/agents/${agentId}/integrations/telegram`, {
    credentials: { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij' },
  });
  token = (await t.request('POST', `/v1/agents/${agentId}/runtime-tokens`, { label: 'mcp' })).body.token;
});
afterAll(() => t.close());

describe('MCP server (/mcp/:agentId)', () => {
  it('lists the agent’s tools with JSON schemas', async () => {
    const client = await connect(agentId, token);
    const { tools } = await client.listTools();
    const names = tools.map((x) => x.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'search_knowledge',
        'get_current_time',
        'list_my_tasks',
        'delegate_task',
        'telegram_send_message',
      ]),
    );
    expect(names).not.toContain('kiotviet_search_products'); // not enabled for this agent
    const search = tools.find((x) => x.name === 'search_knowledge')!;
    expect(search.inputSchema).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
    expect(tools.find((x) => x.name === 'telegram_send_message')!.description).toMatch(
      /Requires owner approval/,
    );
    await client.close();
  });

  it('calls tools in the control plane with the same trust rules and traces', async () => {
    const client = await connect(agentId, token);
    const res = await client.callTool({
      name: 'search_knowledge',
      arguments: { query: 'mien phi van chuyen' },
    });
    expect(res.isError).toBe(false);
    const payload = JSON.parse((res.content as { type: string; text: string }[])[0]!.text);
    expect(payload.results[0]).toMatchObject({ citation: '[1]', title: 'faq.md' });
    expect(payload.results[0].content).toContain('500.000đ');

    const send = await client.callTool({
      name: 'telegram_send_message',
      arguments: { chatId: '42', text: 'hi' },
    });
    expect(JSON.parse((send.content as { text: string }[])[0]!.text)).toMatchObject({
      status: 'pending_approval',
    });

    const bad = await client.callTool({ name: 'search_knowledge', arguments: {} });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0]!.text).toMatch(/Invalid arguments/);

    const traces = await t.request('GET', `/v1/agents/${agentId}/tool-calls`);
    expect(
      traces.body.data
        .filter((x: { source: string }) => x.source === 'mcp')
        .map((x: { outcome: string }) => x.outcome),
    ).toEqual(['error', 'pending_approval', 'executed']);
    await client.close();
  });

  it('rejects missing, invalid or foreign runtime tokens', async () => {
    const other = await t.createAgent({ name: 'Other' });
    await expect(connect(agentId, 'agrt_invalid')).rejects.toThrow();
    await expect(connect(other.id, token)).rejects.toThrow();
    const raw = await t.app.request(`/mcp/${agentId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(raw.status).toBe(401);
    const get = await t.app.request(`/mcp/${agentId}`, { headers: { authorization: `Bearer ${token}` } });
    expect(get.status).toBe(405);
  });
});
