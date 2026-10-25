import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Endpoint } from '../catalog/types';
import type { ChatChunk, ChatCompletionRequest } from '../schemas';
import { json, MockUpstream, sse } from '../test/helpers';
import {
  AnthropicAdapter,
  AnthropicStreamTranslator,
  fromAnthropicResponse,
  toAnthropicRequest,
} from './anthropic';
import { ProviderError } from './errors';

const endpoint: Endpoint = {
  id: 'anthropic/claude-x@anthropic',
  modelId: 'anthropic/claude-x',
  provider: 'anthropic',
  upstreamModel: 'claude-x',
  price: { input: 3, output: 15 },
  cost: { input: 3, output: 15 },
  contextLength: 200_000,
  maxOutputTokens: 8_192,
  capabilities: { tools: true, vision: true, json: true, streaming: true },
  enabled: true,
};
const opts = { defaultMaxTokens: 16_000, version: '2023-06-01', stream: false };

const tools: ChatCompletionRequest['tools'] = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Weather by city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
];

describe('toAnthropicRequest', () => {
  it('translates system prompts, images, tool calls and tool results', () => {
    const req: ChatCompletionRequest = {
      model: 'x',
      temperature: 1.5,
      top_p: 0.9,
      stop: 'END',
      user: 'user-123',
      tools,
      tool_choice: 'required',
      parallel_tool_calls: false,
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'developer', content: 'Answer in English.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Compare these:' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            { type: 'image_url', image_url: { url: 'https://example.com/b.jpg' } },
          ],
        },
        {
          role: 'assistant',
          content: 'Let me check the weather.',
          tool_calls: [
            {
              id: 'toolu_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Hanoi"}' },
            },
            {
              id: 'toolu_2',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'toolu_1', content: '31°C' },
        { role: 'tool', tool_call_id: 'toolu_2', content: '18°C' },
        { role: 'user', content: 'Which is warmer?' },
      ],
    };
    expect(toAnthropicRequest(req, endpoint, opts)).toEqual({
      model: 'claude-x',
      max_tokens: 8_192, // default capped at the endpoint's max output
      system: 'You are terse.\n\nAnswer in English.',
      temperature: 1, // OpenAI 0–2 → Anthropic 0–1
      top_p: 0.9,
      stop_sequences: ['END'],
      metadata: { user_id: 'user-123' },
      tools: [
        { name: 'get_weather', description: 'Weather by city', input_schema: tools![0]!.function.parameters },
      ],
      tool_choice: { type: 'any', disable_parallel_tool_use: true },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Compare these:' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
            { type: 'image', source: { type: 'url', url: 'https://example.com/b.jpg' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check the weather.' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Hanoi' } },
            { type: 'tool_use', id: 'toolu_2', name: 'get_weather', input: { city: 'Paris' } },
          ],
        },
        {
          // consecutive tool results + the next user turn merge into one user message
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: '31°C' },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: '18°C' },
            { type: 'text', text: 'Which is warmer?' },
          ],
        },
      ],
    });
  });

  it('maps tool_choice variants and JSON response formats', () => {
    const base: ChatCompletionRequest = {
      model: 'x',
      max_tokens: 100,
      tools,
      messages: [{ role: 'user', content: 'hi' }],
    };
    expect(toAnthropicRequest({ ...base, tool_choice: 'auto' }, endpoint, opts).tool_choice).toEqual({
      type: 'auto',
    });
    expect(toAnthropicRequest({ ...base, tool_choice: 'none' }, endpoint, opts).tool_choice).toEqual({
      type: 'none',
    });
    expect(
      toAnthropicRequest(
        { ...base, tool_choice: { type: 'function', function: { name: 'get_weather' } } },
        endpoint,
        opts,
      ).tool_choice,
    ).toEqual({ type: 'tool', name: 'get_weather' });
    const json = toAnthropicRequest(
      { ...base, tools: undefined, response_format: { type: 'json_object' } },
      endpoint,
      opts,
    );
    expect(json.system).toMatch(/single valid JSON object/);
    expect(json.max_tokens).toBe(100);
    const schema = toAnthropicRequest(
      {
        ...base,
        tools: undefined,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'answer',
            schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          },
        },
      },
      endpoint,
      opts,
    );
    expect(schema.system).toContain('"ok"');
  });

  it('applies endpoint quirks and API-version rules for sampling params and forced tools', () => {
    const req: ChatCompletionRequest = {
      model: 'x',
      temperature: 0.2,
      top_p: 0.5,
      tools,
      tool_choice: 'required',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const quirky = toAnthropicRequest(
      req,
      { ...endpoint, quirks: { dropParams: ['temperature', 'top_p'], noForcedToolChoice: true } },
      opts,
    );
    expect(quirky.temperature).toBeUndefined();
    expect(quirky.top_p).toBeUndefined();
    expect(quirky.tool_choice).toEqual({ type: 'auto' });
    const newApi = toAnthropicRequest(req, endpoint, { ...opts, version: '2026-10-21' });
    expect(newApi.temperature).toBeUndefined();
    expect(newApi.top_p).toBeUndefined();
  });
});

describe('fromAnthropicResponse', () => {
  it('translates text, tool_use blocks, stop reasons and usage (cache tokens count as prompt)', () => {
    const res = fromAnthropicResponse({
      id: 'msg_01',
      model: 'claude-x',
      content: [
        { type: 'thinking', text: undefined },
        { type: 'text', text: 'Checking. ' },
        { type: 'tool_use', id: 'toolu_9', name: 'get_weather', input: { city: 'Hue' } },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5,
        output_tokens: 42,
      },
    });
    expect(res.choices[0]).toEqual({
      index: 0,
      message: {
        role: 'assistant',
        content: 'Checking. ',
        tool_calls: [
          { id: 'toolu_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Hue"}' } },
        ],
      },
      finish_reason: 'tool_calls',
    });
    expect(res.usage).toEqual({ prompt_tokens: 125, completion_tokens: 42, total_tokens: 167 });
  });

  it('maps max_tokens and refusal stop reasons', () => {
    const r = (stop_reason: string) =>
      fromAnthropicResponse({ id: 'm', model: 'c', content: [{ type: 'text', text: 'x' }], stop_reason })
        .choices[0]!.finish_reason;
    expect(r('end_turn')).toBe('stop');
    expect(r('stop_sequence')).toBe('stop');
    expect(r('max_tokens')).toBe('length');
    expect(r('refusal')).toBe('content_filter');
  });
});

/** Recorded-shape stream fixture (text, then a tool_use block with partial JSON). */
const STREAM_FIXTURE: [string, unknown][] = [
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_s1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-x',
        stop_reason: null,
        usage: { input_tokens: 25, cache_read_input_tokens: 5, output_tokens: 1 },
      },
    },
  ],
  [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  ],
  ['ping', { type: 'ping' }],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'content_block_start',
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_s', name: 'get_weather', input: {} },
    },
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city": ' } },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '"Da Nang"}' },
    },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 31 },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
];

function accumulate(chunks: ChatChunk[]) {
  let content = '';
  const tools: { id?: string; name?: string; args: string }[] = [];
  let finish: string | null = null;
  let usage: ChatChunk['usage'] = null;
  for (const c of chunks) {
    if (c.usage) usage = c.usage;
    for (const ch of c.choices) {
      content += ch.delta.content ?? '';
      for (const tc of (ch.delta.tool_calls ?? []) as unknown as {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[]) {
        tools[tc.index] ??= { args: '' };
        if (tc.id) tools[tc.index]!.id = tc.id;
        if (tc.function?.name) tools[tc.index]!.name = tc.function.name;
        tools[tc.index]!.args += tc.function?.arguments ?? '';
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  return { content, tools, finish, usage };
}

describe('AnthropicStreamTranslator', () => {
  it('translates a full event stream into OpenAI chunks', () => {
    const tr = new AnthropicStreamTranslator();
    const chunks = STREAM_FIXTURE.flatMap(([ev, data]) => tr.push(ev, data));
    expect(chunks[0]!.choices[0]!.delta).toEqual({ role: 'assistant', content: '' });
    expect(chunks.every((c) => c.id === 'msg_s1' && c.model === 'claude-x')).toBe(true);
    expect(accumulate(chunks)).toEqual({
      content: 'Hello there',
      tools: [{ id: 'toolu_s', name: 'get_weather', args: '{"city": "Da Nang"}' }],
      finish: 'tool_calls',
      usage: { prompt_tokens: 30, completion_tokens: 31, total_tokens: 61 },
    });
    expect(chunks[chunks.length - 1]!.choices).toEqual([]); // usage-only final chunk
  });

  it('raises a classified error for in-stream error events', () => {
    const tr = new AnthropicStreamTranslator();
    expect(() =>
      tr.push('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    ).toThrow(ProviderError);
    try {
      tr.push('error', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
    } catch (e) {
      expect((e as ProviderError).kind).toBe('server');
      expect((e as ProviderError).retryable).toBe(true);
    }
  });
});

describe('AnthropicAdapter over HTTP', () => {
  let up: MockUpstream;
  let adapter: AnthropicAdapter;
  beforeAll(async () => {
    up = await MockUpstream.start();
    adapter = new AnthropicAdapter({ baseUrl: up.url, apiKey: 'sk-ant-test', version: '2023-06-01' });
  });
  afterAll(() => up.close());
  const req: ChatCompletionRequest = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
  const signal = () => new AbortController().signal;

  it('sends the right URL and headers and parses a response', async () => {
    up.reset((_r, res) =>
      json(res, 200, {
        id: 'msg_h',
        model: 'claude-x',
        content: [{ type: 'text', text: 'hey' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 1 },
      }),
    );
    const res = await adapter.chat(req, endpoint, { signal: signal() });
    expect(res.choices[0]!.message.content).toBe('hey');
    expect(up.calls[0]!.url).toBe('/v1/messages');
    expect(up.calls[0]!.headers['x-api-key']).toBe('sk-ant-test');
    expect(up.calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect(up.calls[0]!.body).toMatchObject({ model: 'claude-x', max_tokens: 8_192 });
  });

  it('streams named SSE events', async () => {
    up.reset((_r, res) => sse(res, STREAM_FIXTURE, { done: false }));
    const chunks: ChatChunk[] = [];
    for await (const c of adapter.stream({ ...req, stream: true }, endpoint, { signal: signal() }))
      chunks.push(c);
    expect(up.calls[0]!.body.stream).toBe(true);
    expect(accumulate(chunks).content).toBe('Hello there');
  });

  it('classifies HTTP errors (529 overloaded → retryable, 400 → not)', async () => {
    up.reset((_r, res) =>
      json(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    );
    await expect(adapter.chat(req, endpoint, { signal: signal() })).rejects.toMatchObject({
      kind: 'server',
      status: 529,
      retryable: true,
    });
    up.reset((_r, res) =>
      json(res, 400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'max_tokens: too large' },
      }),
    );
    await expect(adapter.chat(req, endpoint, { signal: signal() })).rejects.toMatchObject({
      kind: 'bad_request',
      message: 'max_tokens: too large',
      retryable: false,
    });
  });
});
