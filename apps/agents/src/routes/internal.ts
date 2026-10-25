import type { ChatRequest } from '@ok/llm';
import { AppError, isAppError, parseJson } from '@ok/shared';
import { and, eq } from 'drizzle-orm';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { stream } from 'hono/streaming';
import { type AgentRow, conversations } from '../db/schema';
import { handleMcpRequest } from '../mcp/server';
import type { Platform } from '../platform';
import { chatCompletionSchema, toolProxySchema } from './schemas';

type RuntimeEnv = { Variables: { agent: AgentRow } };

/** Authenticates `Authorization: Bearer agrt_…` for the agent in the path. */
function runtimeAuth(p: Platform, param: string): MiddlewareHandler<RuntimeEnv> {
  return async (c, next) => {
    const agentId = c.req.param(param);
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!agentId || !token) throw new AppError('unauthorized', 'Missing runtime token');
    const record = await p.tokens.verify(agentId, token);
    if (!record) throw new AppError('unauthorized', 'Invalid runtime token');
    const agent = await p.agents.getById(agentId);
    if (!agent) throw new AppError('not_found', 'Agent not found');
    c.set('agent', agent);
    await next();
  };
}

function assertActive(agent: AgentRow) {
  if (agent.status === 'suspended_billing' || agent.status === 'paused_budget')
    throw new AppError('payment_required', `Agent is ${agent.status}`);
  if (agent.status !== 'running') throw new AppError('conflict', `Agent is ${agent.status}`);
}

async function ownConversation(
  p: Platform,
  agent: AgentRow,
  id: string | undefined | null,
): Promise<string | null> {
  if (!id) return null;
  const [row] = await p.handle.db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.agentId, agent.id)));
  return row?.id ?? null;
}

/**
 * Endpoints for agent runtimes, authenticated by the per-agent runtime token:
 *  - tool proxy:  POST /internal/agents/:id/tools/:tool
 *  - LLM proxy:   POST /internal/agents/:id/llm/v1/chat/completions (OpenAI-compatible; quota/budget/billing applied)
 */
export function internalRoutes(p: Platform) {
  const r = new Hono<RuntimeEnv>();
  r.use('/agents/:id/*', runtimeAuth(p, 'id'));

  r.get('/agents/:id/tools', async (c) => {
    const resolved = await p.tools.resolve(c.var.agent);
    return c.json({ data: resolved.map((t) => t.definition) });
  });

  r.post('/agents/:id/tools/:tool', async (c) => {
    const agent = c.var.agent;
    assertActive(agent);
    const body = await parseJson(c, toolProxySchema);
    const outcome = await p.tools.execute(agent, c.req.param('tool'), body.arguments ?? {}, {
      source: 'proxy',
      conversationId: await ownConversation(p, agent, body.conversationId),
      toolCallId: body.toolCallId ?? null,
    });
    return c.json(outcome);
  });

  r.get('/agents/:id/llm/v1/models', (c) =>
    c.json({
      object: 'list',
      data: [{ id: c.var.agent.model, object: 'model', created: 0, owned_by: 'ok-agents' }],
    }),
  );

  r.post('/agents/:id/llm/v1/chat/completions', async (c) => {
    const agent = c.var.agent;
    assertActive(agent);
    const body = (await parseJson(c, chatCompletionSchema)) as unknown as ChatRequest;
    const conversationId =
      (await ownConversation(p, agent, c.req.header('x-ok-conversation-id'))) ?? undefined;
    if (body.max_tokens) body.max_tokens = Math.min(body.max_tokens, 16_384);
    if (!body.stream) return c.json(await p.broker.chat(agent.id, body, { conversationId }));

    // Validate (budget/status) before committing to a 200 stream.
    const iterator = p.broker.stream(agent.id, body, { conversationId })[Symbol.asyncIterator]();
    const first = await iterator.next();
    c.header('content-type', 'text/event-stream; charset=utf-8');
    c.header('cache-control', 'no-cache');
    return stream(c, async (s) => {
      try {
        let cur = first;
        while (!cur.done) {
          await s.write(`data: ${JSON.stringify(cur.value)}\n\n`);
          cur = await iterator.next();
        }
      } catch (err) {
        await s.write(
          `data: ${JSON.stringify({ error: { code: isAppError(err) ? err.code : 'upstream_error', message: (err as Error).message } })}\n\n`,
        );
      }
      await s.write('data: [DONE]\n\n');
    });
  });

  return r;
}

/** MCP server per agent: `/mcp/:agentId` (Streamable HTTP, stateless). */
export function mcpRoutes(p: Platform) {
  const r = new Hono<RuntimeEnv>();
  r.use('/:agentId', runtimeAuth(p, 'agentId'));
  r.post('/:agentId', async (c: Context<RuntimeEnv>) => {
    const agent = c.var.agent;
    assertActive(agent);
    const conversationId = await ownConversation(p, agent, c.req.header('x-ok-conversation-id'));
    return handleMcpRequest(c.req.raw, agent, p.tools, { conversationId });
  });
  r.on(['GET', 'DELETE'], '/:agentId', (c) => {
    c.header('allow', 'POST');
    return c.json(
      {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed: this MCP server is stateless (POST only)' },
        id: null,
      },
      405,
    );
  });
  return r;
}
