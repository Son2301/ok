import { createHash } from 'node:crypto';
import type { Endpoint } from '../catalog/types';
import { estimateTextTokens, messageText } from '../routing/tokens';
import type {
  ChatChunk,
  ChatCompletionRequest,
  ChatResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
} from '../schemas';
import type { ProviderKind } from './config';
import { kindForStatus, ProviderError } from './errors';
import type { CallOptions, ProviderAdapter } from './types';

export type MockReply =
  | string
  | {
      content?: string;
      tool_calls?: { id?: string; name: string; arguments?: string }[];
      /** Fail this call with an upstream HTTP status. */
      error?: { status: number; message?: string };
      /** Extra latency before responding. */
      delayMs?: number;
      /** Report no usage (exercises the gateway's token estimation). */
      omitUsage?: boolean;
    };

export type MockScript = (
  req: ChatCompletionRequest,
  ctx: { endpoint: Endpoint; callIndex: number },
) => MockReply | Promise<MockReply>;

export interface MockAdapterOptions {
  id?: string;
  /** Base latency for every call, ms. */
  latencyMs?: number;
  /** Probability (0–1) that a call fails with a 503. */
  failureRate?: number;
  /** Delay between streamed chunks, ms. */
  chunkDelayMs?: number;
  random?: () => number;
  /** Scripted replies (tests, demos). Default: echo the last user message. */
  script?: MockScript;
}

function sleep(ms: number, signal: AbortSignal, provider: string): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      const reason = signal.reason;
      reject(
        reason instanceof ProviderError ? reason : new ProviderError(provider, 'aborted', 'Request aborted'),
      );
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

function lastUserText(req: ChatCompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role === 'user') return messageText(m);
  }
  return '';
}

/** Default behaviour: tool call when forced or when the user names a tool, JSON when asked, else echo. */
export function defaultMockReply(req: ChatCompletionRequest): MockReply {
  const text = lastUserText(req);
  const last = req.messages[req.messages.length - 1];
  if (req.tools?.length && req.tool_choice !== 'none' && last?.role === 'user') {
    const forced = typeof req.tool_choice === 'object' ? req.tool_choice.function.name : undefined;
    const named = req.tools.find((t) => text.toLowerCase().includes(t.function.name.toLowerCase()))?.function
      .name;
    const name =
      forced ?? named ?? (req.tool_choice === 'required' ? req.tools[0]!.function.name : undefined);
    if (name) return { tool_calls: [{ name, arguments: '{}' }] };
  }
  if (req.response_format && req.response_format.type !== 'text') return JSON.stringify({ echo: text });
  return `Echo: ${text || '(empty)'}`;
}

/**
 * In-process mock provider for development and tests. Latency and failure rate
 * are configurable (MOCK_LATENCY_MS / MOCK_FAILURE_RATE); usage is reported as
 * if it came from the upstream (~chars/4).
 */
export class MockAdapter implements ProviderAdapter {
  readonly id: string;
  readonly kind: ProviderKind = 'mock';
  private calls = 0;

  constructor(private readonly opts: MockAdapterOptions = {}) {
    this.id = opts.id ?? 'mock';
  }

  private async reply(req: ChatCompletionRequest, endpoint: Endpoint, signal: AbortSignal) {
    const callIndex = this.calls++;
    await sleep(this.opts.latencyMs ?? 0, signal, this.id);
    if ((this.opts.failureRate ?? 0) > 0 && (this.opts.random ?? Math.random)() < this.opts.failureRate!) {
      throw new ProviderError(this.id, 'server', 'Mock provider: simulated failure', { status: 503 });
    }
    const raw = await (this.opts.script ?? defaultMockReply)(req, { endpoint, callIndex });
    const reply = typeof raw === 'string' ? { content: raw } : raw;
    if (reply.delayMs) await sleep(reply.delayMs, signal, this.id);
    if (reply.error) {
      throw new ProviderError(
        this.id,
        kindForStatus(reply.error.status),
        reply.error.message ?? `Mock error ${reply.error.status}`,
        { status: reply.error.status },
      );
    }
    const toolCalls = reply.tool_calls?.map((t, i) => ({
      id: t.id ?? `call_mock_${callIndex}_${i}`,
      type: 'function' as const,
      function: { name: t.name, arguments: t.arguments ?? '{}' },
    }));
    const content = reply.content ?? (toolCalls?.length ? null : '');
    const promptTokens = req.messages.reduce((n, m) => n + estimateTextTokens(messageText(m)) + 4, 0);
    const completionTokens = estimateTextTokens(
      (content ?? '') + (toolCalls ? JSON.stringify(toolCalls) : ''),
    );
    const usage = reply.omitUsage
      ? undefined
      : {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        };
    return { callIndex, content, toolCalls, usage };
  }

  async chat(req: ChatCompletionRequest, endpoint: Endpoint, { signal }: CallOptions): Promise<ChatResponse> {
    const r = await this.reply(req, endpoint, signal);
    return {
      id: `mock-${r.callIndex}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: endpoint.upstreamModel,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: r.content,
            ...(r.toolCalls?.length ? { tool_calls: r.toolCalls } : {}),
          },
          finish_reason: r.toolCalls?.length ? 'tool_calls' : 'stop',
        },
      ],
      usage: r.usage,
    };
  }

  async *stream(
    req: ChatCompletionRequest,
    endpoint: Endpoint,
    { signal }: CallOptions,
  ): AsyncGenerator<ChatChunk> {
    const r = await this.reply(req, endpoint, signal);
    const base = {
      id: `mock-${r.callIndex}`,
      object: 'chat.completion.chunk' as const,
      created: Math.floor(Date.now() / 1000),
      model: endpoint.upstreamModel,
    };
    yield {
      ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    };
    for (const word of (r.content ?? '').split(/(?<=\s)/).filter(Boolean)) {
      await sleep(this.opts.chunkDelayMs ?? 0, signal, this.id);
      yield { ...base, choices: [{ index: 0, delta: { content: word }, finish_reason: null }] };
    }
    for (const [index, tc] of (r.toolCalls ?? []).entries()) {
      yield {
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index, ...tc }] } as never, finish_reason: null }],
      };
    }
    yield {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: r.toolCalls?.length ? 'tool_calls' : 'stop' }],
    };
    if (r.usage) yield { ...base, choices: [], usage: r.usage };
  }

  async embeddings(
    req: EmbeddingsRequest,
    endpoint: Endpoint,
    { signal }: CallOptions,
  ): Promise<EmbeddingsResponse> {
    await sleep(this.opts.latencyMs ?? 0, signal, this.id);
    const inputs = (Array.isArray(req.input) ? req.input : [req.input]) as unknown[];
    const texts =
      typeof inputs[0] === 'number'
        ? [JSON.stringify(inputs)]
        : inputs.map((i) => (typeof i === 'string' ? i : JSON.stringify(i)));
    const dims = req.dimensions ?? 64;
    const data = texts.map((t, index) => ({
      object: 'embedding' as const,
      index,
      embedding: hashVector(t, dims),
    }));
    const tokens = texts.reduce((n, t) => n + estimateTextTokens(t), 0);
    return {
      object: 'list',
      data,
      model: endpoint.upstreamModel,
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    };
  }
}

/** Deterministic unit vector derived from sha256(text). */
export function hashVector(text: string, dims: number): number[] {
  const out: number[] = [];
  let block = 0;
  while (out.length < dims) {
    const h = createHash('sha256').update(`${block++}:${text}`).digest();
    for (let i = 0; i + 1 < h.length && out.length < dims; i += 2)
      out.push((h.readUInt16BE(i) / 65535) * 2 - 1);
  }
  const norm = Math.sqrt(out.reduce((s, v) => s + v * v, 0)) || 1;
  return out.map((v) => Math.round((v / norm) * 1e6) / 1e6);
}
