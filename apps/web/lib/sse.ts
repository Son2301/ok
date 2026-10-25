/**
 * Incremental Server-Sent Events parser (client-safe). Feed it decoded text as
 * it arrives; it calls `onEvent` once per complete event. Handles `event:`,
 * multi-line `data:`, comments, and CRLF line endings.
 */
export interface SseEvent {
  event: string;
  data: string;
}

export function createSseParser(onEvent: (e: SseEvent) => void) {
  let buffer = '';
  let event = 'message';
  let data: string[] = [];

  const dispatch = () => {
    if (data.length) onEvent({ event, data: data.join('\n') });
    event = 'message';
    data = [];
  };

  const line = (raw: string) => {
    if (raw === '') return dispatch();
    if (raw.startsWith(':')) return;
    const i = raw.indexOf(':');
    const field = i === -1 ? raw : raw.slice(0, i);
    let value = i === -1 ? '' : raw.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value || 'message';
    else if (field === 'data') data.push(value);
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let nl = buffer.search(/\r?\n/);
      while (nl !== -1) {
        const isCrlf = buffer[nl] === '\r';
        line(buffer.slice(0, nl));
        buffer = buffer.slice(nl + (isCrlf ? 2 : 1));
        nl = buffer.search(/\r?\n/);
      }
    },
    end() {
      if (buffer) line(buffer);
      buffer = '';
      dispatch();
    },
  };
}

/** Read a fetch Response body as SSE events. */
export async function readSse(
  res: Response,
  onEvent: (e: SseEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(onEvent);
  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } finally {
    reader.releaseLock();
  }
}
