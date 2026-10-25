import type { LlmClient } from './client';
import type { ChatChunk, ChatRequest, ChatResponse, ToolCall } from './types';

export type MockReply = string | { content?: string; tool_calls?: Omit<ToolCall, 'type'>[] } | ChatResponse;
export type MockHandler = (req: ChatRequest, callIndex: number) => MockReply | Promise<MockReply>;

/**
 * Deterministic in-memory LLM for tests and offline development.
 * Pass a handler (or a queue of replies) and inspect `calls` afterwards.
 */
export class MockLlm implements LlmClient {
  readonly calls: ChatRequest[] = [];
  private readonly handler: MockHandler;

  constructor(handlerOrQueue: MockHandler | MockReply[]) {
    if (Array.isArray(handlerOrQueue)) {
      const queue = [...handlerOrQueue];
      this.handler = () => {
        const next = queue.shift();
        if (next === undefined) throw new Error('MockLlm: reply queue exhausted');
        return next;
      };
    } else {
      this.handler = handlerOrQueue;
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const idx = this.calls.push(req) - 1;
    const reply = await this.handler(req, idx);
    if (typeof reply === 'object' && 'choices' in reply) return reply;
    const content = typeof reply === 'string' ? reply : (reply.content ?? null);
    const toolCalls = typeof reply === 'string' ? undefined : reply.tool_calls?.map((t) => ({ ...t, type: 'function' as const }));
    const promptChars = JSON.stringify(req.messages).length;
    const completionChars = (content ?? '').length + JSON.stringify(toolCalls ?? '').length;
    const prompt_tokens = Math.ceil(promptChars / 4);
    const completion_tokens = Math.ceil(completionChars / 4);
    return {
      id: `mock-${idx}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: req.model,
      provider: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens, cost_micros: 0 },
    };
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const res = await this.chat(req);
    const text = typeof res.choices[0]?.message.content === 'string' ? res.choices[0].message.content : '';
    const words = text.split(/(?<=\s)/);
    for (const w of words) {
      yield { id: res.id, object: 'chat.completion.chunk', created: res.created, model: res.model, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] };
    }
    yield { id: res.id, object: 'chat.completion.chunk', created: res.created, model: res.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: res.usage };
  }
}
