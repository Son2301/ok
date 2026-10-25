import type { ChatMessage, ChatRequest, LlmClient, ToolCall, Usage } from '@ok/llm';
import { responseText } from '@ok/llm';
import { mapLimit } from '../lib/async';
import { truncate } from '../lib/text';
import type {
  StopReason,
  ToolOutcome,
  ToolTrace,
  TurnEvent,
  TurnRequest,
  TurnResult,
  TurnUsage,
} from './types';

/**
 * The agent loop, shared by every execution mode (inline driver, builtin
 * container runtime). Pure: the LLM client and tool executor are injected,
 * so it runs the same in-process, in a container, or in tests with MockLlm.
 *
 * call LLM with tools → execute requested tools (independent calls in parallel,
 * side-effecting ones sequentially) → feed results back → repeat until a final
 * answer, `maxSteps`, the token budget or the time budget.
 */

export interface LoopToolExecutor {
  execute(call: { id: string; name: string; arguments: unknown }, signal: AbortSignal): Promise<ToolOutcome>;
}

export interface RunLoopOptions {
  llm: LlmClient;
  request: TurnRequest;
  tools: LoopToolExecutor;
  onEvent?: (e: TurnEvent) => void;
  /** Stream tokens (`delta` events). Tool-call deltas are reassembled. */
  stream?: boolean;
  /** External cancellation (in addition to the time budget). */
  signal?: AbortSignal;
}

const TOOL_RESULT_MAX_CHARS = 16_000;
const PARALLEL_TOOL_LIMIT = 4;

const FALLBACK: Record<'vi' | 'en', Record<Exclude<StopReason, 'final'>, string>> = {
  vi: {
    time_budget:
      'Xin lỗi, tôi chưa kịp hoàn thành yêu cầu này trong thời gian cho phép. Bạn vui lòng thử lại hoặc nói cụ thể hơn nhé.',
    token_budget:
      'Xin lỗi, yêu cầu này vượt quá giới hạn xử lý cho một lượt trả lời. Bạn vui lòng chia nhỏ yêu cầu nhé.',
    max_steps:
      'Xin lỗi, tôi cần thêm bước để xử lý yêu cầu này. Bạn vui lòng thử lại hoặc nói cụ thể hơn nhé.',
  },
  en: {
    time_budget:
      "Sorry, I couldn't finish this request in the time allowed. Please try again or narrow it down.",
    token_budget:
      'Sorry, this request exceeds the processing limit for a single reply. Please split it into smaller requests.',
    max_steps: 'Sorry, I need more steps to complete this request. Please try again or be more specific.',
  },
};

class TimeBudgetExceeded extends Error {
  constructor() {
    super('Turn time budget exceeded');
  }
}

const estimate = (s: string) => Math.ceil(s.length / 4);

export function toolMessageContent(outcome: ToolOutcome): string {
  const payload = outcome.ok
    ? (outcome.result ?? null)
    : { error: outcome.error ?? 'Tool failed', outcome: outcome.outcome };
  return truncate(typeof payload === 'string' ? payload : JSON.stringify(payload), TOOL_RESULT_MAX_CHARS);
}

export async function runAgentLoop(opts: RunLoopOptions): Promise<TurnResult> {
  const req = opts.request;
  const locale = req.locale ?? 'vi';
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new TimeBudgetExceeded()), Math.max(0, req.budget.maxMs));
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline.signal]) : deadline.signal;
  const sequential = new Set(req.sequentialTools ?? []);
  const history: ChatMessage[] = [...req.messages];
  const produced: TurnResult['messages'] = [];
  const traces: ToolTrace[] = [];
  const usage: TurnUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, costMicros: 0 };
  let reply = '';
  let stopReason: StopReason = 'final';
  let steps = 0;

  try {
    for (let step = 1; step <= req.maxSteps; step++) {
      if (usage.totalTokens >= req.budget.maxTokens) {
        stopReason = 'token_budget';
        break;
      }
      if (deadline.signal.aborted) {
        stopReason = 'time_budget';
        break;
      }
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('Turn aborted');
      steps = step;
      opts.onEvent?.({ type: 'step', step });
      const isLast = step === req.maxSteps;
      const remaining = req.budget.maxTokens - usage.totalTokens;
      const chatReq: ChatRequest = {
        model: req.model,
        messages: [...history],
        ...(req.tools.length ? { tools: req.tools, tool_choice: isLast ? 'none' : 'auto' } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(remaining < 4096 ? { max_tokens: Math.max(256, remaining) } : {}),
      };

      let assistant: ChatMessage;
      let stepUsage: Usage;
      try {
        ({ message: assistant, usage: stepUsage } = opts.stream
          ? await streamStep(opts.llm, chatReq, signal, opts.onEvent)
          : await chatStep(opts.llm, chatReq, signal));
      } catch (err) {
        if (deadline.signal.aborted && !opts.signal?.aborted) {
          stopReason = 'time_budget';
          break;
        }
        throw err;
      }
      usage.promptTokens += stepUsage.prompt_tokens;
      usage.completionTokens += stepUsage.completion_tokens;
      usage.totalTokens += stepUsage.total_tokens;
      usage.costMicros += stepUsage.cost_micros ?? 0;

      let calls = (assistant.tool_calls ?? []).map((c, i) => ({ ...c, id: c.id || `call_${step}_${i}` }));
      if (isLast && calls.length) {
        // The model ignored tool_choice "none"; drop the calls so history stays well-formed.
        calls = [];
        stopReason = 'max_steps';
      }
      const stored: ChatMessage = {
        role: 'assistant',
        content: textOf(assistant) || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      };
      produced.push({
        ...stored,
        usage: { prompt: stepUsage.prompt_tokens, completion: stepUsage.completion_tokens },
      });
      history.push(stored);

      if (!calls.length) {
        reply = textOf(assistant);
        break;
      }

      const outcomes = await executeCalls(calls, opts.tools, sequential, signal, opts.onEvent, traces);
      for (let i = 0; i < calls.length; i++) {
        const toolMsg: ChatMessage = {
          role: 'tool',
          tool_call_id: calls[i]!.id,
          name: calls[i]!.function.name,
          content: toolMessageContent(outcomes[i]!),
        };
        produced.push(toolMsg);
        history.push(toolMsg);
      }
    }
  } finally {
    clearTimeout(timer);
  }

  if (!reply) {
    if (stopReason === 'final') stopReason = 'max_steps';
    reply = FALLBACK[locale][stopReason as Exclude<StopReason, 'final'>];
    const last = produced[produced.length - 1];
    // Replace an empty trailing assistant message, otherwise append the fallback.
    if (last && last.role === 'assistant' && !last.tool_calls?.length && !last.content) last.content = reply;
    else produced.push({ role: 'assistant', content: reply });
  }

  return { reply, messages: produced, toolCalls: traces, usage, steps, stopReason };
}

function textOf(msg: ChatMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) return msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return '';
}

async function chatStep(
  llm: LlmClient,
  req: ChatRequest,
  signal: AbortSignal,
): Promise<{ message: ChatMessage; usage: Usage }> {
  const res = await llm.chat(req, { signal });
  const message = res.choices[0]?.message ?? { role: 'assistant', content: '' };
  const usage = res.usage ?? {
    prompt_tokens: estimate(JSON.stringify(req.messages)),
    completion_tokens: estimate(responseText(res) + JSON.stringify(message.tool_calls ?? '')),
    total_tokens: 0,
  };
  if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  return {
    message: {
      role: 'assistant',
      content: message.content ?? null,
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
    },
    usage,
  };
}

async function streamStep(
  llm: LlmClient,
  req: ChatRequest,
  signal: AbortSignal,
  onEvent?: (e: TurnEvent) => void,
): Promise<{ message: ChatMessage; usage: Usage }> {
  let content = '';
  const acc = new Map<number, { id: string; name: string; args: string }>();
  let usage: Usage | null = null;
  let lastIndex = -1;
  for await (const chunk of llm.stream(req, { signal })) {
    const delta = chunk.choices?.[0]?.delta;
    if (typeof delta?.content === 'string' && delta.content) {
      content += delta.content;
      onEvent?.({ type: 'delta', text: delta.content });
    }
    for (const tc of (delta?.tool_calls ?? []) as (Partial<ToolCall> & {
      index?: number;
      function?: Partial<ToolCall['function']>;
    })[]) {
      const idx = tc.index ?? (tc.id ? lastIndex + 1 : Math.max(lastIndex, 0));
      lastIndex = Math.max(lastIndex, idx);
      const cur = acc.get(idx) ?? { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      acc.set(idx, cur);
    }
    if (chunk.usage) usage = chunk.usage;
  }
  const toolCalls: ToolCall[] = [...acc.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, c]) => c.name)
    .map(([i, c]) => ({
      id: c.id || `call_s${i}`,
      type: 'function',
      function: { name: c.name, arguments: c.args || '{}' },
    }));
  const u = usage ?? {
    prompt_tokens: estimate(JSON.stringify(req.messages)),
    completion_tokens: estimate(content + JSON.stringify(toolCalls)),
    total_tokens: 0,
  };
  if (!u.total_tokens) u.total_tokens = u.prompt_tokens + u.completion_tokens;
  return {
    message: {
      role: 'assistant',
      content: content || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    usage: u,
  };
}

async function executeCalls(
  calls: ToolCall[],
  tools: LoopToolExecutor,
  sequential: Set<string>,
  signal: AbortSignal,
  onEvent: ((e: TurnEvent) => void) | undefined,
  traces: ToolTrace[],
): Promise<ToolOutcome[]> {
  const outcomes = new Array<ToolOutcome>(calls.length);
  const stepTraces = new Array<ToolTrace>(calls.length);
  const runOne = async (i: number) => {
    const call = calls[i]!;
    const name = call.function.name;
    let args: unknown = {};
    let outcome: ToolOutcome;
    try {
      args = call.function.arguments?.trim() ? JSON.parse(call.function.arguments) : {};
    } catch {
      outcome = { ok: false, outcome: 'error', error: 'Tool arguments were not valid JSON', durationMs: 0 };
      outcomes[i] = outcome;
      stepTraces[i] = {
        id: call.id,
        name,
        arguments: call.function.arguments,
        ok: false,
        outcome: 'error',
        error: outcome.error,
        preview: '',
        durationMs: 0,
      };
      onEvent?.({
        type: 'tool_result',
        id: call.id,
        name,
        ok: false,
        outcome: 'error',
        preview: outcome.error!,
        durationMs: 0,
      });
      return;
    }
    onEvent?.({ type: 'tool_call', id: call.id, name, arguments: args });
    const started = Date.now();
    try {
      outcome = await tools.execute({ id: call.id, name, arguments: args }, signal);
    } catch (err) {
      outcome = {
        ok: false,
        outcome: 'error',
        error: (err as Error).message || 'Tool failed',
        durationMs: Date.now() - started,
      };
    }
    outcomes[i] = outcome;
    const preview = truncate(toolMessageContent(outcome), 300);
    stepTraces[i] = {
      id: call.id,
      name,
      arguments: args,
      ok: outcome.ok,
      outcome: outcome.outcome,
      ...(outcome.error ? { error: outcome.error } : {}),
      preview,
      durationMs: outcome.durationMs,
    };
    onEvent?.({
      type: 'tool_result',
      id: call.id,
      name,
      ok: outcome.ok,
      outcome: outcome.outcome,
      preview,
      durationMs: outcome.durationMs,
    });
  };

  const parallel = calls.map((_, i) => i).filter((i) => !sequential.has(calls[i]!.function.name));
  const serial = calls.map((_, i) => i).filter((i) => sequential.has(calls[i]!.function.name));
  await Promise.all([
    mapLimit(parallel, PARALLEL_TOOL_LIMIT, runOne),
    (async () => {
      for (const i of serial) await runOne(i);
    })(),
  ]);
  traces.push(...stepTraces);
  return outcomes;
}
