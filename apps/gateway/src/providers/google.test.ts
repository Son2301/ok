import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Endpoint } from '../catalog/types';
import type { ChatChunk, ChatCompletionRequest } from '../schemas';
import { json, MockUpstream, sse } from '../test/helpers';
import {
  fromGeminiResponse,
  GeminiStreamTranslator,
  GoogleAdapter,
  sanitizeSchema,
  toGeminiRequest,
} from './google';

const endpoint: Endpoint = {
  id: 'google/gemini-x@google',
  modelId: 'google/gemini-x',
  provider: 'google',
  upstreamModel: 'gemini-x',
  price: { input: 1, output: 2 },
  cost: { input: 1, output: 2 },
  contextLength: 1_000_000,
  capabilities: { tools: true, vision: true, json: true, streaming: true },
  enabled: true,
};

const weatherTool: NonNullable<ChatCompletionRequest['tools']>[number] = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Weather by city',
    parameters: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
};

describe('toGeminiRequest', () => {
  it('translates roles, system instruction, images, function calls/responses and generation config', () => {
    const req: ChatCompletionRequest = {
      model: 'x',
      temperature: 0.3,
      top_p: 0.8,
      max_tokens: 500,
      stop: ['###'],
      tools: [weatherTool],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      messages: [
        { role: 'system', content: 'Be brief.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Where is this?' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } },
            { type: 'image_url', image_url: { url: 'https://example.com/photo.webp' } },
          ],
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Hoi An"}' },
              extra_content: { google: { thought_signature: 'sig-abc' } },
            } as never,
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp_c":29}' },
        { role: 'user', content: 'Thanks' },
      ],
    };
    expect(toGeminiRequest(req, endpoint)).toEqual({
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Where is this?' },
            { inlineData: { mimeType: 'image/jpeg', data: '/9j/4AAQ' } },
            { fileData: { mimeType: 'image/webp', fileUri: 'https://example.com/photo.webp' } },
          ],
        },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'get_weather', args: { city: 'Hoi An' } }, thoughtSignature: 'sig-abc' },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'get_weather', response: { temp_c: 29 } } },
            { text: 'Thanks' },
          ],
        },
      ],
      generationConfig: { temperature: 0.3, topP: 0.8, maxOutputTokens: 500, stopSequences: ['###'] },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Weather by city',
              parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
            },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } },
    });
  });

  it('maps JSON response formats and wraps non-object tool results', () => {
    const body = toGeminiRequest(
      {
        model: 'x',
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'a',
            schema: { type: 'object', additionalProperties: false, properties: { n: { type: 'number' } } },
          },
        },
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
          { role: 'tool', tool_call_id: 'c', content: 'plain text' },
        ],
      },
      endpoint,
    ) as { generationConfig: Record<string, unknown>; contents: { parts: unknown[] }[] };
    expect(body.generationConfig).toEqual({
      responseMimeType: 'application/json',
      responseSchema: { type: 'object', properties: { n: { type: 'number' } } },
    });
    expect(body.contents[1]!.parts[0]).toEqual({
      functionResponse: { name: 'f', response: { result: 'plain text' } },
    });
    expect(
      toGeminiRequest(
        { model: 'x', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'x' }] },
        endpoint,
      ).generationConfig,
    ).toEqual({ responseMimeType: 'application/json' });
  });

  it('sanitizes JSON Schema keywords Gemini rejects, recursively', () => {
    expect(
      sanitizeSchema({
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'object', additionalProperties: true, $comment: 'x', properties: {} } },
      }),
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'object', properties: {} } },
    });
  });
});

describe('fromGeminiResponse', () => {
  it('translates text (skipping thoughts), function calls with thought signatures, and usage incl. thinking tokens', () => {
    const res = fromGeminiResponse(
      {
        responseId: 'resp-1',
        modelVersion: 'gemini-x-001',
        candidates: [
          {
            content: {
              parts: [
                { text: 'internal musing', thought: true },
                { text: 'Let me look that up.' },
                { functionCall: { name: 'get_weather', args: { city: 'Hue' } }, thoughtSignature: 'sig-1' },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 40,
          candidatesTokenCount: 10,
          thoughtsTokenCount: 30,
          totalTokenCount: 80,
        },
      },
      'gemini-x',
    );
    expect(res.id).toBe('resp-1');
    expect(res.model).toBe('gemini-x-001');
    const choice = res.choices[0]!;
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.content).toBe('Let me look that up.');
    expect(choice.message.tool_calls).toEqual([
      {
        id: expect.stringMatching(/^call_/),
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Hue"}' },
        extra_content: { google: { thought_signature: 'sig-1' } },
      },
    ]);
    expect(res.usage).toEqual({ prompt_tokens: 40, completion_tokens: 40, total_tokens: 80 });
  });

  it('maps finish reasons and prompt blocks', () => {
    const f = (finishReason?: string, blockReason?: string) =>
      fromGeminiResponse(
        {
          candidates: finishReason ? [{ content: { parts: [{ text: 'x' }] }, finishReason }] : [],
          promptFeedback: blockReason ? { blockReason } : undefined,
        },
        'g',
      ).choices[0]!.finish_reason;
    expect(f('STOP')).toBe('stop');
    expect(f('MAX_TOKENS')).toBe('length');
    expect(f('SAFETY')).toBe('content_filter');
    expect(f('RECITATION')).toBe('content_filter');
    expect(f(undefined, 'SAFETY')).toBe('content_filter');
  });
});

const STREAM_FIXTURE = [
  { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking…', thought: true }] } }] },
  {
    candidates: [{ content: { role: 'model', parts: [{ text: 'Xin ' }] } }],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1, totalTokenCount: 13 },
  },
  { candidates: [{ content: { role: 'model', parts: [{ text: 'chào!' }] } }] },
  {
    candidates: [
      {
        content: { role: 'model', parts: [{ functionCall: { name: 'lookup', args: { q: 'pho' } } }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 9, totalTokenCount: 21 },
  },
];

function collect(chunks: ChatChunk[]) {
  let content = '';
  const tools: unknown[] = [];
  let finish: string | null = null;
  let usage: ChatChunk['usage'] = null;
  for (const c of chunks) {
    if (c.usage) usage = c.usage;
    for (const ch of c.choices) {
      content += ch.delta.content ?? '';
      tools.push(...(ch.delta.tool_calls ?? []));
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  }
  return { content, tools, finish, usage };
}

describe('GeminiStreamTranslator', () => {
  it('turns streamed GenerateContentResponses into chunks with a final usage chunk', () => {
    const tr = new GeminiStreamTranslator('gemini-x');
    const chunks = [...STREAM_FIXTURE.flatMap((j) => tr.push(j)), ...tr.finish()];
    expect(chunks[0]!.choices[0]!.delta).toEqual({ role: 'assistant', content: '' });
    const out = collect(chunks);
    expect(out.content).toBe('Xin chào!');
    expect(out.tools).toEqual([
      {
        index: 0,
        id: expect.stringMatching(/^call_/),
        type: 'function',
        function: { name: 'lookup', arguments: '{"q":"pho"}' },
      },
    ]);
    expect(out.finish).toBe('tool_calls');
    expect(out.usage).toEqual({ prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 });
  });

  it('throws on an in-stream error payload', () => {
    const tr = new GeminiStreamTranslator('gemini-x');
    expect(() =>
      tr.push({ error: { code: 503, message: 'The model is overloaded', status: 'UNAVAILABLE' } }),
    ).toThrowError(/overloaded/);
  });
});

describe('GoogleAdapter over HTTP', () => {
  let up: MockUpstream;
  let adapter: GoogleAdapter;
  beforeAll(async () => {
    up = await MockUpstream.start();
    adapter = new GoogleAdapter({ baseUrl: `${up.url}/v1beta`, apiKey: 'gem-key' });
  });
  afterAll(() => up.close());
  const req: ChatCompletionRequest = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
  const signal = () => new AbortController().signal;

  it('calls generateContent with the API key header', async () => {
    up.reset((_r, res) =>
      json(res, 200, {
        candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
      }),
    );
    const res = await adapter.chat(req, endpoint, { signal: signal() });
    expect(res.choices[0]!.message.content).toBe('hello');
    expect(up.calls[0]!.url).toBe('/v1beta/models/gemini-x:generateContent');
    expect(up.calls[0]!.headers['x-goog-api-key']).toBe('gem-key');
  });

  it('streams via streamGenerateContent?alt=sse', async () => {
    up.reset((_r, res) => sse(res, STREAM_FIXTURE, { done: false }));
    const chunks: ChatChunk[] = [];
    for await (const c of adapter.stream({ ...req, stream: true }, endpoint, { signal: signal() }))
      chunks.push(c);
    expect(up.calls[0]!.url).toBe('/v1beta/models/gemini-x:streamGenerateContent?alt=sse');
    expect(collect(chunks)).toMatchObject({
      content: 'Xin chào!',
      finish: 'tool_calls',
      usage: { prompt_tokens: 12, completion_tokens: 9 },
    });
  });

  it('classifies RESOURCE_EXHAUSTED as a retryable rate limit', async () => {
    up.reset((_r, res) =>
      json(
        res,
        429,
        { error: { code: 429, message: 'Quota exceeded', status: 'RESOURCE_EXHAUSTED' } },
        { 'retry-after': '7' },
      ),
    );
    await expect(adapter.chat(req, endpoint, { signal: signal() })).rejects.toMatchObject({
      kind: 'rate_limit',
      retryable: true,
      retryAfterMs: 7000,
      message: 'Quota exceeded',
    });
  });
});
