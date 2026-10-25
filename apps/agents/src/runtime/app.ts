import { createLlmClient, type LlmClient, responseText } from '@ok/llm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { FetchLike } from '../lib/http';
import { type LoopToolExecutor, runAgentLoop } from './loop';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyRequest } from './signing';
import type { ToolOutcome, TurnEvent, TurnRequest, TurnResult } from './types';

/**
 * The runtime server that runs inside each agent container (builtin image,
 * and as the front door of the OpenClaw/Hermes images).
 *
 * - `POST /turn` (signed by the control plane): runs one turn and returns a
 *   TurnResult (JSON, or SSE when `Accept: text/event-stream`).
 * - `builtin` mode runs the shared agent loop; LLM calls go to OK_GATEWAY_URL
 *   (the control plane's per-agent LLM proxy) and tools execute through the
 *   control plane's tool proxy. No credentials other than the runtime token
 *   exist in the container.
 * - `upstream` mode forwards the turn to a third-party runtime's local
 *   OpenAI-compatible endpoint (OpenClaw/Hermes), which uses our tools via MCP.
 */
export interface RuntimeAppOptions {
  agentId: string;
  runtimeToken: string;
  controlPlaneUrl: string;
  gatewayUrl: string;
  mode?: 'builtin' | 'upstream';
  upstream?: { url: string; apiKey?: string; model?: string };
  fetch?: FetchLike;
  /** Override the LLM client (tests). */
  llm?: LlmClient;
  now?: () => number;
}

const turnRequestSchema = z.object({
  agentId: z.string(),
  conversationId: z.string(),
  model: z.string(),
  messages: z.array(z.object({ role: z.string() }).passthrough()).min(1),
  tools: z.array(z.object({ type: z.literal('function') }).passthrough()),
  sequentialTools: z.array(z.string()).optional(),
  maxSteps: z.number().int().min(1).max(50),
  budget: z.object({ maxTokens: z.number().int().positive(), maxMs: z.number().int().positive() }),
  temperature: z.number().optional(),
  locale: z.enum(['vi', 'en']).optional(),
});

export function createRemoteToolExecutor(opts: {
  controlPlaneUrl: string;
  agentId: string;
  runtimeToken: string;
  conversationId: string;
  fetch?: FetchLike;
}): LoopToolExecutor {
  const fetchFn = opts.fetch ?? fetch;
  const base = opts.controlPlaneUrl.replace(/\/+$/, '');
  return {
    async execute(call, signal): Promise<ToolOutcome> {
      const started = Date.now();
      try {
        const res = await fetchFn(
          `${base}/internal/agents/${encodeURIComponent(opts.agentId)}/tools/${encodeURIComponent(call.name)}`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${opts.runtimeToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              arguments: call.arguments,
              conversationId: opts.conversationId,
              toolCallId: call.id,
            }),
            signal,
          },
        );
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return {
            ok: false,
            outcome: 'error',
            error: `Tool proxy error ${res.status}: ${text.slice(0, 200)}`,
            durationMs: Date.now() - started,
          };
        }
        return (await res.json()) as ToolOutcome;
      } catch (err) {
        return {
          ok: false,
          outcome: 'error',
          error: `Tool proxy unreachable: ${(err as Error).message}`,
          durationMs: Date.now() - started,
        };
      }
    },
  };
}

async function runUpstream(opts: RuntimeAppOptions, req: TurnRequest): Promise<TurnResult> {
  const fetchFn = opts.fetch ?? fetch;
  const up = opts.upstream!;
  const res = await fetchFn(`${up.url.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(up.apiKey ? { authorization: `Bearer ${up.apiKey}` } : {}),
      'x-ok-conversation-id': req.conversationId,
    },
    body: JSON.stringify({
      model: up.model ?? req.model,
      messages: req.messages,
      stream: false,
      user: req.conversationId,
    }),
    signal: AbortSignal.timeout(req.budget.maxMs),
  });
  if (!res.ok)
    throw new Error(
      `Upstream runtime error ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`,
    );
  const data = (await res.json()) as Parameters<typeof responseText>[0];
  const reply = responseText(data) || '…';
  const u = data.usage;
  return {
    reply,
    messages: [{ role: 'assistant', content: reply }],
    toolCalls: [], // tools run through MCP and are traced by the control plane
    usage: {
      promptTokens: u?.prompt_tokens ?? 0,
      completionTokens: u?.completion_tokens ?? 0,
      totalTokens: u?.total_tokens ?? 0,
      costMicros: u?.cost_micros ?? 0,
    },
    steps: 1,
    stopReason: 'final',
  };
}

export function createRuntimeApp(opts: RuntimeAppOptions): Hono {
  const app = new Hono();
  const mode = opts.mode ?? 'builtin';

  app.get('/health', (c) => c.json({ ok: true, agentId: opts.agentId, mode }));

  app.post('/turn', async (c) => {
    const raw = await c.req.text();
    const valid = verifyRequest({
      token: opts.runtimeToken,
      timestamp: c.req.header(TIMESTAMP_HEADER),
      signature: c.req.header(SIGNATURE_HEADER),
      body: raw,
      now: opts.now?.(),
    });
    if (!valid)
      return c.json(
        { error: { code: 'unauthorized', message: 'Invalid or missing request signature' } },
        401,
      );
    let req: TurnRequest;
    try {
      req = turnRequestSchema.parse(JSON.parse(raw)) as unknown as TurnRequest;
    } catch {
      return c.json({ error: { code: 'bad_request', message: 'Invalid turn request' } }, 400);
    }
    if (req.agentId !== opts.agentId)
      return c.json({ error: { code: 'forbidden', message: 'Turn is for another agent' } }, 403);

    const run = (onEvent?: (e: TurnEvent) => void): Promise<TurnResult> => {
      if (mode === 'upstream') return runUpstream(opts, req);
      const llm =
        opts.llm ??
        createLlmClient({
          baseUrl: opts.gatewayUrl,
          apiKey: opts.runtimeToken,
          headers: { 'x-ok-conversation-id': req.conversationId },
          timeoutMs: req.budget.maxMs,
        });
      const tools = createRemoteToolExecutor({ ...opts, conversationId: req.conversationId });
      return runAgentLoop({ llm, request: req, tools, onEvent, stream: Boolean(onEvent) });
    };

    if (!(c.req.header('accept') ?? '').includes('text/event-stream')) {
      try {
        return c.json(await run());
      } catch (err) {
        return c.json({ error: { code: 'upstream_error', message: (err as Error).message } }, 502);
      }
    }
    return streamSSE(c, async (stream) => {
      const queue: Promise<unknown>[] = [];
      try {
        const result = await run((e) => {
          queue.push(stream.writeSSE({ event: 'event', data: JSON.stringify(e) }));
        });
        await Promise.all(queue);
        await stream.writeSSE({ event: 'result', data: JSON.stringify(result) });
      } catch (err) {
        await Promise.all(queue);
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: (err as Error).message }) });
      }
    });
  });

  return app;
}
