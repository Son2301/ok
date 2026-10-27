import type { Db } from '@minh/db';
import type { ChatMessage } from '@minh/llm';
import { AppError, type Logger, newId } from '@minh/shared';
import { and, desc, eq, lt, type SQL, sql } from 'drizzle-orm';
import type { AgentsConfig } from '../config';
import { type AgentRow, type ConversationRow, conversations, type MessageRow, messages } from '../db/schema';
import { KeyedMutex } from '../lib/async';
import type { Clock } from '../lib/time';
import type { RuntimeDriver } from '../runtime/drivers/types';
import type { ToolTrace, TurnEvent, TurnRequest, TurnResult } from '../runtime/types';
import type { CompanyService, ContextBuilder } from './context';
import type { EventLog } from './events';
import type { RuntimeTokenService } from './tokens';
import { ToolService } from './tools';

export type Channel = 'api' | 'web' | 'telegram' | 'zalo' | 'internal';

export interface SendInput {
  agent: AgentRow;
  channel: Channel;
  externalUserId: string;
  text: string;
  userName?: string | null;
  metadata?: Record<string, unknown>;
  onEvent?: (e: TurnEvent) => void;
  /** Apply the AI disclosure on the first reply of the conversation (customer-facing channels). */
  disclose?: boolean;
}

export interface SendResult {
  conversationId: string;
  messageId: string;
  reply: string;
  /** Disclosure text to show before the reply (first reply of a customer conversation), else null. */
  disclosure: string | null;
  toolCalls: ToolTrace[];
  usage: TurnResult['usage'];
  steps: number;
  stopReason: TurnResult['stopReason'];
}

const HISTORY_MESSAGES = 40;
const HISTORY_CHARS = 48_000;

export function defaultDisclosure(language: 'vi' | 'en', company: string | null): string {
  return language === 'vi'
    ? `Xin chào! Mình là trợ lý AI${company ? ` của ${company}` : ''}. Câu trả lời do AI tạo ra và có thể chưa chính xác; bạn có thể yêu cầu gặp nhân viên bất cứ lúc nào.`
    : `Hi! I'm an AI assistant${company ? ` for ${company}` : ''}. Replies are AI-generated and may contain mistakes; you can ask for a human at any time.`;
}

function toChat(m: MessageRow): ChatMessage {
  return {
    role: m.role as ChatMessage['role'],
    content: m.content,
    ...(m.toolCalls?.length ? { tool_calls: m.toolCalls } : {}),
    ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
    ...(m.role === 'tool' && m.name ? { name: m.name } : {}),
  };
}

/**
 * Make stored history safe to send to an OpenAI-compatible API: drop tool
 * messages without their assistant call, assistant tool calls whose results
 * were cut off, then trim the oldest messages to a character budget.
 */
export function sanitizeHistory(rows: ChatMessage[], maxChars = HISTORY_CHARS): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i]!;
    if (m.role === 'tool') continue; // consumed together with its assistant message
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const ids = new Set(m.tool_calls.map((c) => c.id));
      const results: ChatMessage[] = [];
      let j = i + 1;
      while (j < rows.length && rows[j]!.role === 'tool') {
        if (ids.has(rows[j]!.tool_call_id ?? '')) results.push(rows[j]!);
        j++;
      }
      if (results.length === ids.size) out.push(m, ...results);
      else if (typeof m.content === 'string' && m.content)
        out.push({ role: 'assistant', content: m.content });
      i = j - 1;
      continue;
    }
    out.push(m);
  }
  // Trim from the start, keeping tool groups intact.
  let total = out.reduce((n, m) => n + JSON.stringify(m).length, 0);
  while (out.length && total > maxChars) {
    const first = out.shift()!;
    total -= JSON.stringify(first).length;
    while (out.length && out[0]!.role === 'tool') total -= JSON.stringify(out.shift()!).length;
  }
  while (out.length && out[0]!.role === 'tool') out.shift();
  return out;
}

/**
 * Conversations keyed by (agent, channel, external user id). One turn at a
 * time per conversation; the control plane builds the context, the runtime
 * driver executes the turn, and the produced messages are persisted.
 */
export class ConversationService {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly deps: {
      db: Db;
      driver: RuntimeDriver;
      tools: ToolService;
      context: ContextBuilder;
      company: CompanyService;
      tokens: RuntimeTokenService;
      events: EventLog;
      config: AgentsConfig;
      clock: Clock;
      logger: Logger;
    },
  ) {}

  async getOrCreate(
    agent: AgentRow,
    channel: Channel,
    externalUserId: string,
    metadata?: Record<string, unknown>,
  ): Promise<ConversationRow> {
    const now = this.deps.clock.now();
    const [row] = await this.deps.db
      .insert(conversations)
      .values({
        id: newId('cnv'),
        orgId: agent.orgId,
        agentId: agent.id,
        channel,
        externalUserId,
        metadata: metadata ?? {},
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [conversations.agentId, conversations.channel, conversations.externalUserId],
        set: metadata
          ? { metadata: sql`${conversations.metadata} || ${JSON.stringify(metadata)}::jsonb` }
          : { agentId: sql`${conversations.agentId}` },
      })
      .returning();
    return row!;
  }

  async loadHistory(conversationId: string): Promise<ChatMessage[]> {
    const rows = await this.deps.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.seq))
      .limit(HISTORY_MESSAGES);
    return sanitizeHistory(rows.reverse().map(toChat));
  }

  async send(input: SendInput): Promise<SendResult> {
    const { agent } = input;
    if (agent.status !== 'running') {
      throw new AppError(
        'conflict',
        `Agent is ${agent.status.replace('_', ' ')}${agent.statusReason ? `: ${agent.statusReason}` : ''}. Deploy or start it first.`,
      );
    }
    const text = input.text.trim();
    if (!text) throw new AppError('bad_request', 'Message is empty');
    const conv = await this.getOrCreate(agent, input.channel, input.externalUserId, input.metadata);

    return this.mutex.run(conv.id, async () => {
      const history = await this.loadHistory(conv.id);
      const now = this.deps.clock.now();
      await this.deps.db.insert(messages).values({
        id: newId('msg'),
        conversationId: conv.id,
        agentId: agent.id,
        orgId: agent.orgId,
        role: 'user',
        content: text,
        createdAt: now,
      });
      input.onEvent?.({ type: 'start', conversationId: conv.id });

      const resolved = await this.deps.tools.resolve(agent);
      const system = await this.deps.context.build(agent, {
        channel: input.channel,
        tools: resolved,
        userName: input.userName,
      });
      const profile = await this.deps.company.get(agent.orgId);
      const req: TurnRequest = {
        agentId: agent.id,
        conversationId: conv.id,
        model: agent.model,
        messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: text }],
        tools: resolved.map((r) => r.definition),
        sequentialTools: ToolService.sequentialNames(resolved),
        maxSteps: agent.settings?.maxSteps ?? this.deps.config.turn.maxSteps,
        budget: { maxTokens: this.deps.config.turn.tokenBudget, maxMs: this.deps.config.turn.timeBudgetMs },
        ...(agent.settings?.temperature !== undefined ? { temperature: agent.settings.temperature } : {}),
        locale: agent.settings?.language ?? profile.language,
      };

      let result: TurnResult;
      try {
        result = await this.deps.driver.send(
          {
            agentId: agent.id,
            orgId: agent.orgId,
            tokenHash: await this.deps.tokens.containerTokenHash(agent.id),
          },
          req,
          { onEvent: input.onEvent },
        );
      } catch (err) {
        await this.deps.events.record(agent, 'error', 'turn_failed', (err as Error).message.slice(0, 500), {
          conversationId: conv.id,
          channel: input.channel,
        });
        throw err;
      }

      let messageId = '';
      for (const m of result.messages) {
        const id = newId('msg');
        if (m.role === 'assistant') messageId = id;
        await this.deps.db.insert(messages).values({
          id,
          conversationId: conv.id,
          agentId: agent.id,
          orgId: agent.orgId,
          role: m.role,
          content: typeof m.content === 'string' ? m.content : m.content ? JSON.stringify(m.content) : null,
          toolCalls: m.tool_calls?.length ? m.tool_calls : null,
          toolCallId: m.tool_call_id ?? null,
          name: m.name ?? null,
          promptTokens: m.usage?.prompt ?? null,
          completionTokens: m.usage?.completion ?? null,
          createdAt: this.deps.clock.now(),
        });
      }

      let disclosure: string | null = null;
      const disclosureSetting = agent.settings?.aiDisclosure;
      // Re-read inside the per-conversation lock: a concurrent first message may have disclosed already.
      const [current] = await this.deps.db
        .select({ aiDisclosedAt: conversations.aiDisclosedAt })
        .from(conversations)
        .where(eq(conversations.id, conv.id));
      if (input.disclose && !current?.aiDisclosedAt && disclosureSetting?.enabled !== false) {
        disclosure =
          disclosureSetting?.text?.trim() ||
          defaultDisclosure(agent.settings?.language ?? profile.language, profile.companyName);
      }
      await this.deps.db
        .update(conversations)
        .set({
          lastMessageAt: this.deps.clock.now(),
          ...(disclosure ? { aiDisclosedAt: this.deps.clock.now() } : {}),
        })
        .where(eq(conversations.id, conv.id));

      return {
        conversationId: conv.id,
        messageId,
        reply: result.reply,
        disclosure,
        toolCalls: result.toolCalls,
        usage: result.usage,
        steps: result.steps,
        stopReason: result.stopReason,
      };
    });
  }

  list(orgId: string, agentId: string, filter: { channel?: string; limit?: number } = {}) {
    const conds: SQL[] = [eq(conversations.orgId, orgId), eq(conversations.agentId, agentId)];
    if (filter.channel) conds.push(eq(conversations.channel, filter.channel));
    return this.deps.db
      .select()
      .from(conversations)
      .where(and(...conds))
      .orderBy(sql`${conversations.lastMessageAt} DESC NULLS LAST`, desc(conversations.createdAt))
      .limit(Math.min(filter.limit ?? 50, 200));
  }

  async get(orgId: string, agentId: string, conversationId: string): Promise<ConversationRow> {
    const [row] = await this.deps.db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.orgId, orgId),
          eq(conversations.agentId, agentId),
        ),
      );
    if (!row) throw new AppError('not_found', 'Conversation not found');
    return row;
  }

  async messages(conversationId: string, opts: { limit?: number; beforeSeq?: number } = {}) {
    const conds: SQL[] = [eq(messages.conversationId, conversationId)];
    if (opts.beforeSeq) conds.push(lt(messages.seq, opts.beforeSeq));
    const rows = await this.deps.db
      .select()
      .from(messages)
      .where(and(...conds))
      .orderBy(desc(messages.seq))
      .limit(Math.min(opts.limit ?? 100, 500));
    return rows.reverse();
  }
}
