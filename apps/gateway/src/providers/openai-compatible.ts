import type { Endpoint } from '../catalog/types';
import type {
  ChatChunk,
  ChatCompletionRequest,
  ChatResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
  UpstreamUsage,
} from '../schemas';
import type { ProviderKind } from './config';
import { extractErrorMessage, kindForStatus, ProviderError } from './errors';
import { parseSseJson, postJson, readJson, readSse } from './http';
import { applyQuirks, type CallOptions, GATEWAY_ONLY_FIELDS, type ProviderAdapter } from './types';

export interface OpenAICompatibleOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Send `stream_options.include_usage` so the final chunk carries usage. Default true. */
  supportsStreamUsage?: boolean;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** Normalize the many usage shapes seen in the wild (OpenAI, Groq `x_groq`, Anthropic-style names). */
export function normalizeUsage(u: unknown): UpstreamUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const o = u as Record<string, unknown>;
  const prompt = Number(o.prompt_tokens ?? o.input_tokens);
  if (!Number.isFinite(prompt)) return undefined;
  const completion = Number(o.completion_tokens ?? o.output_tokens ?? 0) || 0;
  const total = Number(o.total_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number.isFinite(total) ? total : prompt + completion,
  };
}

function midStreamError(provider: string, err: unknown): ProviderError {
  const e = (typeof err === 'object' && err ? err : { message: String(err) }) as Record<string, unknown>;
  const status = typeof e.code === 'number' ? e.code : typeof e.status === 'number' ? e.status : undefined;
  const { message } = extractErrorMessage(JSON.stringify({ error: e }));
  return new ProviderError(
    provider,
    status ? kindForStatus(status) : 'server',
    message || 'Upstream stream error',
    { status },
  );
}

/**
 * Generic OpenAI Chat Completions adapter. Covers OpenAI, DeepSeek, Groq,
 * Together, Fireworks, OpenRouter, DashScope compatible-mode, BytePlus ModelArk,
 * xAI, Mistral and any self-hosted OpenAI-compatible server (vLLM, Ollama, …).
 * verified: false — exercised only against local mock servers so far.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  readonly kind: ProviderKind = 'openai-compatible';
  /** Whether the upstream model goes in the body (`false` for Azure deployment URLs). */
  protected readonly includeModel: boolean = true;

  constructor(protected readonly opts: OpenAICompatibleOptions) {
    this.id = opts.id;
  }

  protected url(_endpoint: Endpoint, op: 'chat/completions' | 'embeddings'): string {
    return `${trimSlash(this.opts.baseUrl)}/${op}`;
  }

  protected authHeaders(): Record<string, string> {
    return this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {};
  }

  private headers(): Record<string, string> {
    return { ...this.opts.headers, ...this.authHeaders() };
  }

  /** Build the upstream body: strip gateway-only fields, set the upstream model, apply quirks. */
  buildChatBody(req: ChatCompletionRequest, endpoint: Endpoint, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = { ...req };
    for (const f of GATEWAY_ONLY_FIELDS) delete body[f];
    if (this.includeModel) body.model = endpoint.upstreamModel;
    else delete body.model;
    if (stream) {
      body.stream = true;
      if (this.opts.supportsStreamUsage !== false) body.stream_options = { include_usage: true };
    } else {
      delete body.stream;
    }
    return applyQuirks(body, endpoint);
  }

  async chat(req: ChatCompletionRequest, endpoint: Endpoint, { signal }: CallOptions): Promise<ChatResponse> {
    const res = await postJson(
      this.id,
      this.url(endpoint, 'chat/completions'),
      this.buildChatBody(req, endpoint, false),
      this.headers(),
      signal,
    );
    const json = await readJson<Record<string, unknown>>(this.id, res, signal);
    if (json.error) throw midStreamError(this.id, json.error);
    if (!Array.isArray(json.choices)) {
      throw new ProviderError(this.id, 'server', `Upstream ${this.id} returned an unexpected response shape`);
    }
    return {
      ...(json as unknown as ChatResponse),
      object: 'chat.completion',
      usage: normalizeUsage(json.usage),
    };
  }

  async *stream(
    req: ChatCompletionRequest,
    endpoint: Endpoint,
    { signal }: CallOptions,
  ): AsyncGenerator<ChatChunk> {
    const res = await postJson(
      this.id,
      this.url(endpoint, 'chat/completions'),
      this.buildChatBody(req, endpoint, true),
      this.headers(),
      signal,
    );
    if (!res.body) throw new ProviderError(this.id, 'server', `Upstream ${this.id} sent an empty stream`);
    for await (const ev of readSse(this.id, res.body, signal)) {
      if (ev.data === '[DONE]') return;
      const obj = parseSseJson<Record<string, unknown>>(this.id, ev.data);
      if (obj.error) throw midStreamError(this.id, obj.error);
      const usage = normalizeUsage(obj.usage ?? (obj.x_groq as { usage?: unknown } | undefined)?.usage);
      yield {
        ...(obj as unknown as ChatChunk),
        object: 'chat.completion.chunk',
        choices: Array.isArray(obj.choices) ? (obj.choices as ChatChunk['choices']) : [],
        usage: usage ?? null,
      };
    }
  }

  async embeddings(
    req: EmbeddingsRequest,
    endpoint: Endpoint,
    { signal }: CallOptions,
  ): Promise<EmbeddingsResponse> {
    const { provider: _p, ...rest } = req;
    const body: Record<string, unknown> = { ...rest };
    if (this.includeModel) body.model = endpoint.upstreamModel;
    else delete body.model;
    const res = await postJson(this.id, this.url(endpoint, 'embeddings'), body, this.headers(), signal);
    const json = await readJson<Record<string, unknown>>(this.id, res, signal);
    if (!Array.isArray(json.data))
      throw new ProviderError(
        this.id,
        'server',
        `Upstream ${this.id} returned an unexpected embeddings shape`,
      );
    const usage = normalizeUsage(json.usage);
    return {
      ...(json as unknown as EmbeddingsResponse),
      object: 'list',
      usage: usage
        ? { prompt_tokens: usage.prompt_tokens, total_tokens: usage.total_tokens ?? usage.prompt_tokens }
        : undefined,
    };
  }
}

export interface AzureOpenAIOptions {
  id: string;
  /** Resource endpoint, e.g. `https://my-resource.openai.azure.com`. */
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  headers?: Record<string, string>;
  supportsStreamUsage?: boolean;
}

/**
 * Azure OpenAI: deployment-scoped URLs, `api-key` header, `api-version` query.
 * The catalog's `upstreamModel` is the deployment name (override per model with
 * AZURE_OPENAI_DEPLOYMENTS). verified: false.
 */
export class AzureOpenAIAdapter extends OpenAICompatibleAdapter {
  override readonly kind: ProviderKind = 'azure-openai';
  protected override readonly includeModel = false;
  private readonly azure: AzureOpenAIOptions;

  constructor(o: AzureOpenAIOptions) {
    super({ id: o.id, baseUrl: o.endpoint, headers: o.headers, supportsStreamUsage: o.supportsStreamUsage });
    this.azure = o;
  }

  protected override url(endpoint: Endpoint, op: 'chat/completions' | 'embeddings'): string {
    const base = trimSlash(this.azure.endpoint);
    return `${base}/openai/deployments/${encodeURIComponent(endpoint.upstreamModel)}/${op}?api-version=${encodeURIComponent(this.azure.apiVersion)}`;
  }

  protected override authHeaders(): Record<string, string> {
    return { 'api-key': this.azure.apiKey };
  }
}
