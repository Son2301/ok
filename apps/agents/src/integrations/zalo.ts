import { AppError } from '@ok/shared';
import { z } from 'zod';
import { safeEqualStr, sha256Hex } from '../lib/crypto';
import { type FetchLike, requestJson } from '../lib/http';
import { type InboundMessage, splitMessage } from './telegram';
import { defineIntegration, type ToolContext, toolBuilder } from './types';

/**
 * Zalo Official Account (OA) Open API v3 + webhooks.
 * Docs: https://developers.zalo.me/docs/official-account — verified: false
 * (implemented from public docs, fixture-tested only).
 *
 * - Send:   POST https://openapi.zalo.me/v3.0/oa/message/cs   header `access_token`
 * - Refresh POST https://oauth.zaloapp.com/v4/oa/access_token  header `secret_key`
 * - Webhook signature: `X-ZEvent-Signature: mac=sha256(appId + rawBody + timestamp + oaSecretKey)`
 */
const OPENAPI = 'https://openapi.zalo.me';
const OAUTH = 'https://oauth.zaloapp.com';
export const ZALO_MAX_TEXT = 2000;
/** Error codes Zalo returns for an invalid/expired access token. */
const TOKEN_ERRORS = new Set([-216, -124, -14002]);

export const zaloAuth = z.object({
  accessToken: z.string().min(10).describe('OA access token'),
  refreshToken: z.string().min(10).optional().describe('OA refresh token (enables automatic token refresh)'),
  appId: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe('Zalo app id (needed for refresh and webhook verification)'),
  appSecret: z.string().min(8).optional().describe('Zalo app secret key (needed for token refresh)'),
  oaSecretKey: z.string().min(8).optional().describe('OA secret key used to verify webhook signatures'),
});
type ZaloCreds = z.output<typeof zaloAuth>;

interface ZaloResult<T = unknown> {
  error: number;
  message?: string;
  data?: T;
}

export class ZaloApiError extends AppError {
  constructor(
    readonly zaloCode: number,
    message: string,
  ) {
    super('upstream_error', `Zalo OA error ${zaloCode}: ${message}`);
  }
}

export const zaloApi = {
  async sendTextOnce(
    fetchFn: FetchLike,
    accessToken: string,
    userId: string,
    text: string,
    signal?: AbortSignal,
  ) {
    const res = await requestJson<ZaloResult<{ message_id: string; user_id: string }>>(
      fetchFn,
      `${OPENAPI}/v3.0/oa/message/cs`,
      {
        method: 'POST',
        headers: { access_token: accessToken },
        body: { recipient: { user_id: userId }, message: { text } },
        service: 'Zalo OA',
        signal,
      },
    );
    if (res.error !== 0) throw new ZaloApiError(res.error, res.message ?? 'unknown error');
    return res.data!;
  },

  async refreshAccessToken(
    fetchFn: FetchLike,
    creds: { appId: string; appSecret: string; refreshToken: string },
  ) {
    const res = await requestJson<{
      access_token?: string;
      refresh_token?: string;
      expires_in?: string | number;
      error?: number;
      message?: string;
    }>(fetchFn, `${OAUTH}/v4/oa/access_token`, {
      method: 'POST',
      headers: { secret_key: creds.appSecret },
      body: new URLSearchParams({
        refresh_token: creds.refreshToken,
        app_id: creds.appId,
        grant_type: 'refresh_token',
      }),
      service: 'Zalo OAuth',
    });
    if (!res.access_token) throw new ZaloApiError(res.error ?? -1, res.message ?? 'token refresh failed');
    return {
      accessToken: res.access_token,
      refreshToken: res.refresh_token ?? creds.refreshToken,
      expiresIn: Number(res.expires_in ?? 0),
    };
  },

  /**
   * Send text (split into ≤2000-char parts), refreshing the access token once
   * if Zalo reports it invalid/expired and refresh credentials are available.
   */
  async sendText(
    fetchFn: FetchLike,
    creds: ZaloCreds,
    userId: string,
    text: string,
    opts: { signal?: AbortSignal; saveCredentials?: (patch: Partial<ZaloCreds>) => Promise<void> } = {},
  ) {
    let token = creds.accessToken;
    const ids: string[] = [];
    for (const part of splitMessage(text, ZALO_MAX_TEXT)) {
      try {
        ids.push((await zaloApi.sendTextOnce(fetchFn, token, userId, part, opts.signal)).message_id);
      } catch (err) {
        const canRefresh =
          err instanceof ZaloApiError &&
          TOKEN_ERRORS.has(err.zaloCode) &&
          creds.refreshToken &&
          creds.appId &&
          creds.appSecret;
        if (!canRefresh) throw err;
        const fresh = await zaloApi.refreshAccessToken(fetchFn, {
          appId: creds.appId!,
          appSecret: creds.appSecret!,
          refreshToken: creds.refreshToken!,
        });
        token = fresh.accessToken;
        await opts.saveCredentials?.({ accessToken: fresh.accessToken, refreshToken: fresh.refreshToken });
        ids.push((await zaloApi.sendTextOnce(fetchFn, token, userId, part, opts.signal)).message_id);
      }
    }
    return { messageIds: ids };
  },
};

/** Expected `X-ZEvent-Signature` value for a webhook body. */
export function zaloSignature(
  appId: string,
  rawBody: string,
  timestamp: string,
  oaSecretKey: string,
): string {
  return `mac=${sha256Hex(`${appId}${rawBody}${timestamp}${oaSecretKey}`)}`;
}

export function verifyZaloSignature(input: {
  appId: string;
  rawBody: string;
  timestamp: string;
  oaSecretKey: string;
  header: string | undefined;
}): boolean {
  if (!input.header) return false;
  const expected = zaloSignature(input.appId, input.rawBody, input.timestamp, input.oaSecretKey);
  const got = input.header.trim().startsWith('mac=') ? input.header.trim() : `mac=${input.header.trim()}`;
  return safeEqualStr(got.toLowerCase(), expected);
}

const zaloEventSchema = z
  .object({
    app_id: z.union([z.string(), z.number()]).optional(),
    event_name: z.string(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    sender: z.object({ id: z.union([z.string(), z.number()]) }).optional(),
    recipient: z.object({ id: z.union([z.string(), z.number()]) }).optional(),
    user_id_by_app: z.union([z.string(), z.number()]).optional(),
    message: z
      .object({ text: z.string().optional(), msg_id: z.union([z.string(), z.number()]).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** Parse a Zalo OA webhook event. Only `user_send_text` produces a message. */
export function parseZaloEvent(
  body: unknown,
): (InboundMessage & { timestamp: string; appId?: string }) | null {
  const parsed = zaloEventSchema.safeParse(body);
  if (!parsed.success) return null;
  const e = parsed.data;
  if (e.event_name !== 'user_send_text' || !e.sender) return null;
  const senderId = String(e.sender.id);
  return {
    eventId: String(e.message?.msg_id ?? `${senderId}:${e.timestamp ?? ''}`),
    externalUserId: senderId,
    replyTo: senderId,
    text: e.message?.text ?? null,
    timestamp: String(e.timestamp ?? ''),
    ...(e.app_id !== undefined ? { appId: String(e.app_id) } : {}),
  };
}

const tool = toolBuilder<ToolContext<ZaloCreds, Record<string, never>>>();

export const zaloIntegration = defineIntegration({
  id: 'zalo_oa',
  name: 'Zalo Official Account',
  category: 'messaging',
  description:
    'Chat with customers on your Zalo OA (inbound webhook channel) and send consultation (CS) messages.',
  verified: false,
  status: 'available',
  docsUrl: 'https://developers.zalo.me/docs/official-account',
  channel: 'zalo',
  authSchema: zaloAuth,
  tools: [
    tool({
      name: 'zalo_send_message',
      description:
        'Send a Zalo OA consultation text message to a follower who has interacted with the OA (user id).',
      args: z.object({ userId: z.string().regex(/^\d+$/), text: z.string().min(1).max(10_000) }),
      risk: 'external_write',
      handler: async (ctx, args) =>
        zaloApi.sendText(ctx.fetch, ctx.credentials, args.userId, args.text, {
          signal: ctx.signal,
          saveCredentials: ctx.saveCredentials,
        }),
    }),
  ],
});
