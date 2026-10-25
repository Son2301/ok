import type { ChatChunk, ChatRequest, LlmClient } from '@ok/llm';
import { MockLlm } from '@ok/llm';
import { describe, expect, it } from 'vitest';
import { type LoopToolExecutor, runAgentLoop } from './loop';
import type { ToolOutcome, TurnEvent, TurnRequest } from './types';

const tools = [
  {
    type: 'function' as const,
    function: {
      name: 'lookup_order',
      parameters: { type: 'object', properties: { code: { type: 'string' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'check_stock',
      parameters: { type: 'object', properties: { sku: { type: 'string' } } },
    },
  },
  { type: 'function' as const, function: { name: 'send_message', parameters: { type: 'object' } } },
];

const baseRequest = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  agentId: 'agt_1',
  conversationId: 'cnv_1',
  model: 'auto',
  messages: [
    { role: 'system', content: 'You are a shop assistant.' },
    { role: 'user', content: 'Đơn DH001 của tôi tới đâu rồi? Áo M còn hàng không?' },
  ],
  tools,
  maxSteps: 8,
  budget: { maxTokens: 100_000, maxMs: 5_000 },
  ...over,
});

type Args = Record<string, string>;
function executor(impl: (name: string, args: Args) => unknown | Promise<unknown>) {
  const calls: { name: string; args: Args }[] = [];
  const exec: LoopToolExecutor = {
    async execute(call): Promise<ToolOutcome> {
      calls.push({ name: call.name, args: call.arguments as Args });
      try {
        return {
          ok: true,
          outcome: 'executed',
          result: await impl(call.name, call.arguments as Args),
          durationMs: 1,
        };
      } catch (err) {
        return { ok: false, outcome: 'error', error: (err as Error).message, durationMs: 1 };
      }
    },
  };
  return { exec, calls };
}

describe('runAgentLoop', () => {
  it('runs a multi-step tool loop and returns the final answer with traces and usage', async () => {
    const llm = new MockLlm([
      {
        tool_calls: [
          { id: 'c1', function: { name: 'lookup_order', arguments: '{"code":"DH001"}' } },
          { id: 'c2', function: { name: 'check_stock', arguments: '{"sku":"AO-M"}' } },
        ],
      },
      {
        tool_calls: [{ id: 'c3', function: { name: 'lookup_order', arguments: '{"code":"DH001-detail"}' } }],
      },
      'Đơn DH001 đang giao, dự kiến mai tới. Áo size M còn 12 cái.',
    ]);
    const { exec, calls } = executor((name, args) =>
      name === 'lookup_order' ? { code: args.code, status: 'shipping' } : { sku: args.sku, onHand: 12 },
    );
    const events: TurnEvent[] = [];
    const res = await runAgentLoop({
      llm,
      request: baseRequest(),
      tools: exec,
      onEvent: (e) => events.push(e),
    });

    expect(res.reply).toContain('DH001');
    expect(res.stopReason).toBe('final');
    expect(res.steps).toBe(3);
    expect(calls.map((c) => c.name)).toEqual(['lookup_order', 'check_stock', 'lookup_order']);
    expect(res.toolCalls.map((t) => t.id)).toEqual(['c1', 'c2', 'c3']);
    expect(res.toolCalls.every((t) => t.ok)).toBe(true);
    // assistant(tool_calls) → tool → tool → assistant(tool_calls) → tool → assistant(final)
    expect(res.messages.map((m) => m.role)).toEqual([
      'assistant',
      'tool',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(res.messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'c1', name: 'lookup_order' });
    expect(JSON.parse(res.messages[2]!.content as string)).toEqual({ sku: 'AO-M', onHand: 12 });
    expect(res.usage.totalTokens).toBeGreaterThan(0);
    // The second LLM call sees the tool results of the first.
    const second = llm.calls[1]!.messages;
    expect(second.filter((m) => m.role === 'tool')).toHaveLength(2);
    expect(llm.calls[0]!.tool_choice).toBe('auto');
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(3);
  });

  it('executes independent tool calls in parallel but side-effecting ones sequentially', async () => {
    const llm = new MockLlm([
      {
        tool_calls: [
          { id: 'a', function: { name: 'lookup_order', arguments: '{}' } },
          { id: 'b', function: { name: 'check_stock', arguments: '{}' } },
          { id: 'c', function: { name: 'send_message', arguments: '{}' } },
          { id: 'd', function: { name: 'send_message', arguments: '{}' } },
        ],
      },
      'done',
    ]);
    let inFlight = 0;
    let maxReadParallel = 0;
    let sendInFlight = 0;
    let maxSendParallel = 0;
    const exec: LoopToolExecutor = {
      async execute(call) {
        if (call.name === 'send_message') {
          sendInFlight++;
          maxSendParallel = Math.max(maxSendParallel, sendInFlight);
          await new Promise((r) => setTimeout(r, 15));
          sendInFlight--;
        } else {
          inFlight++;
          maxReadParallel = Math.max(maxReadParallel, inFlight);
          await new Promise((r) => setTimeout(r, 15));
          inFlight--;
        }
        return { ok: true, outcome: 'executed', result: call.id, durationMs: 15 };
      },
    };
    const res = await runAgentLoop({
      llm,
      request: baseRequest({ sequentialTools: ['send_message'] }),
      tools: exec,
    });
    expect(maxReadParallel).toBe(2);
    expect(maxSendParallel).toBe(1);
    // Tool messages keep the order of the calls regardless of completion order.
    expect(res.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('feeds tool errors and invalid JSON arguments back to the model', async () => {
    const llm = new MockLlm([
      {
        tool_calls: [
          { id: 'x', function: { name: 'lookup_order', arguments: '{not json' } },
          { id: 'y', function: { name: 'check_stock', arguments: '{"sku":"Z"}' } },
        ],
      },
      'Xin lỗi, hệ thống đang lỗi.',
    ]);
    const { exec, calls } = executor(() => {
      throw new Error('KiotViet unavailable');
    });
    const res = await runAgentLoop({ llm, request: baseRequest(), tools: exec });
    expect(calls.map((c) => c.name)).toEqual(['check_stock']);
    const toolMsgs = res.messages.filter((m) => m.role === 'tool');
    expect(JSON.parse(toolMsgs[0]!.content as string).error).toMatch(/not valid JSON/);
    expect(JSON.parse(toolMsgs[1]!.content as string).error).toBe('KiotViet unavailable');
    expect(res.toolCalls.map((t) => t.ok)).toEqual([false, false]);
    expect(res.reply).toContain('Xin lỗi');
  });

  it('stops at maxSteps, forcing a text answer on the last step', async () => {
    const llm = new MockLlm((req) =>
      req.tool_choice === 'none'
        ? 'Tôi đã kiểm tra nhiều lần nhưng chưa có kết quả.'
        : { tool_calls: [{ id: `t${Math.random()}`, function: { name: 'lookup_order', arguments: '{}' } }] },
    );
    const { exec, calls } = executor(() => ({ status: 'unknown' }));
    const res = await runAgentLoop({ llm, request: baseRequest({ maxSteps: 3 }), tools: exec });
    expect(llm.calls).toHaveLength(3);
    expect(llm.calls[2]!.tool_choice).toBe('none');
    expect(calls).toHaveLength(2);
    expect(res.reply).toContain('chưa có kết quả');
  });

  it('falls back gracefully when the model keeps calling tools at the step limit', async () => {
    const llm = new MockLlm(() => ({
      tool_calls: [{ id: 'loop', function: { name: 'lookup_order', arguments: '{}' } }],
    }));
    const { exec } = executor(() => ({}));
    const res = await runAgentLoop({ llm, request: baseRequest({ maxSteps: 2, locale: 'en' }), tools: exec });
    expect(res.stopReason).toBe('max_steps');
    expect(res.reply).toMatch(/more steps/);
    const last = res.messages[res.messages.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.tool_calls).toBeUndefined();
  });

  it('enforces the per-turn token budget', async () => {
    const llm = new MockLlm(() => ({
      tool_calls: [{ id: 'b', function: { name: 'check_stock', arguments: '{}' } }],
    }));
    const { exec } = executor(() => ({ data: 'x'.repeat(2000) }));
    const res = await runAgentLoop({
      llm,
      request: baseRequest({ budget: { maxTokens: 1200, maxMs: 5000 } }),
      tools: exec,
    });
    expect(res.stopReason).toBe('token_budget');
    expect(res.steps).toBeLessThan(8);
    expect(res.reply).toMatch(/giới hạn/);
  });

  it('enforces the per-turn time budget', async () => {
    const slow: LlmClient = {
      async chat(_req: ChatRequest, o?: { signal?: AbortSignal }) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 2000);
          o?.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        });
        throw new Error('unreachable');
      },
      async *stream() {},
    };
    const started = Date.now();
    const res = await runAgentLoop({
      llm: slow,
      request: baseRequest({ budget: { maxTokens: 10_000, maxMs: 50 } }),
      tools: executor(() => ({})).exec,
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(res.stopReason).toBe('time_budget');
    expect(res.reply).toMatch(/thời gian/);
  });

  it('streams text deltas and reassembles streamed tool calls', async () => {
    let call = 0;
    const streaming: LlmClient = {
      async chat() {
        throw new Error('not used');
      },
      async *stream(): AsyncIterable<ChatChunk> {
        const base = { id: 's', object: 'chat.completion.chunk' as const, created: 0, model: 'm' };
        if (call++ === 0) {
          yield {
            ...base,
            choices: [{ index: 0, delta: { content: 'Để mình kiểm tra… ' }, finish_reason: null }],
          };
          yield {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'sc1',
                      type: 'function',
                      function: { name: 'check_', arguments: '{"sk' },
                    },
                  ],
                } as never,
                finish_reason: null,
              },
            ],
          };
          yield {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { name: 'stock', arguments: 'u":"AO-M"}' } }],
                } as never,
                finish_reason: 'tool_calls',
              },
            ],
          };
          yield {
            ...base,
            choices: [],
            usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
          };
        } else {
          for (const w of ['Còn ', '12 ', 'cái.'])
            yield { ...base, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] };
          yield {
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 80, completion_tokens: 5, total_tokens: 85 },
          };
        }
      },
    };
    const { exec, calls } = executor((_n, args) => ({ sku: args.sku, onHand: 12 }));
    const deltas: string[] = [];
    const res = await runAgentLoop({
      llm: streaming,
      request: baseRequest(),
      tools: exec,
      stream: true,
      onEvent: (e) => e.type === 'delta' && deltas.push(e.text),
    });
    expect(calls).toEqual([{ name: 'check_stock', args: { sku: 'AO-M' } }]);
    expect(deltas.join('')).toBe('Để mình kiểm tra… Còn 12 cái.');
    expect(res.reply).toBe('Còn 12 cái.');
    expect(res.usage.totalTokens).toBe(145);
  });
});
