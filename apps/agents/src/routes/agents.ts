import { type AuthEnv, getAuth } from '@ok/core';
import { AppError, isAppError, parseJson } from '@ok/shared';
import { and, desc, eq } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ChannelType } from '../db/schema';
import { toolCalls } from '../db/schema';
import type { Platform } from '../platform';
import type { AgentInput } from '../services/agents';
import { serializeAgent } from '../services/agents';
import { serializeChannel } from '../services/channels';
import {
  channelSchema,
  createAgentSchema,
  knowledgeJsonSchema,
  messageSchema,
  putIntegrationSchema,
  runtimeTokenSchema,
  updateAgentSchema,
} from './schemas';

const CHANNEL_TYPES: ChannelType[] = ['telegram', 'zalo', 'web'];
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

function channelType(raw: string): ChannelType {
  if (!CHANNEL_TYPES.includes(raw as ChannelType))
    throw new AppError('not_found', `Unknown channel "${raw}" (telegram, zalo or web)`);
  return raw as ChannelType;
}

/** Parse a knowledge upload: JSON `{ content, filename?, title? }` or multipart with a `file` field. */
export async function readUpload(c: Context) {
  const type = c.req.header('content-type') ?? '';
  if (type.startsWith('multipart/form-data')) {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) throw new AppError('bad_request', 'Multipart upload needs a `file` field');
    if (file.size > MAX_UPLOAD_BYTES)
      throw new AppError('bad_request', `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
    return {
      content: await file.text(),
      filename: file.name,
      mimeType: file.type || undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
    };
  }
  return parseJson(c, knowledgeJsonSchema);
}

export function agentRoutes(p: Platform) {
  const r = new Hono<AuthEnv>();
  const agentOf = (c: Context) => p.agents.get(getAuth(c).orgId, c.req.param('id')!);

  // ------------------------------------------------------------- CRUD
  r.get('/', async (c) => c.json({ data: (await p.agents.list(getAuth(c).orgId)).map(serializeAgent) }));

  r.post('/', async (c) => {
    const body = await parseJson(c, createAgentSchema);
    const agent = await p.agents.create(getAuth(c).orgId, body as AgentInput);
    return c.json(serializeAgent(agent), 201);
  });

  r.get('/:id', async (c) => {
    const agent = await agentOf(c);
    const [integrations, chans, usage] = await Promise.all([
      p.agents.integrationViews(agent),
      p.channels.list(agent.id),
      p.usage.get(agent.id),
    ]);
    return c.json({
      ...serializeAgent(agent),
      integrationStatus: integrations,
      channels: chans.map((ch) => serializeChannel(ch, p.config.publicUrl)),
      usage: usage
        ? {
            month: usage.month,
            totalTokens: usage.totalTokens,
            platformTokens: usage.platformTokens,
            customerTokens: usage.customerTokens,
            customerCostMicros: usage.customerCostMicros,
          }
        : null,
    });
  });

  r.patch('/:id', async (c) => {
    const body = await parseJson(c, updateAgentSchema);
    const { agent, requiresRedeploy } = await p.agents.update(
      getAuth(c).orgId,
      c.req.param('id'),
      body as Partial<AgentInput>,
    );
    return c.json({ ...serializeAgent(agent), requiresRedeploy });
  });

  r.delete('/:id', async (c) => {
    await p.agents.delete(getAuth(c).orgId, c.req.param('id'));
    return c.body(null, 204);
  });

  // ------------------------------------------------------------- lifecycle
  for (const action of ['deploy', 'start', 'stop', 'restart'] as const) {
    r.post(`/:id/${action}`, async (c) => {
      const { agent, runtime } = await p.agents[action](getAuth(c).orgId, c.req.param('id'));
      return c.json({ agent: serializeAgent(agent), runtime });
    });
  }

  r.get('/:id/status', async (c) => {
    const tail = Math.min(Number(c.req.query('tail') ?? 100) || 100, 1000);
    return c.json(await p.agents.status(getAuth(c).orgId, c.req.param('id'), { tail }));
  });

  r.get('/:id/logs', async (c) => {
    const agent = await agentOf(c);
    const tail = Math.min(Number(c.req.query('tail') ?? 200) || 200, 1000);
    return c.json({ data: await p.driver.logs(agent.id, { tail }) });
  });

  r.post('/:id/wake', async (c) => {
    const agent = await agentOf(c);
    const open = (await p.tasks.openTasksForAgent(agent)).filter((t) => t.status !== 'blocked');
    if (!open.length) return c.json({ woke: false, reason: 'No open tasks' });
    const result = await p.conversations.send({
      agent,
      channel: 'internal',
      externalUserId: 'scheduler',
      text: p.scheduler.heartbeatPrompt(agent, open, p.clock.now()),
    });
    return c.json({ woke: true, reply: result.reply, toolCalls: result.toolCalls });
  });

  // ------------------------------------------------------------- conversations
  r.post('/:id/messages', async (c) => {
    const body = await parseJson(c, messageSchema);
    const agent = await agentOf(c);
    const result = await p.conversations.send({
      agent,
      channel: 'api',
      externalUserId: body.userId,
      text: body.message,
    });
    return c.json(result);
  });

  r.post('/:id/messages/stream', async (c) => {
    const body = await parseJson(c, messageSchema);
    const agent = await agentOf(c);
    if (agent.status !== 'running')
      throw new AppError('conflict', `Agent is ${agent.status}. Deploy or start it first.`);
    return streamSSE(c, async (stream) => {
      let chain: Promise<void> = Promise.resolve();
      const emit = (event: string, data: unknown) => {
        chain = chain
          .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
          .catch(() => undefined);
      };
      try {
        // Not tied to the client connection: if the client disconnects the turn still completes and is saved.
        const result = await p.conversations.send({
          agent,
          channel: 'api',
          externalUserId: body.userId,
          text: body.message,
          onEvent: (e) => emit(e.type, e),
        });
        emit('done', result);
      } catch (err) {
        emit(
          'error',
          isAppError(err)
            ? { code: err.code, message: err.message }
            : { code: 'internal', message: 'Turn failed' },
        );
      }
      await chain;
    });
  });

  r.get('/:id/conversations', async (c) => {
    const agent = await agentOf(c);
    const rows = await p.conversations.list(agent.orgId, agent.id, {
      channel: c.req.query('channel'),
      limit: Number(c.req.query('limit') ?? 50) || 50,
    });
    return c.json({
      data: rows.map((cv) => ({
        id: cv.id,
        channel: cv.channel,
        externalUserId: cv.externalUserId,
        metadata: cv.metadata,
        lastMessageAt: cv.lastMessageAt?.toISOString() ?? null,
        createdAt: cv.createdAt.toISOString(),
      })),
    });
  });

  r.get('/:id/conversations/:cid/messages', async (c) => {
    const agent = await agentOf(c);
    const conv = await p.conversations.get(agent.orgId, agent.id, c.req.param('cid'));
    const before = c.req.query('before');
    const rows = await p.conversations.messages(conv.id, {
      limit: Number(c.req.query('limit') ?? 100) || 100,
      beforeSeq: before ? Number(before) : undefined,
    });
    return c.json({
      conversation: { id: conv.id, channel: conv.channel, externalUserId: conv.externalUserId },
      data: rows.map((m) => ({
        id: m.id,
        seq: m.seq,
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls,
        toolCallId: m.toolCallId,
        name: m.name,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  });

  r.get('/:id/tool-calls', async (c) => {
    const agent = await agentOf(c);
    const rows = await p.handle.db
      .select()
      .from(toolCalls)
      .where(and(eq(toolCalls.agentId, agent.id), eq(toolCalls.orgId, agent.orgId)))
      .orderBy(desc(toolCalls.createdAt))
      .limit(Math.min(Number(c.req.query('limit') ?? 50) || 50, 200));
    return c.json({ data: rows.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })) });
  });

  // ------------------------------------------------------------- integrations
  r.get('/:id/integrations', async (c) =>
    c.json({ data: await p.agents.integrationViews(await agentOf(c)) }),
  );

  r.put('/:id/integrations/:integrationId', async (c) => {
    const body = await parseJson(c, putIntegrationSchema);
    return c.json(
      await p.agents.setIntegration(getAuth(c).orgId, c.req.param('id'), c.req.param('integrationId'), body),
    );
  });

  r.delete('/:id/integrations/:integrationId', async (c) => {
    await p.agents.removeIntegration(getAuth(c).orgId, c.req.param('id'), c.req.param('integrationId'));
    return c.body(null, 204);
  });

  // ------------------------------------------------------------- knowledge (agent scope)
  r.get('/:id/knowledge', async (c) => {
    const agent = await agentOf(c);
    return c.json({ data: await p.knowledge.list(agent.orgId, agent.id) });
  });

  r.post('/:id/knowledge', async (c) => {
    const agent = await agentOf(c);
    const upload = await readUpload(c);
    return c.json(await p.knowledge.addDocument({ orgId: agent.orgId, agentId: agent.id, ...upload }), 201);
  });

  r.get('/:id/knowledge/search', async (c) => {
    const agent = await agentOf(c);
    const q = c.req.query('q');
    if (!q) throw new AppError('bad_request', 'Query parameter q is required');
    return c.json({
      data: await p.knowledge.search({
        orgId: agent.orgId,
        agentId: agent.id,
        query: q,
        limit: Number(c.req.query('limit') ?? 5) || 5,
      }),
    });
  });

  r.get('/:id/knowledge/:docId', async (c) => {
    const agent = await agentOf(c);
    return c.json(await p.knowledge.getDocument(agent.orgId, c.req.param('docId')));
  });

  r.delete('/:id/knowledge/:docId', async (c) => {
    const agent = await agentOf(c);
    await p.knowledge.delete(agent.orgId, c.req.param('docId'), agent.id);
    return c.body(null, 204);
  });

  // ------------------------------------------------------------- channels
  r.get('/:id/channels', async (c) => {
    const agent = await agentOf(c);
    return c.json({
      data: (await p.channels.list(agent.id)).map((ch) => serializeChannel(ch, p.config.publicUrl)),
    });
  });

  r.put('/:id/channels/:type', async (c) => {
    const body = await parseJson(c, channelSchema);
    const agent = await agentOf(c);
    return c.json(await p.channels.configure(agent, channelType(c.req.param('type')), body));
  });

  r.delete('/:id/channels/:type', async (c) => {
    const agent = await agentOf(c);
    await p.channels.remove(agent.id, channelType(c.req.param('type')));
    return c.body(null, 204);
  });

  // ------------------------------------------------------------- runtime tokens (external runtimes / MCP clients)
  r.get('/:id/runtime-tokens', async (c) => {
    const agent = await agentOf(c);
    return c.json({ data: await p.tokens.list(agent.id) });
  });

  r.post('/:id/runtime-tokens', async (c) => {
    const body = await parseJson(c, runtimeTokenSchema);
    const agent = await agentOf(c);
    const { token, record } = await p.tokens.issue(agent, 'external', body.label);
    return c.json(
      {
        id: record.id,
        token,
        prefix: record.prefix,
        note: 'Shown once. Use it as a Bearer token for the MCP endpoint and the LLM proxy.',
        mcpUrl: `${p.config.publicUrl}/mcp/${agent.id}`,
        llmBaseUrl: `${p.config.publicUrl}/internal/agents/${agent.id}/llm/v1`,
      },
      201,
    );
  });

  r.delete('/:id/runtime-tokens/:tokenId', async (c) => {
    const agent = await agentOf(c);
    await p.tokens.revoke(agent.id, c.req.param('tokenId'));
    return c.body(null, 204);
  });

  return r;
}
