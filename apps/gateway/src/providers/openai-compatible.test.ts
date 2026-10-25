import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Endpoint } from '../catalog/types';
import type { ChatChunk, ChatCompletionRequest } from '../schemas';
import { hang, json, MockUpstream, oaiChunks, oaiCompletion, sse } from '../test/helpers';
import { ProviderError, parseRetryAfter } from './errors';
import { readSse } from './http';
import { AzureOpenAIAdapter, OpenAICompatibleAdapter } from './openai-compatible';

const endpoint: Endpoint = {
  id: 'openai/gpt-x@openai',
  modelId: 'openai/gpt-x',
  provider: 'openai',
  upstreamModel: 'gpt-x-2025',
  price: { input: 1, output: 2 },
  cost: { input: 1, output: 2 },
  contextLength: 128_000,
  capabilities: { tools: true, vision: true, json: true, streaming: true },
  enabled: true,
};
const req: ChatCompletionRequest = { model: 'openai/gpt-x', messages: [{ role: 'user', content: 'hi' }] };
const signal = () => new AbortController().signal;

let up: MockUpstream;
let adapter: OpenAICompatibleAdapter;
beforeAll(async () => {
  up = await MockUpstream.start();
  adapter = new OpenAICompatibleAdapter({
    id: 'openai',
    baseUrl: `${up.url}/v1/`,
    apiKey: 'sk-up',
    headers: { 'X-Title': 'OK' },
  });
});
afterAll(() => up.close());

describe('request building', () => {
  it('strips gateway-only fields, sets the upstream model, passes unknown OpenAI params through', () => {
    const body = adapter.buildChatBody(
      {
        ...req,
        models: ['a'],
        provider: { sort: 'price' },
        metadata: { k: 'v' },
        stream_options: { include_usage: false },
        seed: 7,
        logprobs: true,
      },
      endpoint,
      true,
    );
    expect(body).toEqual({
      model: 'gpt-x-2025',
      messages: req.messages,
      seed: 7,
      logprobs: true,
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('applies endpoint quirks', () => {
    const body = adapter.buildChatBody(
      {
        ...req,
        temperature: 0.1,
        top_p: 0.5,
        tool_choice: 'required',
        tools: [{ type: 'function', function: { name: 'f' } }],
      },
      { ...endpoint, quirks: { dropParams: ['temperature'], noForcedToolChoice: true } },
      false,
    );
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBe(0.5);
    expect(body.tool_choice).toBe('auto');
    expect(body.stream).toBeUndefined();
  });
});

describe('OpenAICompatibleAdapter', () => {
  it('POSTs chat completions with auth + extra headers and normalizes usage', async () => {
    up.reset((_r, res) => json(res, 200, oaiCompletion('hello', { prompt_tokens: 3, completion_tokens: 2 })));
    const res = await adapter.chat(req, endpoint, { signal: signal() });
    expect(res.choices[0]!.message.content).toBe('hello');
    expect(res.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    expect(up.calls[0]!.url).toBe('/v1/chat/completions');
    expect(up.calls[0]!.headers.authorization).toBe('Bearer sk-up');
    expect(up.calls[0]!.headers['x-title']).toBe('OK');
  });

  it('streams chunks including the usage chunk (and Groq-style x_groq usage)', async () => {
    up.reset((_r, res) => sse(res, oaiChunks(['Hel', 'lo'], { prompt_tokens: 4, completion_tokens: 2 })));
    const chunks: ChatChunk[] = [];
    for await (const c of adapter.stream(req, endpoint, { signal: signal() })) chunks.push(c);
    expect(chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')).toBe('Hello');
    expect(chunks.at(-1)!.usage).toEqual({ prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });

    up.reset((_r, res) =>
      sse(res, [
        {
          id: 'g',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'm',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          x_groq: { usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } },
        },
      ]),
    );
    const groq: ChatChunk[] = [];
    for await (const c of adapter.stream(req, endpoint, { signal: signal() })) groq.push(c);
    expect(groq[0]!.usage).toEqual({ prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 });
  });

  it('turns an in-stream error event into a ProviderError', async () => {
    up.reset((_r, res) =>
      sse(res, [
        ...oaiChunks(['a'], null).slice(0, 2),
        { error: { code: 502, message: 'upstream overloaded' } },
      ]),
    );
    const it = adapter.stream(req, endpoint, { signal: signal() })[Symbol.asyncIterator]();
    await it.next();
    await it.next();
    await expect(it.next()).rejects.toMatchObject({
      kind: 'server',
      status: 502,
      message: 'upstream overloaded',
    });
  });

  it.each([
    [400, 'bad_request', false],
    [401, 'auth', true],
    [403, 'auth', true],
    [404, 'not_found', true],
    [408, 'timeout', true],
    [413, 'bad_request', false],
    [422, 'bad_request', false],
    [429, 'rate_limit', true],
    [500, 'server', true],
    [503, 'server', true],
  ] as const)('classifies HTTP %i as %s (retryable=%s)', async (status, kind, retryable) => {
    up.reset((_r, res) =>
      json(
        res,
        status,
        { error: { message: `err ${status}`, type: 'x' } },
        status === 429 ? { 'retry-after': '2' } : {},
      ),
    );
    const err = (await adapter.chat(req, endpoint, { signal: signal() }).catch((e) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind, status, retryable, message: `err ${status}` });
    if (status === 429) expect(err.retryAfterMs).toBe(2000);
  });

  it('classifies connection failures as retryable network errors', async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const dead = new OpenAICompatibleAdapter({ id: 'dead', baseUrl: `http://127.0.0.1:${port}/v1` });
    await expect(dead.chat(req, endpoint, { signal: signal() })).rejects.toMatchObject({
      kind: 'network',
      retryable: true,
    });
  });

  it('treats invalid JSON from a 200 as a retryable upstream fault', async () => {
    up.reset((_r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>gateway timeout</html>');
    });
    await expect(adapter.chat(req, endpoint, { signal: signal() })).rejects.toMatchObject({
      kind: 'server',
      retryable: true,
    });
  });

  it('surfaces an abort reason (gateway timeout) as the thrown error', async () => {
    up.reset(() => hang());
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(new ProviderError('openai', 'timeout', 'gave up')), 50);
    await expect(adapter.chat(req, endpoint, { signal: ctrl.signal })).rejects.toMatchObject({
      kind: 'timeout',
      message: 'gave up',
    });
  });

  it('proxies embeddings', async () => {
    up.reset((_r, res) =>
      json(res, 200, {
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
        model: 'emb',
        usage: { prompt_tokens: 3, total_tokens: 3 },
      }),
    );
    const res = await adapter.embeddings(
      { model: 'openai/emb', input: 'hello', provider: { sort: 'price' } },
      { ...endpoint, upstreamModel: 'text-embedding-3-small' },
      { signal: signal() },
    );
    expect(res.data[0]!.embedding).toEqual([0.1, 0.2]);
    expect(res.usage).toEqual({ prompt_tokens: 3, total_tokens: 3 });
    expect(up.calls[0]!.url).toBe('/v1/embeddings');
    expect(up.calls[0]!.body).toEqual({ model: 'text-embedding-3-small', input: 'hello' });
  });
});

describe('AzureOpenAIAdapter', () => {
  it('uses deployment URLs, api-version and the api-key header, without a model field', async () => {
    const azure = new AzureOpenAIAdapter({
      id: 'azure',
      endpoint: `${up.url}/`,
      apiKey: 'az-key',
      apiVersion: '2024-10-21',
    });
    up.reset((_r, res) => json(res, 200, oaiCompletion('from azure')));
    const res = await azure.chat(
      req,
      { ...endpoint, provider: 'azure', upstreamModel: 'my-gpt-deploy' },
      { signal: signal() },
    );
    expect(res.choices[0]!.message.content).toBe('from azure');
    expect(up.calls[0]!.url).toBe(
      '/openai/deployments/my-gpt-deploy/chat/completions?api-version=2024-10-21',
    );
    expect(up.calls[0]!.headers['api-key']).toBe('az-key');
    expect(up.calls[0]!.headers.authorization).toBeUndefined();
    expect(up.calls[0]!.body.model).toBeUndefined();
  });
});

describe('readSse', () => {
  function streamOf(parts: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    });
  }

  it('handles CRLF split across chunks, comments, multi-line data and a trailing event without blank line', async () => {
    const events = [];
    const body = streamOf([
      ': keep-alive\r\n\r\nevent: a\r',
      '\ndata: line1\r\ndata: line2\r\n\r',
      '\ndata: {"x":1}\n\ndata: tail',
    ]);
    for await (const ev of readSse('p', body, signal())) events.push(ev);
    expect(events).toEqual([
      { event: 'a', data: 'line1\nline2' },
      { event: undefined, data: '{"x":1}' },
      { event: undefined, data: 'tail' },
    ]);
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
