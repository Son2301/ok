import {
  extractErrorMessage,
  kindForStatus,
  ProviderError,
  parseRetryAfter,
  toProviderError,
} from './errors';

const MAX_ERROR_BODY = 8_192;

/**
 * POST JSON to an upstream. Resolves with the Response for 2xx; throws a
 * classified ProviderError for HTTP errors, connection failures and aborts.
 * Timeouts are enforced by the caller aborting `signal` with a ProviderError reason.
 */
export async function postJson(
  provider: string,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw toProviderError(provider, err, signal);
  }
  if (res.ok) return res;
  let text = '';
  try {
    text = (await res.text()).slice(0, MAX_ERROR_BODY);
  } catch {}
  const { message, code } = extractErrorMessage(text);
  throw new ProviderError(provider, kindForStatus(res.status), message || `HTTP ${res.status}`, {
    status: res.status,
    code,
    retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
  });
}

/** Read a JSON body, converting malformed payloads into a retryable upstream error. */
export async function readJson<T>(provider: string, res: Response, signal: AbortSignal): Promise<T> {
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw toProviderError(provider, err, signal);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(provider, 'server', `Upstream ${provider} returned invalid JSON`, {
      status: res.status,
    });
  }
}

export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Minimal, spec-compliant Server-Sent Events reader: handles CRLF/LF, comment
 * lines, multi-line `data:` fields and a trailing event without a blank line.
 * Read errors (connection reset, abort) surface as ProviderError.
 */
export async function* readSse(
  provider: string,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  let data: string[] = [];

  const flush = (): SseEvent | undefined => {
    if (!data.length) {
      event = undefined;
      return undefined;
    }
    const ev = { event, data: data.join('\n') };
    event = undefined;
    data = [];
    return ev;
  };

  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw toProviderError(provider, err, signal);
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const nl = buf.search(/\r\n|\r|\n/);
        if (nl === -1) break;
        // A trailing CR may be the first half of a CRLF split across network chunks.
        if (buf[nl] === '\r' && nl === buf.length - 1) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + (buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1));
        if (line === '') {
          const ev = flush();
          if (ev) yield ev;
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') data.push(value);
        else if (field === 'event') event = value;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) {
      for (const line of buf.split(/\r\n|\r|\n/)) {
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('event:')) event = line.slice(6).trim();
      }
    }
    const last = flush();
    if (last) yield last;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Parse an SSE data payload as JSON, or throw a retryable upstream error. */
export function parseSseJson<T>(provider: string, data: string): T {
  try {
    return JSON.parse(data) as T;
  } catch {
    throw new ProviderError(provider, 'server', `Upstream ${provider} sent a malformed stream event`);
  }
}
