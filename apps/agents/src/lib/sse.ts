export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Parse a `text/event-stream` body into events (generic: named events, multi-line data). */
export async function* parseSseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const parse = (block: string): SseEvent | null => {
    let event = 'message';
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
    }
    return data.length ? { event, data: data.join('\n'), ...(id ? { id } : {}) } : null;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
      for (let idx = buf.indexOf('\n\n'); idx !== -1; idx = buf.indexOf('\n\n')) {
        const ev = parse(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        if (ev) yield ev;
      }
    }
    const tail = parse(buf);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
