import { AppError } from '@ok/shared';
import { z } from 'zod';
import { type FetchLike, requestJson } from '../lib/http';
import { defineIntegration, type ToolContext, toolBuilder } from './types';

/**
 * Telegram Bot API (https://core.telegram.org/bots/api). verified: false —
 * implemented from public docs, unit-tested with fixtures only.
 */
const BASE = 'https://api.telegram.org';
export const TELEGRAM_MAX_TEXT = 4096;

export const telegramAuth = z.object({
  botToken: z
    .string()
    .regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/, 'expected a bot token from @BotFather, like 123456:ABC-DEF…')
    .describe('Bot token from @BotFather'),
});

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

/** Split text into Telegram-sized messages, preferring paragraph/line boundaries. */
export function splitMessage(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

async function call<T>(
  fetchFn: FetchLike,
  token: string,
  method: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let res: TgResponse<T>;
  try {
    res = await requestJson<TgResponse<T>>(fetchFn, `${BASE}/bot${token}/${method}`, {
      method: 'POST',
      body,
      service: 'Telegram',
      signal,
    });
  } catch (err) {
    // Telegram puts a useful description in 4xx bodies.
    const body = (err as { body?: TgResponse<T> }).body;
    if (body?.description)
      throw new AppError('upstream_error', `Telegram ${method} failed: ${body.description}`);
    throw err;
  }
  if (!res.ok)
    throw new AppError('upstream_error', `Telegram ${method} failed: ${res.description ?? 'unknown error'}`);
  return res.result as T;
}

export const telegramApi = {
  async sendMessage(
    fetchFn: FetchLike,
    token: string,
    chatId: string | number,
    text: string,
    signal?: AbortSignal,
  ) {
    const ids: number[] = [];
    for (const part of splitMessage(text, TELEGRAM_MAX_TEXT)) {
      const msg = await call<{ message_id: number }>(
        fetchFn,
        token,
        'sendMessage',
        { chat_id: chatId, text: part },
        signal,
      );
      ids.push(msg.message_id);
    }
    return { messageIds: ids };
  },
  /** Register our webhook; Telegram echoes `secret_token` in `X-Telegram-Bot-Api-Secret-Token`. */
  setWebhook(fetchFn: FetchLike, token: string, url: string, secretToken: string) {
    return call<boolean>(fetchFn, token, 'setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message'],
      drop_pending_updates: false,
    });
  },
  getMe(fetchFn: FetchLike, token: string) {
    return call<{ id: number; username: string; first_name: string }>(fetchFn, token, 'getMe', {});
  },
};

const updateSchema = z
  .object({
    update_id: z.number(),
    message: z
      .object({
        message_id: z.number(),
        date: z.number().optional(),
        text: z.string().optional(),
        caption: z.string().optional(),
        chat: z.object({
          id: z.number(),
          type: z.string(),
          title: z.string().optional(),
          username: z.string().optional(),
        }),
        from: z
          .object({
            id: z.number(),
            is_bot: z.boolean().optional(),
            first_name: z.string().optional(),
            last_name: z.string().optional(),
            username: z.string().optional(),
          })
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface InboundMessage {
  eventId: string;
  externalUserId: string;
  /** Where the reply goes (Telegram chat id / Zalo user id). */
  replyTo: string;
  text: string | null;
  userName?: string;
  isBot?: boolean;
}

/** Parse a Telegram Update into an inbound message (null for updates we ignore). */
export function parseTelegramUpdate(body: unknown): InboundMessage | null {
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success || !parsed.data.message) return null;
  const m = parsed.data.message;
  const from = m.from;
  const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ') || from?.username;
  return {
    eventId: String(parsed.data.update_id),
    externalUserId: String(from?.id ?? m.chat.id),
    replyTo: String(m.chat.id),
    text: m.text ?? m.caption ?? null,
    ...(name ? { userName: name } : {}),
    isBot: from?.is_bot ?? false,
  };
}

const tool = toolBuilder<ToolContext<z.output<typeof telegramAuth>, Record<string, never>>>();

export const telegramIntegration = defineIntegration({
  id: 'telegram',
  name: 'Telegram Bot',
  category: 'messaging',
  description:
    'Chat with customers through your Telegram bot (inbound webhook channel) and send proactive messages.',
  verified: false,
  status: 'available',
  docsUrl: 'https://core.telegram.org/bots/api',
  channel: 'telegram',
  authSchema: telegramAuth,
  tools: [
    tool({
      name: 'telegram_send_message',
      description: 'Send a Telegram message to a chat that has talked to the bot before (chat id).',
      args: z.object({
        chatId: z.union([z.string().regex(/^-?\d+$/), z.number().int()]),
        text: z.string().min(1).max(20_000),
      }),
      risk: 'external_write',
      handler: async (ctx, args) =>
        telegramApi.sendMessage(ctx.fetch, ctx.credentials.botToken, args.chatId, args.text, ctx.signal),
    }),
  ],
});
