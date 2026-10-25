import { createHmac } from 'node:crypto';
import { createLogger } from '@ok/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentRow } from '../db/schema';
import { fakeFetch, jsonResponse } from '../test/helpers';
import { signWebhook } from './core';
import { buildRawEmail, gmailIntegration, googleCalendarIntegration } from './google';
import { haravanIntegration } from './haravan';
import { INTEGRATIONS, IntegrationCatalog } from './index';
import { clearKiotVietTokenCache, kiotvietIntegration } from './kiotviet';
import { buildShopeeUrl, shopeeIntegration, shopeeSign } from './marketplaces';
import { shopifyConfig, shopifyIntegration } from './shopify';
import { parseTelegramUpdate, splitMessage, telegramIntegration } from './telegram';
import { defaultTrust, type IntegrationSpec, type ToolContext } from './types';
import { parseZaloEvent, verifyZaloSignature, zaloIntegration, zaloSignature } from './zalo';

const agent = { id: 'agt_test', orgId: 'org_test', name: 'Lan' } as AgentRow;

function ctxFor(
  fetchFn: ToolContext['fetch'],
  credentials: Record<string, unknown>,
  config: Record<string, unknown> = {},
) {
  const saved: Record<string, unknown>[] = [];
  const ctx: ToolContext = {
    orgId: agent.orgId,
    agent,
    conversationId: null,
    credentials,
    config,
    fetch: fetchFn,
    signal: new AbortController().signal,
    now: () => new Date('2026-10-25T03:00:00Z'),
    timezone: 'Asia/Ho_Chi_Minh',
    services: {} as ToolContext['services'],
    saveCredentials: async (p) => {
      saved.push(p);
    },
    logger: createLogger('test'),
  };
  return { ctx, saved };
}

const tool = (integration: IntegrationSpec, name: string) => {
  const t = integration.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return (ctx: ToolContext, args: unknown) => t.handler(ctx, t.args.parse(args));
};

describe('catalog', () => {
  it('has unique tool names, JSON schemas and sensible default trust levels', () => {
    const catalog = new IntegrationCatalog(INTEGRATIONS);
    const list = catalog.list();
    expect(list.map((i) => i.id)).toEqual(
      expect.arrayContaining([
        'core',
        'team',
        'http',
        'webhook',
        'zalo_oa',
        'telegram',
        'kiotviet',
        'haravan',
        'shopify',
        'shopee',
        'tiktok_shop',
        'misa',
        'google_calendar',
        'gmail',
      ]),
    );
    const kv = list.find((i) => i.id === 'kiotviet')!;
    expect(kv.verified).toBe(false);
    expect(kv.authFields).toMatchObject({ type: 'object', required: ['clientId', 'clientSecret'] });
    expect(kv.tools.find((t) => t.name === 'kiotviet_search_products')!.parameters).toMatchObject({
      type: 'object',
    });
    // Commerce: reads auto, writes off. Messaging/productivity writes: approve.
    const trust = (id: string, toolName: string) => {
      const i = catalog.get(id)!;
      return defaultTrust(i, i.tools.find((t) => t.name === toolName)!);
    };
    expect(trust('kiotviet', 'kiotviet_search_products')).toBe('auto');
    expect(trust('kiotviet', 'kiotviet_create_order')).toBe('off');
    expect(trust('haravan', 'haravan_add_order_note')).toBe('off');
    expect(trust('shopify', 'shopify_create_draft_order')).toBe('off');
    expect(trust('shopee', 'shopee_update_order')).toBe('off');
    expect(trust('telegram', 'telegram_send_message')).toBe('approve');
    expect(trust('gmail', 'gmail_send')).toBe('approve');
    expect(trust('gmail', 'gmail_search')).toBe('auto');
    expect(trust('webhook', 'send_webhook')).toBe('approve');
    expect(trust('team', 'delegate_task')).toBe('auto');
    // http_request: GET is a read, POST escalates to approve.
    const http = catalog.get('http')!;
    const req = http.tools[0]!;
    expect(defaultTrust(http, req, { method: 'GET' })).toBe('auto');
    expect(defaultTrust(http, req, { method: 'POST' })).toBe('approve');
    // Only our own code is marked verified.
    expect(
      list
        .filter((i) => i.verified)
        .map((i) => i.id)
        .sort(),
    ).toEqual(['core', 'http', 'team', 'webhook']);
  });
});

describe('Shopee Open Platform v2 signing', () => {
  // Expected values computed independently with `openssl dgst -sha256 -hmac`.
  it('signs shop-level, public and merchant-level requests', () => {
    expect(
      shopeeSign({
        partnerId: 2001887,
        partnerKey: 'partner-key-xyz',
        path: '/api/v2/order/get_order_detail',
        timestamp: 1655714431,
        accessToken: 'shop-access-token-abc',
        shopId: 601010,
      }),
    ).toBe('4eeab6dd5152ef5515fa3028ae012896a7567f41e272b0ad044ea3d46433a869');
    expect(
      shopeeSign({
        partnerId: '2001887',
        partnerKey: 'partner-key-xyz',
        path: '/api/v2/shop/auth_partner',
        timestamp: 1655714431,
      }),
    ).toBe('f69a5527377f6716e81279f670a7fbd3d7c3f1e5a622b277d44387de0392f39b');
    expect(
      shopeeSign({
        partnerId: 2001887,
        partnerKey: 'partner-key-xyz',
        path: '/api/v2/merchant/get_merchant_info',
        timestamp: 1655714431,
        accessToken: 'merchant-token',
        merchantId: 'M42',
      }),
    ).toBe('8fa8353d8b28b24c4e3222624d0573b5549d21be4fce634d23ab6be14286f4c1');
  });

  it('builds signed URLs and validates input', () => {
    const url = new URL(
      buildShopeeUrl({
        host: 'https://partner.test-stable.shopeemobile.com',
        partnerId: 2001887,
        partnerKey: 'partner-key-xyz',
        path: '/api/v2/order/get_order_detail',
        timestamp: 1655714431,
        accessToken: 'shop-access-token-abc',
        shopId: 601010,
        params: { order_sn_list: '2206SN' },
      }),
    );
    expect(url.origin).toBe('https://partner.test-stable.shopeemobile.com');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      partner_id: '2001887',
      timestamp: '1655714431',
      access_token: 'shop-access-token-abc',
      shop_id: '601010',
      sign: '4eeab6dd5152ef5515fa3028ae012896a7567f41e272b0ad044ea3d46433a869',
      order_sn_list: '2206SN',
    });
    expect(() => shopeeSign({ partnerId: 1, partnerKey: 'k', path: '/order', timestamp: 1 })).toThrow(
      /api\/v2/,
    );
    expect(() =>
      shopeeSign({ partnerId: 1, partnerKey: 'k', path: '/api/v2/x', timestamp: 1, shopId: 1 }),
    ).toThrow(/access token/);
  });

  it('stub tools fail with a clear, actionable error', async () => {
    const { ctx } = ctxFor(fakeFetch(() => ({})).fetch, {});
    await expect(tool(shopeeIntegration, 'shopee_get_order')(ctx, { orderSn: '123' })).rejects.toThrow(
      /Shopee is not available yet: .*partner app/,
    );
  });
});

describe('KiotViet', () => {
  beforeEach(() => clearKiotVietTokenCache());

  it('gets a client-credentials token, then searches products with Retailer + Bearer headers', async () => {
    const f = fakeFetch((call) => {
      if (call.url === 'https://id.kiotviet.vn/connect/token')
        return { access_token: 'kv-token-1', expires_in: 86400, token_type: 'Bearer' };
      return {
        total: 1,
        data: [
          {
            id: 7,
            code: 'AO-M',
            name: 'Áo thun',
            fullName: 'Áo thun - M',
            basePrice: 150000,
            inventories: [{ branchId: 1, branchName: 'Q1', onHand: 12, reserved: 2 }],
          },
        ],
      };
    });
    const { ctx } = ctxFor(
      f.fetch,
      { clientId: 'client-id-123', clientSecret: 'client-secret-456' },
      { retailer: 'shopan' },
    );
    const res = await tool(kiotvietIntegration, 'kiotviet_search_products')(ctx, {
      query: 'áo thun',
      pageSize: 5,
    });
    expect(res).toEqual({
      total: 1,
      products: [
        {
          id: 7,
          code: 'AO-M',
          name: 'Áo thun - M',
          category: null,
          price: 150000,
          unit: null,
          stock: [{ branch: 'Q1', onHand: 12, reserved: 2 }],
        },
      ],
    });
    const [tokenCall, apiCall] = f.calls;
    expect(tokenCall!.method).toBe('POST');
    expect(tokenCall!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(tokenCall!.body!))).toEqual({
      scopes: 'PublicApi.Access',
      grant_type: 'client_credentials',
      client_id: 'client-id-123',
      client_secret: 'client-secret-456',
    });
    const u = new URL(apiCall!.url);
    expect(u.origin + u.pathname).toBe('https://public.kiotapi.com/products');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      name: 'áo thun',
      pageSize: '5',
      includeInventory: 'true',
      orderBy: 'name',
    });
    expect(apiCall!.headers.retailer).toBe('shopan');
    expect(apiCall!.headers.authorization).toBe('Bearer kv-token-1');

    // Token is cached for subsequent calls.
    await tool(kiotvietIntegration, 'kiotviet_get_order')(ctx, { code: 'DH001' });
    expect(f.calls.filter((c) => c.url.includes('connect/token'))).toHaveLength(1);
    expect(f.calls[2]!.url).toBe('https://public.kiotapi.com/orders/code/DH001');
  });

  it('requires the retailer config and surfaces API errors', async () => {
    const f = fakeFetch((call) =>
      call.url.includes('token')
        ? { access_token: 't', expires_in: 60 }
        : jsonResponse({ responseStatus: { message: 'Không tìm thấy' } }, 404),
    );
    const missing = ctxFor(f.fetch, { clientId: 'client-id-123', clientSecret: 'client-secret-456' }, {});
    await expect(tool(kiotvietIntegration, 'kiotviet_get_order')(missing.ctx, { code: 'X' })).rejects.toThrow(
      /config.retailer/,
    );
    const { ctx } = ctxFor(
      f.fetch,
      { clientId: 'client-id-123', clientSecret: 'client-secret-456' },
      { retailer: 'shopan' },
    );
    await expect(tool(kiotvietIntegration, 'kiotviet_get_order')(ctx, { code: 'X' })).rejects.toThrow(
      /KiotViet API error 404: Không tìm thấy/,
    );
  });
});

describe('Haravan', () => {
  it('lists orders and filters by order number / phone locally', async () => {
    const f = fakeFetch(() => ({
      orders: [
        {
          id: 1,
          order_number: 1001,
          name: '#1001',
          total_price: '300000',
          financial_status: 'paid',
          customer: { first_name: 'An', last_name: 'Nguyễn', phone: '+84901234567' },
          line_items: [{ title: 'Áo', quantity: 2, price: '150000' }],
        },
        {
          id: 2,
          order_number: 1002,
          name: '#1002',
          total_price: '100000',
          customer: { phone: '0911111111' },
        },
      ],
    }));
    const { ctx } = ctxFor(f.fetch, { accessToken: 'hrv-token-123456' });
    const res = (await tool(haravanIntegration, 'haravan_find_orders')(ctx, { phone: '0901 234 567' })) as {
      orders: { name: string; customer: { name: string } }[];
    };
    expect(res.orders).toHaveLength(1);
    expect(res.orders[0]).toMatchObject({
      name: '#1001',
      total: 300000,
      customer: { name: 'Nguyễn An', phone: '+84901234567' },
    });
    expect(f.calls[0]!.url).toBe('https://apis.haravan.com/com/orders.json?status=any&limit=250');
    expect(f.calls[0]!.headers.authorization).toBe('Bearer hrv-token-123456');
    const byNumber = (await tool(haravanIntegration, 'haravan_find_orders')(ctx, {
      orderNumber: '#1002',
    })) as { orders: { name: string }[] };
    expect(byNumber.orders.map((o) => o.name)).toEqual(['#1002']);
  });

  it('builds product and customer search requests', async () => {
    const f = fakeFetch((call) =>
      call.url.includes('products')
        ? {
            products: [
              {
                id: 5,
                title: 'Áo thun',
                variants: [{ id: 9, title: 'M', price: '150000', inventory_quantity: 3 }],
              },
            ],
          }
        : { customers: [] },
    );
    const { ctx } = ctxFor(f.fetch, { accessToken: 'hrv-token-123456' });
    expect(await tool(haravanIntegration, 'haravan_search_products')(ctx, { query: 'áo thun' })).toEqual({
      products: [
        {
          id: 5,
          title: 'Áo thun',
          vendor: null,
          type: null,
          variants: [{ id: 9, title: 'M', sku: null, price: 150000, stock: 3 }],
        },
      ],
    });
    const productsUrl = new URL(f.calls[0]!.url);
    expect(productsUrl.pathname).toBe('/com/products.json');
    expect(Object.fromEntries(productsUrl.searchParams)).toEqual({ title: 'áo thun', limit: '10' });
    await tool(haravanIntegration, 'haravan_search_customers')(ctx, { query: '0901234567' });
    expect(f.calls[1]!.url).toBe(
      'https://apis.haravan.com/com/customers/search.json?query=0901234567&limit=5',
    );
  });
});

describe('Shopify', () => {
  it('validates the shop domain (no SSRF via config)', () => {
    expect(shopifyConfig.parse({ shopDomain: 'https://My-Store.myshopify.com/admin' }).shopDomain).toBe(
      'my-store.myshopify.com',
    );
    expect(shopifyConfig.safeParse({ shopDomain: 'evil.com' }).success).toBe(false);
    expect(shopifyConfig.safeParse({ shopDomain: '169.254.169.254' }).success).toBe(false);
  });

  it('queries orders via the Admin GraphQL API and maps the result', async () => {
    const f = fakeFetch(() => ({
      data: {
        orders: {
          edges: [
            {
              node: {
                id: 'gid://shopify/Order/1',
                name: '#1001',
                createdAt: '2026-10-20T10:00:00Z',
                displayFinancialStatus: 'PAID',
                displayFulfillmentStatus: 'FULFILLED',
                cancelledAt: null,
                totalPriceSet: { shopMoney: { amount: '45.00', currencyCode: 'USD' } },
                customer: { displayName: 'An Nguyen', email: 'an@example.com', phone: null },
                lineItems: {
                  edges: [
                    {
                      node: {
                        title: 'T-shirt',
                        quantity: 1,
                        sku: 'TS-M',
                        originalUnitPriceSet: { shopMoney: { amount: '45.00', currencyCode: 'USD' } },
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    }));
    const { ctx } = ctxFor(
      f.fetch,
      { accessToken: 'shpat_abcdef123456' },
      shopifyConfig.parse({ shopDomain: 'my-store.myshopify.com' }),
    );
    const res = (await tool(shopifyIntegration, 'shopify_find_orders')(ctx, { query: 'name:#1001' })) as {
      orders: unknown[];
    };
    expect(res.orders[0]).toMatchObject({
      name: '#1001',
      financialStatus: 'PAID',
      total: '45.00 USD',
      customer: { name: 'An Nguyen' },
      items: [{ sku: 'TS-M' }],
    });
    const call = f.calls[0]!;
    expect(call.url).toBe('https://my-store.myshopify.com/admin/api/2025-10/graphql.json');
    expect(call.headers['x-shopify-access-token']).toBe('shpat_abcdef123456');
    const body = call.json<{ query: string; variables: unknown }>();
    expect(body.query).toContain('orders(first: $first, query: $query');
    expect(body.variables).toEqual({ query: 'name:#1001', first: 5 });
  });

  it('reports GraphQL errors', async () => {
    const f = fakeFetch(() => ({ errors: [{ message: 'Access denied for orders field.' }] }));
    const { ctx } = ctxFor(
      f.fetch,
      { accessToken: 'shpat_abcdef123456' },
      { shopDomain: 'my-store.myshopify.com', apiVersion: '2025-10' },
    );
    await expect(tool(shopifyIntegration, 'shopify_find_orders')(ctx, { query: 'x' })).rejects.toThrow(
      /Access denied/,
    );
  });
});

describe('Google Calendar & Gmail', () => {
  it('lists events with a default 7-day window and creates events', async () => {
    const f = fakeFetch((call) =>
      call.method === 'GET'
        ? {
            items: [
              {
                id: 'e1',
                summary: 'Tư vấn',
                start: { dateTime: '2026-10-26T09:00:00+07:00' },
                end: { dateTime: '2026-10-26T10:00:00+07:00' },
              },
            ],
          }
        : {
            id: 'e2',
            summary: 'Lịch hẹn',
            start: { dateTime: '2026-10-27T14:00:00+07:00' },
            end: { dateTime: '2026-10-27T15:00:00+07:00' },
            htmlLink: 'https://calendar.google.com/e2',
          },
    );
    const { ctx } = ctxFor(
      f.fetch,
      { accessToken: 'ya29.token-abcdef' },
      { calendarId: 'primary', timezone: 'Asia/Ho_Chi_Minh' },
    );
    const list = (await tool(googleCalendarIntegration, 'gcal_list_events')(ctx, {})) as {
      events: { summary: string }[];
    };
    expect(list.events[0]!.summary).toBe('Tư vấn');
    const u = new URL(f.calls[0]!.url);
    expect(u.pathname).toBe('/calendar/v3/calendars/primary/events');
    expect(u.searchParams.get('timeMin')).toBe('2026-10-25T03:00:00.000Z');
    expect(u.searchParams.get('timeMax')).toBe('2026-11-01T03:00:00.000Z');
    expect(u.searchParams.get('singleEvents')).toBe('true');
    expect(f.calls[0]!.headers.authorization).toBe('Bearer ya29.token-abcdef');

    await tool(googleCalendarIntegration, 'gcal_create_event')(ctx, {
      summary: 'Lịch hẹn',
      start: '2026-10-27T14:00:00+07:00',
      end: '2026-10-27T15:00:00+07:00',
      attendees: ['khach@example.com'],
    });
    expect(f.calls[1]!.method).toBe('POST');
    expect(f.calls[1]!.json()).toEqual({
      summary: 'Lịch hẹn',
      start: { dateTime: '2026-10-27T14:00:00+07:00', timeZone: 'Asia/Ho_Chi_Minh' },
      end: { dateTime: '2026-10-27T15:00:00+07:00', timeZone: 'Asia/Ho_Chi_Minh' },
      attendees: [{ email: 'khach@example.com' }],
    });
  });

  it('refreshes an expired access token once and persists it', async () => {
    let n = 0;
    const f = fakeFetch((call) => {
      if (call.url === 'https://oauth2.googleapis.com/token')
        return { access_token: 'ya29.fresh-token', expires_in: 3599 };
      n++;
      if (call.headers.authorization === 'Bearer ya29.expired-token')
        return jsonResponse({ error: { message: 'Invalid Credentials' } }, 401);
      return { items: [] };
    });
    const { ctx, saved } = ctxFor(f.fetch, {
      accessToken: 'ya29.expired-token',
      refreshToken: '1//refresh-token',
      clientId: 'client-id.apps',
      clientSecret: 'secret-xyz',
    });
    expect(await tool(googleCalendarIntegration, 'gcal_list_events')(ctx, {})).toEqual({ events: [] });
    expect(n).toBe(2);
    expect(saved).toEqual([{ accessToken: 'ya29.fresh-token' }]);
    expect(Object.fromEntries(new URLSearchParams(f.calls[1]!.body!))).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: '1//refresh-token',
    });
  });

  it('builds RFC 2822 messages with UTF-8 subjects and rejects header injection', async () => {
    const raw = buildRawEmail({
      to: ['khach@example.com'],
      subject: 'Xác nhận đơn hàng #1001',
      body: 'Cảm ơn bạn đã mua hàng!',
    });
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    expect(decoded).toContain('To: khach@example.com\r\n');
    expect(decoded).toContain(
      `Subject: =?UTF-8?B?${Buffer.from('Xác nhận đơn hàng #1001').toString('base64')}?=`,
    );
    expect(decoded).toContain('Content-Type: text/plain; charset="UTF-8"');
    const body = decoded.split('\r\n\r\n')[1]!;
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe('Cảm ơn bạn đã mua hàng!');
    expect(() => buildRawEmail({ to: ['a@b.co'], subject: 'hi\r\nBcc: victim@x.com', body: 'x' })).toThrow(
      /line breaks/,
    );

    const f = fakeFetch(() => ({ id: 'm1', threadId: 't1' }));
    const { ctx } = ctxFor(f.fetch, { accessToken: 'ya29.token-abcdef' });
    expect(
      await tool(gmailIntegration, 'gmail_send')(ctx, {
        to: ['khach@example.com'],
        subject: 'Hi',
        body: 'Hello',
      }),
    ).toEqual({ sent: true, id: 'm1', threadId: 't1' });
    expect(f.calls[0]!.url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(typeof f.calls[0]!.json<{ raw: string }>().raw).toBe('string');
  });

  it('searches Gmail and extracts metadata headers', async () => {
    const f = fakeFetch((call) =>
      call.url.includes('/messages?')
        ? { messages: [{ id: 'm1', threadId: 't1' }] }
        : {
            id: 'm1',
            threadId: 't1',
            snippet: 'Đơn hàng của bạn…',
            payload: {
              headers: [
                { name: 'Subject', value: 'Đơn hàng' },
                { name: 'From', value: 'shop@example.com' },
                { name: 'Date', value: 'Sat, 25 Oct 2026' },
              ],
            },
          },
    );
    const { ctx } = ctxFor(f.fetch, { accessToken: 'ya29.token-abcdef' });
    expect(await tool(gmailIntegration, 'gmail_search')(ctx, { query: 'from:shop@example.com' })).toEqual({
      messages: [
        {
          id: 'm1',
          threadId: 't1',
          subject: 'Đơn hàng',
          from: 'shop@example.com',
          date: 'Sat, 25 Oct 2026',
          snippet: 'Đơn hàng của bạn…',
        },
      ],
    });
    expect(f.calls[0]!.url).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from%3Ashop%40example.com&maxResults=5',
    );
  });
});

describe('Zalo OA', () => {
  it('sends a CS text message with the access_token header', async () => {
    const f = fakeFetch(() => ({
      error: 0,
      message: 'Success',
      data: { message_id: 'mid-1', user_id: '2468' },
    }));
    const { ctx } = ctxFor(f.fetch, { accessToken: 'zalo-access-token-1' });
    expect(
      await tool(zaloIntegration, 'zalo_send_message')(ctx, { userId: '2468', text: 'Chào bạn' }),
    ).toEqual({ messageIds: ['mid-1'] });
    expect(f.calls[0]!.url).toBe('https://openapi.zalo.me/v3.0/oa/message/cs');
    expect(f.calls[0]!.headers.access_token).toBe('zalo-access-token-1');
    expect(f.calls[0]!.json()).toEqual({ recipient: { user_id: '2468' }, message: { text: 'Chào bạn' } });
  });

  it('refreshes an invalid access token (-216) and retries', async () => {
    const f = fakeFetch((call) => {
      if (call.url.startsWith('https://oauth.zaloapp.com'))
        return { access_token: 'zalo-new-token', refresh_token: 'zalo-new-refresh', expires_in: '90000' };
      return call.headers.access_token === 'zalo-old-token'
        ? { error: -216, message: 'Access token is invalid' }
        : { error: 0, data: { message_id: 'mid-2' } };
    });
    const { ctx, saved } = ctxFor(f.fetch, {
      accessToken: 'zalo-old-token',
      refreshToken: 'zalo-refresh-1',
      appId: '1234567890',
      appSecret: 'app-secret-key',
    });
    expect(await tool(zaloIntegration, 'zalo_send_message')(ctx, { userId: '2468', text: 'Hi' })).toEqual({
      messageIds: ['mid-2'],
    });
    expect(saved).toEqual([{ accessToken: 'zalo-new-token', refreshToken: 'zalo-new-refresh' }]);
    const refresh = f.calls[1]!;
    expect(refresh.headers.secret_key).toBe('app-secret-key');
    expect(Object.fromEntries(new URLSearchParams(refresh.body!))).toEqual({
      refresh_token: 'zalo-refresh-1',
      app_id: '1234567890',
      grant_type: 'refresh_token',
    });
  });

  it('verifies webhook signatures and parses user_send_text events', () => {
    const raw = JSON.stringify({
      app_id: '1234567890',
      event_name: 'user_send_text',
      timestamp: '1761361200000',
      sender: { id: '2468' },
      recipient: { id: '1357' },
      message: { text: 'Shop ơi', msg_id: 'msg-1' },
    });
    const sig = zaloSignature('1234567890', raw, '1761361200000', 'oa-secret-key');
    expect(sig).toMatch(/^mac=[0-9a-f]{64}$/);
    expect(
      verifyZaloSignature({
        appId: '1234567890',
        rawBody: raw,
        timestamp: '1761361200000',
        oaSecretKey: 'oa-secret-key',
        header: sig,
      }),
    ).toBe(true);
    expect(
      verifyZaloSignature({
        appId: '1234567890',
        rawBody: `${raw} `,
        timestamp: '1761361200000',
        oaSecretKey: 'oa-secret-key',
        header: sig,
      }),
    ).toBe(false);
    expect(
      verifyZaloSignature({
        appId: '1234567890',
        rawBody: raw,
        timestamp: '1761361200000',
        oaSecretKey: 'oa-secret-key',
        header: undefined,
      }),
    ).toBe(false);
    expect(parseZaloEvent(JSON.parse(raw))).toMatchObject({
      eventId: 'msg-1',
      externalUserId: '2468',
      replyTo: '2468',
      text: 'Shop ơi',
    });
    expect(parseZaloEvent({ event_name: 'follow', sender: { id: '1' } })).toBeNull();
  });
});

describe('Telegram', () => {
  it('sends messages, splitting long text', async () => {
    const f = fakeFetch(() => ({ ok: true, result: { message_id: 10 } }));
    const { ctx } = ctxFor(f.fetch, { botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij' });
    const long = `${'a'.repeat(4000)}\n\n${'b'.repeat(500)}`;
    expect(
      await tool(telegramIntegration, 'telegram_send_message')(ctx, { chatId: '42', text: long }),
    ).toEqual({ messageIds: [10, 10] });
    expect(f.calls[0]!.url).toBe(
      'https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij/sendMessage',
    );
    expect(f.calls[0]!.json<{ chat_id: string; text: string }>().text).toBe('a'.repeat(4000));
    expect(f.calls[1]!.json<{ text: string }>().text).toBe('b'.repeat(500));
    expect(splitMessage('x'.repeat(10), 4)).toEqual(['xxxx', 'xxxx', 'xx']);
  });

  it('parses updates', () => {
    expect(
      parseTelegramUpdate({
        update_id: 5,
        message: {
          message_id: 1,
          chat: { id: 42, type: 'private' },
          from: { id: 7, first_name: 'An', last_name: 'Nguyễn' },
          text: 'hi',
        },
      }),
    ).toEqual({
      eventId: '5',
      externalUserId: '7',
      replyTo: '42',
      text: 'hi',
      userName: 'An Nguyễn',
      isBot: false,
    });
    expect(parseTelegramUpdate({ update_id: 6, edited_message: {} })).toBeNull();
  });
});

describe('webhook signing', () => {
  it('signs timestamp.body with HMAC-SHA256', () => {
    const expected = createHmac('sha256', 'whsec-123456').update('1761361200.{"a":1}').digest('hex');
    expect(signWebhook('whsec-123456', '1761361200', '{"a":1}')).toBe(`sha256=${expected}`);
  });
});
