import type { Endpoint } from '../catalog/types';
import type {
  ChatChunk,
  ChatCompletionRequest,
  ChatResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
} from '../schemas';
import type { ProviderKind } from './config';

export interface CallOptions {
  /** Aborted on client disconnect or gateway timeout (reason: ProviderError). */
  signal: AbortSignal;
}

/**
 * One upstream provider. Adapters translate the OpenAI-shaped request into the
 * provider's wire format and back, normalize usage, and throw `ProviderError`
 * (classified retryable / non-retryable) for every failure.
 */
export interface ProviderAdapter {
  readonly id: string;
  readonly kind: ProviderKind;
  chat(req: ChatCompletionRequest, endpoint: Endpoint, opts: CallOptions): Promise<ChatResponse>;
  /**
   * Stream OpenAI-shaped chunks. The HTTP request is issued on the first `next()`,
   * so connection/HTTP errors surface there (before anything reaches the client).
   * Usage, when the upstream reports it, arrives on a chunk's `usage` field.
   */
  stream(req: ChatCompletionRequest, endpoint: Endpoint, opts: CallOptions): AsyncIterable<ChatChunk>;
  embeddings?(req: EmbeddingsRequest, endpoint: Endpoint, opts: CallOptions): Promise<EmbeddingsResponse>;
}

/** Gateway-only request fields that must never be forwarded upstream. */
export const GATEWAY_ONLY_FIELDS = [
  'models',
  'provider',
  'route',
  'transforms',
  'metadata',
  'stream_options',
  'usage',
] as const;

/** Apply per-endpoint quirks to an outgoing OpenAI-shaped body (mutates `body`). */
export function applyQuirks(body: Record<string, unknown>, endpoint: Endpoint): Record<string, unknown> {
  for (const p of endpoint.quirks?.dropParams ?? []) delete body[p];
  if (
    endpoint.quirks?.noForcedToolChoice &&
    body.tool_choice &&
    body.tool_choice !== 'auto' &&
    body.tool_choice !== 'none'
  ) {
    body.tool_choice = 'auto';
  }
  return body;
}
