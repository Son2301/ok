import { AppError, fetchWithTimeout } from '@minh/shared';
import type { ChatChunk, ChatRequest, ChatResponse } from './types';

export interface LlmClient {
  chat(req: ChatRequest, opts?: { signal?: AbortSignal }): Promise<ChatResponse>;
  stream(req: ChatRequest, opts?: { signal?: AbortSignal }): AsyncIterable<ChatChunk>;
}

export interface HttpLlmOptions {
  /** e.g. `http://localhost:4000/v1` for the platform gateway, or any OpenAI-compatible base URL. */
  baseUrl: string;
  apiKey: string;
  /** Extra headers, e.g. `{ 'x-org-id': … }` for internal calls. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Injectable fetch, e.g. for tests. */
  fetch?: typeof fetch;
}

/** OpenAI-compatible HTTP client. Products use it to call the platform gateway. */
export function createLlmClient(opts: HttpLlmOptions): LlmClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${opts.apiKey}`,
    ...opts.headers,
  };

  async function post(body: ChatRequest, signal?: AbortSignal) {
    const res = await fetchWithTimeout(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs ?? 120_000,
      signal,
      fetchImpl: opts.fetch,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text.slice(0, 500);
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
      } catch {}
      throw new AppError(
        res.status === 402 ? 'payment_required' : res.status === 429 ? 'rate_limited' : 'upstream_error',
        `LLM call failed (${res.status}): ${message}`,
      );
    }
    return res;
  }

  return {
    async chat(req, o) {
      const res = await post({ ...req, stream: false }, o?.signal);
      return (await res.json()) as ChatResponse;
    },
    async *stream(req, o) {
      const res = await post({ ...req, stream: true }, o?.signal);
      if (!res.body) return;
      yield* parseSse(res.body);
    },
  };
}

/** Parse an OpenAI-style SSE stream into chunks. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<ChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (let idx = buf.indexOf('\n\n'); idx !== -1; idx = buf.indexOf('\n\n')) {
      const event = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        const chunk = JSON.parse(data) as ChatChunk;
        if (chunk.error) {
          throw new AppError('upstream_error', `Stream failed: ${chunk.error.message}`);
        }
        yield chunk;
      }
    }
  }
}

/** Concatenate the text content of a response. */
export function responseText(res: ChatResponse): string {
  const c = res.choices[0]?.message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return '';
}
