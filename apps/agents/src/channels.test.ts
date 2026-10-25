import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zaloSignature } from './integrations/zalo';
import { createTestPlatform, fakeFetch, type TestPlatform } from './test/helpers';

const BOT = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
let t: TestPlatform;
const outbound = fakeFetch((call) => {
  if (call.url.includes('api.telegram.org'))
    return { ok: true, result: call.url.endsWith('/setWebhook') ? true : { message_id: 1 } };
  if (call.url.includes('openapi.zalo.me'))
    return { error: 0, message: 'Success', data: { message_id: 'z1', user_id: '2468' } };
  return {};
});

beforeAll(async () => {
  t = await createTestPlatform({
    llm: (req) => `Trả lời: ${req.messages.at(-1)!.content}`,
    fetch: outbound.fetch,
  });
  await t.request('PUT', '/v1/company', { companyName: 'Cửa hàng An' });
});
afterAll(() => t.close());

const tgUpdate = (updateId: number, fromId: number, text?: string) => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1761361200,
    chat: { id: fromId, type: 'private' },
    from: { id: fromId, is_bot: false, first_name: 'Khách' },
    ...(text !== undefined ? { text } : {}),
  },
});

describe('Telegram channel', () => {
  let agentId: string;
  let secret: string;

  beforeAll(async () => {
    agentId = (await t.createAgent({ name: 'TeleBot' })).id;
    await t.request('PUT', `/v1/agents/${agentId}/integrations/telegram`, { credentials: { botToken: BOT } });
    const res = await t.request('PUT', `/v1/agents/${agentId}/channels/telegram`, { registerWebhook: true });
    expect(res.status).toBe(200);
    secret = res.body.secrets.secretToken;
    expect(res.body.channel.webhookUrl).toBe(`https://agents.test/channels/telegram/${agentId}`);
    expect(res.body.webhook).toEqual({ registered: true });
    const setWebhook = outbound.calls.find((c) => c.url.endsWith('/setWebhook'))!;
    expect(setWebhook.json()).toMatchObject({
      url: `https://agents.test/channels/telegram/${agentId}`,
      secret_token: secret,
    });
  });

  const post = (body: unknown, token?: string) =>
    t.app.request(`/channels/telegram/${agentId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-telegram-bot-api-secret-token': token } : {}),
      },
      body: JSON.stringify(body),
    });

  it('rejects requests without the secret token', async () => {
    expect((await post(tgUpdate(1, 42, 'hi'))).status).toBe(401);
    expect((await post(tgUpdate(1, 42, 'hi'), 'wrong-secret')).status).toBe(401);
  });

  it('acknowledges immediately, replies via sendMessage, and discloses AI on the first reply only', async () => {
    const res = await post(tgUpdate(100, 42, 'Shop còn áo size M không?'), secret);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'accepted' });
    await t.platform.bg.drain();
    const send = outbound.calls.filter((c) => c.url.endsWith('/sendMessage')).at(-1)!;
    expect(send.url).toBe(`https://api.telegram.org/bot${BOT}/sendMessage`);
    const body = send.json<{ chat_id: string; text: string }>();
    expect(body.chat_id).toBe('42');
    expect(body.text).toBe(
      'Xin chào! Mình là trợ lý AI của Cửa hàng An. Câu trả lời do AI tạo ra và có thể chưa chính xác; bạn có thể yêu cầu gặp nhân viên bất cứ lúc nào.\n\nTrả lời: Shop còn áo size M không?',
    );

    await post(tgUpdate(101, 42, 'Cảm ơn'), secret);
    await t.platform.bg.drain();
    expect(
      outbound.calls
        .filter((c) => c.url.endsWith('/sendMessage'))
        .at(-1)!
        .json<{ text: string }>().text,
    ).toBe('Trả lời: Cảm ơn');

    const convs = await t.request('GET', `/v1/agents/${agentId}/conversations?channel=telegram`);
    expect(convs.body.data).toHaveLength(1);
    expect(convs.body.data[0]).toMatchObject({
      externalUserId: '42',
      metadata: { replyTo: '42', userName: 'Khách' },
    });
  });

  it('deduplicates redelivered updates and handles non-text messages', async () => {
    const before = outbound.calls.length;
    expect(await (await post(tgUpdate(100, 42, 'Shop còn áo size M không?'), secret)).json()).toEqual({
      ok: true,
      status: 'duplicate',
    });
    await post(tgUpdate(102, 42), secret); // e.g. a sticker
    await t.platform.bg.drain();
    expect(outbound.calls.length).toBe(before + 1);
    expect(outbound.calls.at(-1)!.json<{ text: string }>().text).toMatch(/chỉ đọc được tin nhắn văn bản/);
  });

  it('applies the allowlist inbound policy', async () => {
    await t.request('PATCH', `/v1/agents/${agentId}`, {
      settings: { inbound: { policy: 'allowlist', allowlist: ['telegram:42'] } },
    });
    const before = outbound.calls.length;
    const blocked = await post(tgUpdate(200, 777, 'Tôi là người lạ'), secret);
    expect(await blocked.json()).toEqual({ ok: true, status: 'blocked' });
    await post(tgUpdate(201, 42, 'Tôi quen'), secret);
    await t.platform.bg.drain();
    expect(outbound.calls.length).toBe(before + 1);
    expect(outbound.calls.at(-1)!.json<{ chat_id: string }>().chat_id).toBe('42');
    const status = await t.request('GET', `/v1/agents/${agentId}/status`);
    expect(status.body.events.some((e: { type: string }) => e.type === 'inbound_blocked')).toBe(true);
    await t.request('PATCH', `/v1/agents/${agentId}`, {
      settings: { inbound: { policy: 'open', allowlist: [] } },
    });
  });

  it('requires Telegram credentials before enabling the channel', async () => {
    const other = await t.createAgent({ name: 'NoCreds' });
    const res = await t.request('PUT', `/v1/agents/${other.id}/channels/telegram`, {});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Connect the Telegram integration first/);
  });
});

describe('Zalo OA channel', () => {
  let agentId: string;
  const appId = '1234567890';
  const oaSecretKey = 'oa-secret-key-abc';

  beforeAll(async () => {
    agentId = (
      await t.createAgent({
        name: 'ZaloBot',
        settings: { aiDisclosure: { enabled: true, text: 'Bạn đang chat với trợ lý ảo (AI).' } },
      })
    ).id;
    await t.request('PUT', `/v1/agents/${agentId}/integrations/zalo_oa`, {
      credentials: { accessToken: 'zalo-access-token-1', appId, oaSecretKey },
    });
    expect((await t.request('PUT', `/v1/agents/${agentId}/channels/zalo`, {})).status).toBe(200);
  });

  const event = (msgId: string, text: string) =>
    JSON.stringify({
      app_id: appId,
      event_name: 'user_send_text',
      timestamp: '1761361200000',
      sender: { id: '2468' },
      recipient: { id: '1357' },
      message: { text, msg_id: msgId },
    });
  const post = (raw: string, signature?: string) =>
    t.app.request(`/channels/zalo/${agentId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signature ? { 'x-zevent-signature': signature } : {}),
      },
      body: raw,
    });

  it('verifies the X-ZEvent-Signature', async () => {
    const raw = event('m0', 'xin chào');
    expect((await post(raw)).status).toBe(401);
    expect((await post(raw, zaloSignature(appId, raw, '1761361200000', 'wrong-key'))).status).toBe(401);
  });

  it('replies through the OA API v3 with the custom disclosure on first reply', async () => {
    const raw = event('m1', 'Cho mình hỏi giá');
    const res = await post(raw, zaloSignature(appId, raw, '1761361200000', oaSecretKey));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'accepted' });
    await t.platform.bg.drain();
    const send = outbound.calls.filter((c) => c.url.includes('openapi.zalo.me')).at(-1)!;
    expect(send.url).toBe('https://openapi.zalo.me/v3.0/oa/message/cs');
    expect(send.headers.access_token).toBe('zalo-access-token-1');
    expect(send.json()).toEqual({
      recipient: { user_id: '2468' },
      message: { text: 'Bạn đang chat với trợ lý ảo (AI).\n\nTrả lời: Cho mình hỏi giá' },
    });
    // Duplicate msg_id is ignored.
    const dup = await post(raw, zaloSignature(appId, raw, '1761361200000', oaSecretKey));
    expect(await dup.json()).toEqual({ ok: true, status: 'duplicate' });
  });

  it('refuses to enable the channel without webhook verification credentials', async () => {
    const other = await t.createAgent({ name: 'ZaloNoSecret' });
    await t.request('PUT', `/v1/agents/${other.id}/integrations/zalo_oa`, {
      credentials: { accessToken: 'zalo-access-token-1' },
    });
    const res = await t.request('PUT', `/v1/agents/${other.id}/channels/zalo`, {});
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/oaSecretKey/);
  });
});

describe('web chat widget', () => {
  let token: string;
  let agentId: string;

  beforeAll(async () => {
    agentId = (await t.createAgent({ name: 'WebBot' })).id;
    const res = await t.request('PUT', `/v1/agents/${agentId}/channels/web`, {
      config: {
        title: 'Hỗ trợ',
        greeting: 'Chào bạn!',
        color: '#0f766e',
        allowedOrigins: ['https://shop-an.vn'],
      },
    });
    token = res.body.channel.publicToken;
    expect(token).toMatch(/^pub_/);
    expect(res.body.channel.embed).toContain(`data-token="${token}"`);
  });

  const chat = (body: unknown, ip = '203.0.113.9', origin = 'https://shop-an.vn') =>
    t.app.request(`/public/chat/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': `${ip}, 10.0.0.1` },
      body: JSON.stringify(body),
    });

  it('serves the widget script and config', async () => {
    const js = await t.app.request('/widget.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    const source = await js.text();
    expect(source).toContain('/public/chat/');
    expect(source).not.toContain('innerHTML');
    const cfg = await t.app.request(`/public/chat/${token}`, { headers: { origin: 'https://shop-an.vn' } });
    expect(cfg.headers.get('access-control-allow-origin')).toBe('https://shop-an.vn');
    expect(await cfg.json()).toMatchObject({
      agentName: 'WebBot',
      title: 'Hỗ trợ',
      greeting: 'Chào bạn!',
      online: true,
    });
    const preflight = await t.app.request(`/public/chat/${token}`, {
      method: 'OPTIONS',
      headers: { origin: 'https://shop-an.vn' },
    });
    expect(preflight.status).toBe(204);
    expect(
      (await t.app.request(`/public/chat/${token}`, { headers: { origin: 'https://evil.example' } })).status,
    ).toBe(403);
  });

  it('chats with disclosure on the first reply', async () => {
    const first = await chat({ message: 'Xin chào shop', sessionId: 'visitor-abc-123' });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { reply: string; disclosure: string | null };
    expect(body.reply).toBe('Trả lời: Xin chào shop');
    expect(body.disclosure).toMatch(/trợ lý AI/);
    const second = (await (
      await chat({ message: 'Giá bao nhiêu?', sessionId: 'visitor-abc-123' })
    ).json()) as { disclosure: string | null };
    expect(second.disclosure).toBeNull();
    expect((await chat({ message: 'x', sessionId: 'bad id!' })).status).toBe(400);
    expect(
      (
        await t.app.request('/public/chat/pub_doesnotexist', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404);
  });

  it('rate-limits per IP', async () => {
    const results: number[] = [];
    for (let i = 0; i < 22; i++)
      results.push((await chat({ message: `m${i}`, sessionId: 'visitor-rate-1' }, '198.51.100.7')).status);
    expect(results.filter((s) => s === 200)).toHaveLength(20);
    expect(results.at(-1)).toBe(429);
    // Another IP is unaffected.
    expect((await chat({ message: 'hello', sessionId: 'visitor-rate-2' }, '198.51.100.8')).status).toBe(200);
  });
});
