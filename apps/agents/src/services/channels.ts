import type { Db } from '@minh/db';
import { AppError, type Logger, newId } from '@minh/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AgentsConfig } from '../config';
import { type AgentRow, type ChannelRow, type ChannelType, channels, inboundEvents } from '../db/schema';
import type { IntegrationCatalog } from '../integrations';
import {
  type InboundMessage,
  parseTelegramUpdate,
  telegramApi,
  telegramAuth,
} from '../integrations/telegram';
import { parseZaloEvent, verifyZaloSignature, zaloApi, zaloAuth } from '../integrations/zalo';
import type { BackgroundTasks } from '../lib/async';
import { generateToken, safeEqualStr, sha256Hex } from '../lib/crypto';
import type { FetchLike } from '../lib/http';
import type { Clock } from '../lib/time';
import type { AgentService } from './agents';
import type { Channel, ConversationService, SendResult } from './conversations';
import type { CredentialStore } from './credentials';
import type { EventLog } from './events';

export const webChannelConfig = z.object({
  title: z.string().max(80).optional(),
  greeting: z.string().max(500).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  /** Origins allowed to embed the widget (CORS). Empty = any origin. */
  allowedOrigins: z.array(z.string().url().max(200)).max(50).default([]),
});

export function serializeChannel(c: ChannelRow, publicUrl: string) {
  return {
    id: c.id,
    type: c.type,
    enabled: c.enabled,
    config: c.config,
    ...(c.type === 'telegram' ? { webhookUrl: `${publicUrl}/channels/telegram/${c.agentId}` } : {}),
    ...(c.type === 'zalo' ? { webhookUrl: `${publicUrl}/channels/zalo/${c.agentId}` } : {}),
    ...(c.type === 'web'
      ? {
          publicToken: c.publicToken,
          chatUrl: `${publicUrl}/public/chat/${c.publicToken}`,
          embed: `<script src="${publicUrl}/widget.js" data-token="${c.publicToken}" async></script>`,
        }
      : {}),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

const NON_TEXT_REPLY = {
  vi: 'Xin lỗi, hiện tại mình chỉ đọc được tin nhắn văn bản. Bạn vui lòng gõ nội dung cần hỗ trợ nhé.',
  en: 'Sorry, I can only read text messages for now. Please type your question.',
};

/**
 * Inbound channels (Telegram, Zalo OA webhooks; public web chat) and their
 * replies. Webhooks are verified (secret token / signature), deduplicated,
 * acknowledged immediately and processed in the background. Messaging
 * channels honour the agent's inbound policy (open | allowlist), and the
 * first reply of each conversation carries the AI disclosure.
 */
export class ChannelService {
  constructor(
    private readonly deps: {
      db: Db;
      agents: AgentService;
      conversations: ConversationService;
      credentials: CredentialStore;
      catalog: IntegrationCatalog;
      events: EventLog;
      config: AgentsConfig;
      fetch: FetchLike;
      clock: Clock;
      bg: BackgroundTasks;
      logger: Logger;
    },
  ) {}

  list(agentId: string) {
    return this.deps.db.select().from(channels).where(eq(channels.agentId, agentId));
  }

  async find(agentId: string, type: ChannelType): Promise<ChannelRow | null> {
    const [row] = await this.deps.db
      .select()
      .from(channels)
      .where(and(eq(channels.agentId, agentId), eq(channels.type, type)));
    return row ?? null;
  }

  /**
   * Enable/configure a channel. Returns secrets generated now (Telegram secret
   * token) once; only their hash is stored.
   */
  async configure(
    agent: AgentRow,
    type: ChannelType,
    input: { enabled?: boolean; config?: Record<string, unknown>; registerWebhook?: boolean },
  ) {
    const existing = await this.find(agent.id, type);
    const now = this.deps.clock.now();
    let config: Record<string, unknown> = existing?.config ?? {};
    let secretHash = existing?.secretHash ?? null;
    let publicToken = existing?.publicToken ?? null;
    const once: Record<string, string> = {};

    if (type === 'web') {
      if (input.config) config = webChannelConfig.parse(input.config);
      publicToken ??= generateToken('pub', 18);
    } else if (type === 'telegram') {
      if (!(await this.deps.credentials.get(agent, 'telegram'))) {
        throw new AppError(
          'bad_request',
          'Connect the Telegram integration first: PUT /v1/agents/:id/integrations/telegram with { credentials: { botToken } }',
        );
      }
      if (!secretHash) {
        const secret = generateToken('tg', 24).replace(/[^A-Za-z0-9_-]/g, '');
        secretHash = sha256Hex(secret);
        once.secretToken = secret;
      }
    } else if (type === 'zalo') {
      const creds = zaloAuth.safeParse((await this.deps.credentials.get(agent, 'zalo_oa')) ?? {});
      if (!creds.success)
        throw new AppError(
          'bad_request',
          'Connect the Zalo OA integration first: PUT /v1/agents/:id/integrations/zalo_oa',
        );
      if (!creds.data.oaSecretKey || !creds.data.appId) {
        throw new AppError(
          'bad_request',
          'Zalo webhooks are verified with the OA secret key: add credentials.appId and credentials.oaSecretKey to the zalo_oa integration',
        );
      }
    }

    const [row] = await this.deps.db
      .insert(channels)
      .values({
        id: newId('chn'),
        orgId: agent.orgId,
        agentId: agent.id,
        type,
        enabled: input.enabled ?? true,
        publicToken,
        secretHash,
        config,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [channels.agentId, channels.type],
        set: { enabled: input.enabled ?? true, publicToken, secretHash, config, updatedAt: now },
      })
      .returning();

    let webhook: { registered: boolean; error?: string } | undefined;
    if (type === 'telegram' && input.registerWebhook) {
      if (!once.secretToken) {
        // Re-registering needs the plaintext secret, which we do not keep: rotate it.
        const secret = generateToken('tg', 24).replace(/[^A-Za-z0-9_-]/g, '');
        await this.deps.db
          .update(channels)
          .set({ secretHash: sha256Hex(secret) })
          .where(eq(channels.id, row!.id));
        once.secretToken = secret;
      }
      const creds = telegramAuth.parse(await this.deps.credentials.get(agent, 'telegram'));
      try {
        await telegramApi.setWebhook(
          this.deps.fetch,
          creds.botToken,
          `${this.deps.config.publicUrl}/channels/telegram/${agent.id}`,
          once.secretToken,
        );
        webhook = { registered: true };
      } catch (err) {
        webhook = { registered: false, error: (err as Error).message };
      }
    }
    return {
      channel: serializeChannel(row!, this.deps.config.publicUrl),
      ...(Object.keys(once).length ? { secrets: once } : {}),
      ...(webhook ? { webhook } : {}),
    };
  }

  async remove(agentId: string, type: ChannelType) {
    await this.deps.db.delete(channels).where(and(eq(channels.agentId, agentId), eq(channels.type, type)));
  }

  /** First delivery of an event id wins (webhook providers retry). */
  private async firstDelivery(agentId: string, channel: string, externalId: string): Promise<boolean> {
    const rows = await this.deps.db
      .insert(inboundEvents)
      .values({ agentId, channel, externalId, createdAt: this.deps.clock.now() })
      .onConflictDoNothing()
      .returning({ id: inboundEvents.externalId });
    return rows.length > 0;
  }

  /** Inbound policy for messaging channels: `open` (default) or `allowlist` of `channel:userId` / `userId`. */
  allowed(agent: AgentRow, channel: Channel, externalUserId: string): boolean {
    const policy = agent.settings?.inbound;
    if (policy?.policy !== 'allowlist') return true;
    return policy.allowlist.some(
      (entry) => entry === `${channel}:${externalUserId}` || entry === externalUserId,
    );
  }

  private compose(result: SendResult): string {
    return result.disclosure ? `${result.disclosure}\n\n${result.reply}` : result.reply;
  }

  private async locale(agent: AgentRow): Promise<'vi' | 'en'> {
    return agent.settings?.language ?? 'vi';
  }

  /**
   * Shared inbound path: policy check, then (in the background) run the turn
   * and deliver the reply through `deliver`.
   */
  private async dispatch(
    agent: AgentRow,
    channel: 'telegram' | 'zalo',
    msg: InboundMessage,
    deliver: (text: string) => Promise<void>,
  ) {
    if (!this.allowed(agent, channel, msg.externalUserId)) {
      await this.deps.events.record(
        agent,
        'warn',
        'inbound_blocked',
        `Message from ${channel}:${msg.externalUserId} ignored (not on the allowlist)`,
        {
          channel,
          externalUserId: msg.externalUserId,
        },
      );
      return 'blocked' as const;
    }
    if (agent.status !== 'running') {
      await this.deps.events.record(
        agent,
        'warn',
        'inbound_dropped',
        `Message on ${channel} dropped: agent is ${agent.status}`,
      );
      return 'agent_not_running' as const;
    }
    this.deps.bg.run(async () => {
      try {
        if (!msg.text?.trim()) {
          await deliver(NON_TEXT_REPLY[await this.locale(agent)]);
          return;
        }
        const result = await this.deps.conversations.send({
          agent,
          channel,
          externalUserId: msg.externalUserId,
          text: msg.text,
          userName: msg.userName,
          metadata: { replyTo: msg.replyTo, ...(msg.userName ? { userName: msg.userName } : {}) },
          disclose: true,
        });
        await deliver(this.compose(result));
      } catch (err) {
        await this.deps.events.record(
          agent,
          'error',
          'channel_reply_failed',
          `${channel}: ${(err as Error).message}`.slice(0, 500),
        );
        throw err;
      }
    });
    return 'accepted' as const;
  }

  async handleTelegram(agentId: string, secretHeader: string | undefined, body: unknown) {
    const channel = await this.find(agentId, 'telegram');
    if (!channel?.enabled) throw new AppError('not_found', 'Telegram channel is not enabled for this agent');
    if (!secretHeader || !channel.secretHash || !safeEqualStr(sha256Hex(secretHeader), channel.secretHash)) {
      throw new AppError('unauthorized', 'Invalid Telegram secret token');
    }
    const msg = parseTelegramUpdate(body);
    if (!msg || msg.isBot) return { status: 'ignored' };
    if (!(await this.firstDelivery(agentId, 'telegram', msg.eventId))) return { status: 'duplicate' };
    const agent = await this.deps.agents.getById(agentId);
    if (!agent) throw new AppError('not_found', 'Agent not found');
    const creds = telegramAuth.safeParse((await this.deps.credentials.get(agent, 'telegram')) ?? {});
    if (!creds.success) throw new AppError('bad_request', 'Telegram credentials missing');
    const status = await this.dispatch(agent, 'telegram', msg, async (text) => {
      await telegramApi.sendMessage(this.deps.fetch, creds.data.botToken, msg.replyTo, text);
    });
    return { status };
  }

  async handleZalo(agentId: string, rawBody: string, signatureHeader: string | undefined) {
    const channel = await this.find(agentId, 'zalo');
    if (!channel?.enabled) throw new AppError('not_found', 'Zalo channel is not enabled for this agent');
    const agent = await this.deps.agents.getById(agentId);
    if (!agent) throw new AppError('not_found', 'Agent not found');
    const creds = zaloAuth.safeParse((await this.deps.credentials.get(agent, 'zalo_oa')) ?? {});
    if (!creds.success || !creds.data.oaSecretKey || !creds.data.appId)
      throw new AppError('unauthorized', 'Zalo webhook verification is not configured');
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new AppError('bad_request', 'Body must be JSON');
    }
    const timestamp = String((body as { timestamp?: unknown })?.timestamp ?? '');
    if (
      !verifyZaloSignature({
        appId: creds.data.appId,
        rawBody,
        timestamp,
        oaSecretKey: creds.data.oaSecretKey,
        header: signatureHeader,
      })
    ) {
      throw new AppError('unauthorized', 'Invalid Zalo signature');
    }
    const msg = parseZaloEvent(body);
    if (!msg) return { status: 'ignored' };
    if (!(await this.firstDelivery(agentId, 'zalo', msg.eventId))) return { status: 'duplicate' };
    const zaloCreds = creds.data;
    const zaloIntegration = this.deps.catalog.get('zalo_oa')!;
    const status = await this.dispatch(agent, 'zalo', msg, async (text) => {
      await zaloApi.sendText(this.deps.fetch, zaloCreds, msg.replyTo, text, {
        saveCredentials: async (patch) => {
          await this.deps.credentials.set(agent, zaloIntegration, patch, { merge: true });
        },
      });
    });
    return { status };
  }

  async findWeb(publicToken: string): Promise<{ channel: ChannelRow; agent: AgentRow }> {
    const [channel] = await this.deps.db
      .select()
      .from(channels)
      .where(and(eq(channels.publicToken, publicToken), eq(channels.type, 'web')));
    if (!channel?.enabled) throw new AppError('not_found', 'Chat widget not found');
    const agent = await this.deps.agents.getById(channel.agentId);
    if (!agent) throw new AppError('not_found', 'Chat widget not found');
    return { channel, agent };
  }

  async handleWebChat(publicToken: string, input: { message: string; sessionId: string }) {
    const { agent } = await this.findWeb(publicToken);
    if (agent.status !== 'running')
      throw new AppError('conflict', 'This assistant is offline right now. Please try again later.');
    const result = await this.deps.conversations.send({
      agent,
      channel: 'web',
      externalUserId: `web:${input.sessionId}`,
      text: input.message,
      disclose: true,
    });
    return { reply: result.reply, disclosure: result.disclosure };
  }
}
