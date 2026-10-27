import { randomId } from '@minh/shared';
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
import { kindForStatus, ProviderError } from './errors';
import { parseSseJson, postJson, readJson, readSse } from './http';
import type { CallOptions, ProviderAdapter } from './types';

/*
 * Google Gemini adapter using the native `generateContent` /
 * `streamGenerateContent?alt=sse` endpoints (not the OpenAI-compatible beta
 * endpoint): native responses carry exact `usageMetadata` (incl. thinking
 * tokens) on streams, safety/block reasons, and function-calling semantics,
 * and the native API is the stable surface Google versions and documents first.
 * See README → "Why native Gemini".
 *
 * Gemini 3 models return `thoughtSignature`s on function calls that must be sent
 * back on the next turn. They round-trip through the OpenAI tool call as
 * `extra_content.google.thought_signature` (the same convention as Google's own
 * OpenAI-compatibility layer).
 *
 * verified: false — built from the public API reference and fixture-tested only.
 */

type GeminiPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { mimeType?: string; fileUri: string } }
  | { functionCall: { name: string; args?: unknown; id?: string }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown>; id?: string } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  '$id',
  '$comment',
  'additionalProperties',
  'strict',
  'examples',
]);

/** Gemini accepts an OpenAPI 3 subset of JSON Schema; strip keywords it rejects. */
export function sanitizeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
    out[k] =
      k === 'properties' && v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, sanitizeSchema(pv)]),
          )
        : sanitizeSchema(v);
  }
  return out;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
};

export function imagePart(url: string): GeminiPart {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (m) {
    const data = m[2] ? m[3]! : Buffer.from(decodeURIComponent(m[3]!)).toString('base64');
    return { inlineData: { mimeType: m[1]!, data } };
  }
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  return { fileData: { mimeType: (ext && MIME_BY_EXT[ext]) || 'image/jpeg', fileUri: url } };
}

function userParts(content: ChatMessage['content'] | undefined): GeminiPart[] {
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: GeminiPart[] = [];
  for (const p of content as ContentPart[]) {
    if (p.type === 'text' && p.text) out.push({ text: p.text });
    else if (p.type === 'image_url') out.push(imagePart(p.image_url.url));
  }
  return out;
}

function textOf(content: ChatMessage['content'] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

function parseArgs(args: string | undefined): unknown {
  if (!args?.trim()) return {};
  try {
    return JSON.parse(args);
  } catch {
    return { _raw: args };
  }
}

/** functionResponse.response must be a JSON object. */
function toolResponseObject(content: ChatMessage['content'] | undefined): Record<string, unknown> {
  const text = textOf(content);
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return { result: v };
  } catch {
    return { result: text };
  }
}

/** OpenAI chat request → Gemini generateContent request body. */
export function toGeminiRequest(req: ChatCompletionRequest, endpoint: Endpoint): Record<string, unknown> {
  const system: string[] = [];
  const contents: GeminiContent[] = [];
  const toolNames = new Map<string, string>();
  const push = (role: GeminiContent['role'], parts: GeminiPart[]) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
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
        push('user', userParts(m.content));
        break;
      case 'assistant': {
        const parts: GeminiPart[] = [];
        const t = textOf(m.content);
        if (t) parts.push({ text: t });
        for (const tc of m.tool_calls ?? []) {
          toolNames.set(tc.id, tc.function.name);
          const sig = (tc as { extra_content?: { google?: { thought_signature?: string } } }).extra_content
            ?.google?.thought_signature;
          parts.push({
            functionCall: { name: tc.function.name, args: parseArgs(tc.function.arguments) },
            ...(sig ? { thoughtSignature: sig } : {}),
          });
        }
        push('model', parts);
        break;
      }
      case 'tool': {
        const name = toolNames.get(m.tool_call_id ?? '') ?? m.name ?? 'tool';
        push('user', [{ functionResponse: { name, response: toolResponseObject(m.content) } }]);
        break;
      }
    }
  }

  const generationConfig: Record<string, unknown> = {};
  if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
  if (req.top_p !== undefined) generationConfig.topP = req.top_p;
  const maxTokens = req.max_completion_tokens ?? req.max_tokens;
  if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
  if (req.stop) generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (typeof req.seed === 'number') generationConfig.seed = req.seed;
  const rf = req.response_format;
  if (rf?.type === 'json_object') generationConfig.responseMimeType = 'application/json';
  else if (rf?.type === 'json_schema') {
    generationConfig.responseMimeType = 'application/json';
    if (rf.json_schema.schema) generationConfig.responseSchema = sanitizeSchema(rf.json_schema.schema);
  }

  const body: Record<string, unknown> = { contents };
  if (system.length) body.systemInstruction = { parts: [{ text: system.join('\n\n') }] };
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

  if (req.tools?.length) {
    body.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.function.name,
          ...(t.function.description ? { description: t.function.description } : {}),
          ...(t.function.parameters ? { parameters: sanitizeSchema(t.function.parameters) } : {}),
        })),
      },
    ];
    const tc = req.tool_choice;
    let config: Record<string, unknown> | undefined;
    if (tc === 'auto') config = { mode: 'AUTO' };
    else if (tc === 'none') config = { mode: 'NONE' };
    else if (tc === 'required') config = { mode: 'ANY' };
    else if (tc && typeof tc === 'object') config = { mode: 'ANY', allowedFunctionNames: [tc.function.name] };
    if (config) body.toolConfig = { functionCallingConfig: config };
  }

  for (const p of endpoint.quirks?.dropParams ?? []) {
    const key = p === 'top_p' ? 'topP' : p === 'max_tokens' ? 'maxOutputTokens' : p;
    delete generationConfig[key];
  }
  return body;
}

export function mapGeminiFinish(
  reason: string | undefined,
  hasToolCalls: boolean,
  blocked: boolean,
): ChatResponse['choices'][number]['finish_reason'] {
  if (blocked) return 'content_filter';
  switch (reason) {
    case undefined:
    case null:
      return null;
    case 'STOP':
      return hasToolCalls ? 'tool_calls' : 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'content_filter';
    case 'MALFORMED_FUNCTION_CALL':
      return 'error';
    default:
      return hasToolCalls ? 'tool_calls' : 'stop';
  }
}

export function geminiUsage(u: Record<string, unknown> | undefined): UpstreamUsage | undefined {
  if (!u) return undefined;
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  const prompt = n('promptTokenCount') + n('toolUsePromptTokenCount');
  // Thinking tokens are billed as output.
  const completion = n('candidatesTokenCount') + n('thoughtsTokenCount');
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

interface GeminiResponse {
  responseId?: string;
  modelVersion?: string;
  candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: Record<string, unknown>;
  error?: { code?: number; message?: string; status?: string };
}

type ToolCallOut = NonNullable<ChatMessage['tool_calls']>[number] & {
  extra_content?: { google: { thought_signature: string } };
};

function toolCallFromPart(part: Record<string, unknown>): ToolCallOut | undefined {
  const fc = part.functionCall as { name?: string; args?: unknown; id?: string } | undefined;
  if (!fc?.name) return undefined;
  const sig = typeof part.thoughtSignature === 'string' ? part.thoughtSignature : undefined;
  return {
    id: fc.id ?? `call_${randomId(16)}`,
    type: 'function',
    function: { name: fc.name, arguments: JSON.stringify(fc.args ?? {}) },
    ...(sig ? { extra_content: { google: { thought_signature: sig } } } : {}),
  };
}

const visibleText = (p: Record<string, unknown>) => (typeof p.text === 'string' && !p.thought ? p.text : '');

/** Gemini generateContent response → OpenAI chat completion. */
export function fromGeminiResponse(json: GeminiResponse, model: string): ChatResponse {
  const cand = json.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const text = parts.map(visibleText).join('');
  const toolCalls = parts.map(toolCallFromPart).filter((t): t is ToolCallOut => Boolean(t));
  return {
    id: json.responseId ?? `gen-${randomId(16)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: json.modelVersion ?? model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || (toolCalls.length ? null : ''),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapGeminiFinish(
          cand?.finishReason ?? 'STOP',
          toolCalls.length > 0,
          Boolean(json.promptFeedback?.blockReason),
        ),
      },
    ],
    usage: geminiUsage(json.usageMetadata),
  };
}

type Delta = ChatChunk['choices'][number]['delta'];

/** Translates streamed GenerateContentResponse chunks into OpenAI chunks. */
export class GeminiStreamTranslator {
  private readonly id = `gen-${randomId(16)}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private started = false;
  private toolIndex = 0;
  private usageMeta?: Record<string, unknown>;

  constructor(
    private readonly model: string,
    private readonly provider = 'google',
  ) {}

  private chunk(delta: Delta, finish: ChatChunk['choices'][number]['finish_reason'] = null): ChatChunk {
    return {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
  }

  get usage(): UpstreamUsage | undefined {
    return geminiUsage(this.usageMeta);
  }

  push(json: GeminiResponse): ChatChunk[] {
    if (json.error) {
      const status = json.error.code;
      throw new ProviderError(
        this.provider,
        status ? kindForStatus(status) : 'server',
        json.error.message ?? 'Upstream stream error',
        { status, code: json.error.status },
      );
    }
    const out: ChatChunk[] = [];
    if (!this.started) {
      this.started = true;
      out.push(this.chunk({ role: 'assistant', content: '' }));
    }
    if (json.usageMetadata) this.usageMeta = json.usageMetadata; // cumulative; last one wins
    const cand = json.candidates?.[0];
    let hadToolCall = false;
    for (const part of cand?.content?.parts ?? []) {
      const text = visibleText(part);
      if (text) out.push(this.chunk({ content: text }));
      const tc = toolCallFromPart(part);
      if (tc) {
        hadToolCall = true;
        out.push(this.chunk({ tool_calls: [{ index: this.toolIndex++, ...tc }] } as unknown as Delta));
      }
    }
    const blocked = Boolean(json.promptFeedback?.blockReason);
    if (cand?.finishReason || blocked) {
      out.push(
        this.chunk({}, mapGeminiFinish(cand?.finishReason, hadToolCall || this.toolIndex > 0, blocked)),
      );
    }
    // Thought-only (or usage-only) chunks: emit a content-free heartbeat so the gateway
    // knows the upstream is alive; it is never forwarded to the client.
    if (!out.length)
      out.push({
        id: this.id,
        object: 'chat.completion.chunk',
        created: this.created,
        model: this.model,
        choices: [],
      });
    return out;
  }

  /** Final usage chunk, emitted once the upstream stream ends. */
  finish(): ChatChunk[] {
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
}

export interface GoogleAdapterOptions {
  id?: string;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}

export class GoogleAdapter implements ProviderAdapter {
  readonly id: string;
  readonly kind: ProviderKind = 'google';

  constructor(private readonly opts: GoogleAdapterOptions) {
    this.id = opts.id ?? 'google';
  }

  private url(model: string, stream: boolean) {
    const base = this.opts.baseUrl.replace(/\/+$/, '');
    return stream
      ? `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
      : `${base}/models/${encodeURIComponent(model)}:generateContent`;
  }

  private headers(): Record<string, string> {
    return { ...this.opts.headers, 'x-goog-api-key': this.opts.apiKey };
  }

  async chat(req: ChatCompletionRequest, endpoint: Endpoint, { signal }: CallOptions): Promise<ChatResponse> {
    const res = await postJson(
      this.id,
      this.url(endpoint.upstreamModel, false),
      toGeminiRequest(req, endpoint),
      this.headers(),
      signal,
    );
    const json = await readJson<GeminiResponse>(this.id, res, signal);
    if (json.error) {
      const status = json.error.code;
      throw new ProviderError(
        this.id,
        status ? kindForStatus(status) : 'server',
        json.error.message ?? 'Upstream error',
        { status },
      );
    }
    return fromGeminiResponse(json, endpoint.upstreamModel);
  }

  async *stream(
    req: ChatCompletionRequest,
    endpoint: Endpoint,
    { signal }: CallOptions,
  ): AsyncGenerator<ChatChunk> {
    const res = await postJson(
      this.id,
      this.url(endpoint.upstreamModel, true),
      toGeminiRequest(req, endpoint),
      this.headers(),
      signal,
    );
    if (!res.body) throw new ProviderError(this.id, 'server', 'Upstream google sent an empty stream');
    const tr = new GeminiStreamTranslator(endpoint.upstreamModel, this.id);
    for await (const ev of readSse(this.id, res.body, signal)) {
      for (const chunk of tr.push(parseSseJson<GeminiResponse>(this.id, ev.data))) yield chunk;
    }
    for (const chunk of tr.finish()) yield chunk;
  }
}
