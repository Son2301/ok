import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { chatJson, extractJson, MockLlm } from './index';

describe('extractJson', () => {
  it('handles fences, prose and nested braces in strings', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here it is: {"a":"x}y","b":[1,{"c":2}]} hope that helps')).toEqual({
      a: 'x}y',
      b: [1, { c: 2 }],
    });
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('chatJson', () => {
  it('retries once with validation feedback', async () => {
    const llm = new MockLlm(['{"score": "high"}', '{"score": 7}']);
    const { data } = await chatJson(
      llm,
      { model: 'm', messages: [{ role: 'user', content: 'rate' }] },
      z.object({ score: z.number() }),
    );
    expect(data.score).toBe(7);
    expect(llm.calls).toHaveLength(2);
    expect(JSON.stringify(llm.calls[1]?.messages)).toContain('not valid JSON');
  });

  it('gives up after retries', async () => {
    const llm = new MockLlm(['nope', 'still nope']);
    await expect(
      chatJson(llm, { model: 'm', messages: [] }, z.object({ a: z.number() })),
    ).rejects.toMatchObject({ code: 'upstream_error' });
  });
});

describe('MockLlm streaming', () => {
  it('streams words and ends with usage', async () => {
    const llm = new MockLlm(() => 'hello there world');
    let text = '';
    let finished = false;
    for await (const chunk of llm.stream({ model: 'm', messages: [] })) {
      text += chunk.choices[0]?.delta.content ?? '';
      if (chunk.choices[0]?.finish_reason === 'stop') finished = Boolean(chunk.usage);
    }
    expect(text).toBe('hello there world');
    expect(finished).toBe(true);
  });
});

describe('parseSse', () => {
  it('throws when the gateway reports a mid-stream failure', async () => {
    const { parseSse } = await import('./client');
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          enc.encode(
            'data: {"id":"g","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
          ),
        );
        c.enqueue(
          enc.encode(
            'data: {"id":"g","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"error"}],"error":{"message":"boom"}}\n\n',
          ),
        );
        c.close();
      },
    });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const ch of parseSse(body)) seen.push(String(ch.choices[0]?.delta.content ?? ''));
      })(),
    ).rejects.toThrow(/boom/);
    expect(seen).toEqual(['hi']);
  });
});

describe('MockLlm tool-call streaming', () => {
  it('streams tool calls as indexed deltas that reassemble to the original', async () => {
    const llm = new MockLlm([
      { tool_calls: [{ id: 't1', function: { name: 'lookup', arguments: '{"sku":"A-1"}' } }] },
    ]);
    const calls: Record<number, { name: string; args: string }> = {};
    let finish: string | null = null;
    for await (const ch of llm.stream({ model: 'm', messages: [] })) {
      for (const d of ch.choices[0]?.delta.tool_calls ?? []) {
        const cur = (calls[d.index] ??= { name: '', args: '' });
        cur.name += d.function?.name ?? '';
        cur.args += d.function?.arguments ?? '';
      }
      finish = ch.choices[0]?.finish_reason ?? finish;
    }
    expect(calls[0]).toEqual({ name: 'lookup', args: '{"sku":"A-1"}' });
    expect(finish).toBe('tool_calls');
  });
});

describe('createLlmClient', () => {
  it('uses an injected fetch', async () => {
    const { createLlmClient } = await import('./client');
    const seen: string[] = [];
    const client = createLlmClient({
      baseUrl: 'http://gw/v1/',
      apiKey: 'k',
      fetch: (async (url: string | URL | Request) => {
        seen.push(String(url));
        return new Response(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            created: 1,
            model: 'm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }) as typeof fetch,
    });
    const res = await client.chat({ model: 'm', messages: [] });
    expect(res.choices[0]?.message.content).toBe('ok');
    expect(seen).toEqual(['http://gw/v1/chat/completions']);
  });
});
