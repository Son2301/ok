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
    const toolCalls =
      typeof reply === 'string'
        ? undefined
        : reply.tool_calls?.map((t) => ({ ...t, type: 'function' as const }));
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
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
          finish_reason: toolCalls ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens + completion_tokens,
        cost_micros: 0,
      },
    };
  }

  async *stream(req: ChatRequest): AsyncIterable<ChatChunk> {
    const res = await this.chat(req);
    const message = res.choices[0]?.message;
    const text = typeof message?.content === 'string' ? message.content : '';
    const base = {
      id: res.id,
      object: 'chat.completion.chunk' as const,
      created: res.created,
      model: res.model,
    };
    for (const w of text ? text.split(/(?<=\s)/) : []) {
      yield { ...base, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] };
    }
    // Tool calls stream as OpenAI does: a header fragment, then the arguments in pieces.
    for (const [index, call] of (message?.tool_calls ?? []).entries()) {
      yield {
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: call.id,
                  type: 'function',
                  function: { name: call.function.name, arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      const args = call.function.arguments;
      const mid = Math.ceil(args.length / 2);
      for (const part of [args.slice(0, mid), args.slice(mid)].filter(Boolean)) {
        yield {
          ...base,
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index, function: { arguments: part } }] },
              finish_reason: null,
            },
          ],
        };
      }
    }
    yield {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: res.choices[0]?.finish_reason ?? 'stop' }],
      usage: res.usage,
    };
  }
}
