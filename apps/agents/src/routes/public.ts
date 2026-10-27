import { RateLimiter } from '@minh/core';
import { AppError, parseJson } from '@minh/shared';
import { type Context, Hono } from 'hono';
import { WIDGET_JS } from '../channels/widget';
import type { ChannelRow } from '../db/schema';
import type { Platform } from '../platform';
import { publicChatSchema } from './schemas';

/** Client IP: first `X-Forwarded-For` hop when behind a trusted proxy, else the socket address. */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (xff) return xff;
    const real = c.req.header('x-real-ip')?.trim();
    if (real) return real;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

function corsOrigin(channel: ChannelRow, origin: string | undefined): string | null {
  const allowed = (channel.config.allowedOrigins as string[] | undefined) ?? [];
  if (!allowed.length) return '*';
  if (!origin) return null;
  const o = origin.replace(/\/+$/, '').toLowerCase();
  return allowed.some((a) => a.replace(/\/+$/, '').toLowerCase() === o) ? origin : null;
}

/** Unauthenticated endpoints: health, widget, public web chat, channel webhooks (each verified on its own). */
export function publicRoutes(p: Platform) {
  const r = new Hono();
  const perIp = new RateLimiter();
  const perWidget = new RateLimiter();

  r.get('/health', (c) => c.json({ ok: true, service: 'agents', driver: p.driver.name }));

  r.get('/widget.js', (c) => {
    c.header('content-type', 'application/javascript; charset=utf-8');
    c.header('cache-control', 'public, max-age=3600');
    c.header('x-content-type-options', 'nosniff');
    return c.body(WIDGET_JS);
  });

  const withCors = async (c: Context, token: string) => {
    const { channel, agent } = await p.channels.findWeb(token);
    const allow = corsOrigin(channel, c.req.header('origin'));
    if (allow === null)
      throw new AppError('forbidden', 'This website is not allowed to use this chat widget');
    c.header('access-control-allow-origin', allow);
    c.header('vary', 'Origin');
    return { channel, agent };
  };

  r.options('/public/chat/:token', async (c) => {
    await withCors(c, c.req.param('token'));
    c.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    c.header('access-control-allow-headers', 'content-type');
    c.header('access-control-max-age', '600');
    return c.body(null, 204);
  });

  r.get('/public/chat/:token', async (c) => {
    const { channel, agent } = await withCors(c, c.req.param('token'));
    return c.json({
      agentName: agent.name,
      avatarUrl: agent.avatarUrl,
      title: (channel.config.title as string | undefined) ?? agent.name,
      greeting: (channel.config.greeting as string | undefined) ?? null,
      color: (channel.config.color as string | undefined) ?? null,
      online: agent.status === 'running',
    });
  });

  r.post('/public/chat/:token', async (c) => {
    const token = c.req.param('token');
    // Rate-limit before touching the database.
    const ip = clientIp(c, p.config.trustProxy);
    const rpm = p.config.publicChatRpm;
    if (!perIp.take(`${token}:${ip}`, rpm))
      throw new AppError('rate_limited', 'Too many messages. Please wait a minute.');
    if (!perWidget.take(token, rpm * 30)) {
      throw new AppError('rate_limited', 'This chat is busy right now. Please try again shortly.');
    }
    await withCors(c, token);
    const body = await parseJson(c, publicChatSchema);
    return c.json(await p.channels.handleWebChat(token, body));
  });

  r.post('/channels/telegram/:agentId', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new AppError('bad_request', 'Body must be JSON');
    }
    const res = await p.channels.handleTelegram(
      c.req.param('agentId'),
      c.req.header('x-telegram-bot-api-secret-token'),
      body,
    );
    return c.json({ ok: true, ...res });
  });

  r.post('/channels/zalo/:agentId', async (c) => {
    const raw = await c.req.text();
    const res = await p.channels.handleZalo(c.req.param('agentId'), raw, c.req.header('x-zevent-signature'));
    return c.json({ ok: true, ...res });
  });

  return r;
}
