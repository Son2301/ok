import type { Endpoint } from '../catalog/types';
import type {
  ChatChunk,
  ChatCompletionRequest,
  ChatMessage,
  ChatResponse,
  ContentPart,
  UpstreamUsage,
} from '../schemas';
import type { ProviderKind } from './config';
import { type ErrorKind, ProviderError } from './errors';
import { parseSseJson, postJson, readJson, readSse } from './http';
import type { CallOptions, ProviderAdapter } from './types';

/*
 * Anthropic Messages API adapter (POST /v1/messages), translating OpenAI Chat
 * Completions both ways: system prompts, multi-part user content with images,
 * assistant tool calls ⇄ tool_use blocks, tool messages ⇄ tool_result blocks,
 * streaming events ⇄ chunk deltas, stop reasons and usage.
 *
 * verified: false — built from the public API reference and unit-tested with
 * fixtures; not yet exercised against the live API.
 */

type AnthropicBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
    }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | AnthropicBlock[]; is_error?: boolean };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

export interface AnthropicTranslateOptions {
  /** `max_tokens` is mandatory on the Messages API; used when the caller sends none. */
  defaultMaxTokens: number;
  /** `anthropic-version`; from 2026-10-21 sampling params are rejected and always stripped. */
  version: string;
  stream: boolean;
}

const JSON_OBJECT_INSTRUCTION =
  'Respond with a single valid JSON object and nothing else: no prose, no Markdown code fences.';

function textOf(content: ChatMessage['content'] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

/** OpenAI image_url (https or data URL) → Anthropic image block. */
export function imageBlock(url: string): AnthropicBlock {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (m) {
    const data = m[2] ? m[3]! : Buffer.from(decodeURIComponent(m[3]!)).toString('base64');
    return { type: 'image', source: { type: 'base64', media_type: m[1]!, data } };
  }
  return { type: 'image', source: { type: 'url', url } };
}

function partsToBlocks(content: ChatMessage['content'] | undefined): AnthropicBlock[] {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: AnthropicBlock[] = [];
  for (const p of content as ContentPart[]) {
    if (p.type === 'text' && p.text.trim()) out.push({ type: 'text', text: p.text });
    else if (p.type === 'image_url') out.push(imageBlock(p.image_url.url));
  }
  return out;
}

function parseArgs(args: string | undefined): unknown {
  if (!args?.trim()) return {};
  try {
    const v = JSON.parse(args);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { _raw: args };
  }
}

const versionAtLeast = (v: string, min: string) => v >= min; // ISO dates compare lexicographically

/** OpenAI chat request → Anthropic Messages request body. */
export function toAnthropicRequest(
  req: ChatCompletionRequest,
  endpoint: Endpoint,
  opts: AnthropicTranslateOptions,
): Record<string, unknown> {
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];
  const push = (role: AnthropicMessage['role'], blocks: AnthropicBlock[]) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    // The API expects alternating turns; merge consecutive same-role messages.
    if (last?.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const m of req.messages) {
    switch (m.role) {
      case 'system':
      case 'developer': {
        const t = textOf(m.content);
        if (t.trim()) system.push(t);
        break;
      }
      case 'user':
        push('user', partsToBlocks(m.content));
        break;
      case 'assistant': {
        const blocks: AnthropicBlock[] = partsToBlocks(m.content).filter((b) => b.type === 'text');
        for (const tc of m.tool_calls ?? []) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: parseArgs(tc.function.arguments),
          });
        }
        push('assistant', blocks);
        break;
      }
      case 'tool': {
        const content: string | AnthropicBlock[] =
          typeof m.content === 'string' || m.content == null ? (m.content ?? '') : partsToBlocks(m.content);
        push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content }]);
        break;
      }
    }
  }

  const rf = req.response_format;
  if (rf?.type === 'json_object') system.push(JSON_OBJECT_INSTRUCTION);
  else if (rf?.type === 'json_schema') {
    const schema = rf.json_schema.schema ? JSON.stringify(rf.json_schema.schema) : '{}';
    system.push(
      `${JSON_OBJECT_INSTRUCTION} The JSON must validate against this JSON Schema (name: ${rf.json_schema.name}):\n${schema}`,
    );
  }

  const requested = req.max_completion_tokens ?? req.max_tokens;
  const cap = endpoint.maxOutputTokens ?? Number.POSITIVE_INFINITY;
  const body: Record<string, unknown> = {
    model: endpoint.upstreamModel,
    max_tokens: requested ?? Math.min(opts.defaultMaxTokens, cap),
    messages,
  };
  if (system.length) body.system = system.join('\n\n');
  // OpenAI temperature is 0–2, Anthropic's is 0–1.
  if (req.temperature !== undefined) body.temperature = Math.min(req.temperature, 1);
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (typeof req.top_k === 'number') body.top_k = req.top_k;
  if (req.stop) body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (req.user) body.metadata = { user_id: req.user };
  if (opts.stream) body.stream = true;

  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      name: t.function.name,
      ...(t.function.description ? { description: t.function.description } : {}),
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
    const tc = req.tool_choice;
    let choice: Record<string, unknown> | undefined;
    if (tc === 'auto') choice = { type: 'auto' };
    else if (tc === 'none') choice = { type: 'none' };
    else if (tc === 'required') choice = { type: 'any' };
    else if (tc && typeof tc === 'object') choice = { type: 'tool', name: tc.function.name };
    if (choice && endpoint.quirks?.noForcedToolChoice && (choice.type === 'any' || choice.type === 'tool'))
      choice = { type: 'auto' };
    if (req.parallel_tool_calls === false)
      choice = { ...(choice ?? { type: 'auto' }), disable_parallel_tool_use: true };
    if (choice) body.tool_choice = choice;
  }

  const drop = new Set(endpoint.quirks?.dropParams ?? []);
  if (versionAtLeast(opts.version, '2026-10-21'))
    for (const p of ['temperature', 'top_p', 'top_k']) drop.add(p);
  for (const p of drop) delete body[p];
  return body;
}

export function mapAnthropicStopReason(
  reason: string | null | undefined,
  hasToolCalls: boolean,
): ChatResponse['choices'][number]['finish_reason'] {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'refusal':
      return 'content_filter';
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return hasToolCalls ? 'tool_calls' : 'stop';
    default:
      return reason ? 'stop' : null;
  }
}

/** Anthropic usage → prompt/completion tokens (cache reads/writes count as prompt tokens). */
export function anthropicUsage(u: Record<string, unknown> | undefined): UpstreamUsage | undefined {
  if (!u) return undefined;
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  const prompt = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens');
  const completion = n('output_tokens');
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

interface AnthropicResponse {
  id: string;
  model: string;
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string | null;
  usage?: Record<string, unknown>;
}

/** Anthropic Messages response → OpenAI chat completion. */
export function fromAnthropicResponse(json: AnthropicResponse): ChatResponse {
  let text = '';
  const toolCalls: NonNullable<ChatMessage['tool_calls']> = [];
  for (const b of json.content ?? []) {
    if (b.type === 'text' && typeof b.text === 'string') text += b.text;
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id ?? '',
        type: 'function',
        function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) },
      });
    }
    // thinking / redacted_thinking blocks are not part of the OpenAI response shape.
  }
  return {
    id: json.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: json.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || (toolCalls.length ? null : ''),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapAnthropicStopReason(json.stop_reason, toolCalls.length > 0),
      },
    ],
    usage: anthropicUsage(json.usage),
  };
}

const ERROR_KINDS: Record<string, ErrorKind> = {
  invalid_request_error: 'bad_request',
  request_too_large: 'bad_request',
  authentication_error: 'auth',
  permission_error: 'auth',
  not_found_error: 'not_found',
  rate_limit_error: 'rate_limit',
  overloaded_error: 'server',
  api_error: 'server',
  timeout_error: 'timeout',
};

type Delta = ChatChunk['choices'][number]['delta'];

/**
 * Stateful translator from Anthropic stream events to OpenAI chunks.
 * Tool-use content blocks become `tool_calls` deltas indexed by their order among tool blocks.
 */
export class AnthropicStreamTranslator {
  private id = '';
  private model = '';
  private readonly created = Math.floor(Date.now() / 1000);
  private readonly toolIndexByBlock = new Map<number, number>();
  private usageRaw: Record<string, unknown> = {};
  private sawUsage = false;
  private sawToolUse = false;

  constructor(private readonly provider = 'anthropic') {}

  private chunk(delta: Delta, finish: ChatChunk['choices'][number]['finish_reason'] = null): ChatChunk {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
  }

  /**
   * A content-free chunk signalling upstream liveness (pings, thinking). The gateway
   * uses it to reset stream timeouts and never forwards it to clients.
   */
  private heartbeat(): ChatChunk {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [],
    };
  }

  get usage(): UpstreamUsage | undefined {
    return this.sawUsage ? anthropicUsage(this.usageRaw) : undefined;
  }

  private mergeUsage(u: unknown) {
    if (!u || typeof u !== 'object') return;
    this.sawUsage = true;
    for (const [k, v] of Object.entries(u as Record<string, unknown>)) {
      // message_delta usage is cumulative; never let a later partial value shrink a counter.
      if (typeof v === 'number')
        this.usageRaw[k] = Math.max(v, (this.usageRaw[k] as number | undefined) ?? 0);
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: wire payloads are validated field by field
  push(eventName: string | undefined, data: any): ChatChunk[] {
    const type: string = data?.type ?? eventName ?? '';
    switch (type) {
      case 'message_start': {
        this.id = data.message?.id ?? '';
        this.model = data.message?.model ?? '';
        this.mergeUsage(data.message?.usage);
        return [this.chunk({ role: 'assistant', content: '' })];
      }
      case 'content_block_start': {
        const block = data.content_block ?? {};
        if (block.type === 'tool_use') {
          const index = this.toolIndexByBlock.size;
          this.toolIndexByBlock.set(data.index, index);
          this.sawToolUse = true;
          return [
            this.chunk({
              tool_calls: [
                { index, id: block.id, type: 'function', function: { name: block.name, arguments: '' } },
              ],
            } as unknown as Delta),
          ];
        }
        if (block.type === 'text' && block.text) return [this.chunk({ content: block.text })];
        return [];
      }
      case 'content_block_delta': {
        const d = data.delta ?? {};
        if (d.type === 'text_delta' && d.text) return [this.chunk({ content: d.text })];
        if (d.type === 'input_json_delta') {
          const index = this.toolIndexByBlock.get(data.index);
          if (index === undefined || !d.partial_json) return [];
          return [
            this.chunk({
              tool_calls: [{ index, function: { arguments: d.partial_json } }],
            } as unknown as Delta),
          ];
        }
        // thinking_delta / signature_delta / citations_delta carry no OpenAI-visible content
        return [this.heartbeat()];
      }
      case 'message_delta': {
        this.mergeUsage(data.usage);
        const reason = data.delta?.stop_reason;
        return reason ? [this.chunk({}, mapAnthropicStopReason(reason, this.sawToolUse))] : [];
      }
      case 'message_stop': {
        const usage = this.usage;
        return usage
          ? [
              {
                id: this.id,
                object: 'chat.completion.chunk',
                created: this.created,
                model: this.model,
                choices: [],
                usage: { ...usage, total_tokens: usage.total_tokens ?? 0 },
              },
            ]
          : [];
      }
      case 'error': {
        const err = data.error ?? {};
        throw new ProviderError(
          this.provider,
          ERROR_KINDS[err.type] ?? 'server',
          err.message ?? 'Upstream stream error',
          { code: err.type },
        );
      }
      case 'ping':
        return [this.heartbeat()];
      default:
        return []; // content_block_stop, unknown future events
    }
  }
}

export interface AnthropicAdapterOptions {
  id?: string;
  baseUrl: string;
  apiKey: string;
  version: string;
  headers?: Record<string, string>;
  defaultMaxTokens?: number;
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly id: string;
  readonly kind: ProviderKind = 'anthropic';
  private readonly defaultMaxTokens: number;

  constructor(private readonly opts: AnthropicAdapterOptions) {
    this.id = opts.id ?? 'anthropic';
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 16_000;
  }

  private url() {
    return `${this.opts.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  }

  private headers(): Record<string, string> {
    return { ...this.opts.headers, 'x-api-key': this.opts.apiKey, 'anthropic-version': this.opts.version };
  }

  private body(req: ChatCompletionRequest, endpoint: Endpoint, stream: boolean) {
    return toAnthropicRequest(req, endpoint, {
      defaultMaxTokens: this.defaultMaxTokens,
      version: this.opts.version,
      stream,
    });
  }

  async chat(req: ChatCompletionRequest, endpoint: Endpoint, { signal }: CallOptions): Promise<ChatResponse> {
    const res = await postJson(this.id, this.url(), this.body(req, endpoint, false), this.headers(), signal);
    const json = await readJson<
      AnthropicResponse & { type?: string; error?: { type?: string; message?: string } }
    >(this.id, res, signal);
    if (json.type === 'error') {
      throw new ProviderError(
        this.id,
        ERROR_KINDS[json.error?.type ?? ''] ?? 'server',
        json.error?.message ?? 'Upstream error',
      );
    }
    return fromAnthropicResponse(json);
  }

  async *stream(
    req: ChatCompletionRequest,
    endpoint: Endpoint,
    { signal }: CallOptions,
  ): AsyncGenerator<ChatChunk> {
    const res = await postJson(this.id, this.url(), this.body(req, endpoint, true), this.headers(), signal);
    if (!res.body) throw new ProviderError(this.id, 'server', 'Upstream anthropic sent an empty stream');
    const tr = new AnthropicStreamTranslator(this.id);
    for await (const ev of readSse(this.id, res.body, signal)) {
      for (const chunk of tr.push(ev.event, parseSseJson(this.id, ev.data))) yield chunk;
    }
  }
}
