import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, ContentPart, Usage } from '@minh/llm';
import { z } from 'zod';

/*
 * Request validation. Schemas are deliberately permissive about *extra* fields
 * (OpenAI keeps adding parameters: seed, logprobs, reasoning_effort, …) so they
 * pass through untouched to OpenAI-compatible upstreams, while the fields the
 * gateway itself reads are strictly typed.
 */

const textPart = z.looseObject({ type: z.literal('text'), text: z.string() });
const imagePart = z.looseObject({
  type: z.literal('image_url'),
  image_url: z.union([
    z.string().transform((url) => ({ url })),
    z.looseObject({ url: z.string().min(1), detail: z.enum(['auto', 'low', 'high']).optional() }),
  ]),
});
const otherPart = z.looseObject({ type: z.string() });

const contentPart = z.union([textPart, imagePart, otherPart]);

const toolCall = z.looseObject({
  id: z.string(),
  type: z.literal('function').default('function'),
  function: z.looseObject({ name: z.string(), arguments: z.string().default('') }),
});

const message = z.looseObject({
  role: z.enum(['system', 'user', 'assistant', 'tool', 'developer']),
  content: z.union([z.string(), z.array(contentPart), z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCall).optional(),
  tool_call_id: z.string().optional(),
});

const toolDef = z.looseObject({
  type: z.literal('function'),
  function: z.looseObject({
    name: z.string().min(1).max(128),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const providerPrefsSchema = z.object({
  order: z.array(z.string()).max(32).optional(),
  only: z.array(z.string()).max(32).optional(),
  ignore: z.array(z.string()).max(32).optional(),
  allow_fallbacks: z.boolean().optional(),
  sort: z.enum(['price', 'latency', 'throughput', 'uptime']).optional(),
});

export const chatRequestSchema = z
  .looseObject({
    model: z.string().min(1).max(200).optional(),
    /** Gateway extension: fallback models, tried in order after `model`. */
    models: z.array(z.string().min(1).max(200)).max(10).optional(),
    messages: z.array(message).min(1, 'messages must not be empty'),
    stream: z.boolean().optional(),
    stream_options: z.looseObject({ include_usage: z.boolean().optional() }).nullish(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    n: z.number().int().min(1).max(1, 'n > 1 is not supported by the gateway').optional(),
    stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
    tools: z.array(toolDef).max(128).optional(),
    tool_choice: z
      .union([
        z.enum(['auto', 'none', 'required']),
        z.looseObject({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
      ])
      .optional(),
    response_format: z
      .union([
        z.looseObject({ type: z.enum(['text', 'json_object']) }),
        z.looseObject({
          type: z.literal('json_schema'),
          json_schema: z.looseObject({
            name: z.string(),
            schema: z.record(z.string(), z.unknown()).optional(),
            strict: z.boolean().nullish(),
          }),
        }),
      ])
      .optional(),
    user: z.string().max(256).optional(),
    provider: providerPrefsSchema.optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .refine((r) => r.model || r.models?.length, { message: 'model (or models) is required', path: ['model'] });

export type ProviderPrefs = z.infer<typeof providerPrefsSchema>;

/**
 * The normalized chat request handed to adapters: the validated OpenAI request
 * plus any extra pass-through fields. Typed against @minh/llm's wire types.
 */
export type ChatCompletionRequest = Omit<ChatRequest, 'messages' | 'response_format'> & {
  messages: ChatMessage[];
  response_format?: ChatRequest['response_format'];
  stream_options?: { include_usage?: boolean } | null;
  max_completion_tokens?: number;
  n?: number;
  [extra: string]: unknown;
};

export const embeddingsRequestSchema = z.looseObject({
  model: z.string().min(1).max(200),
  input: z.union([
    z.string(),
    z.array(z.string()).min(1).max(2048),
    z.array(z.number().int()).min(1),
    z.array(z.array(z.number().int()).min(1)).min(1).max(2048),
  ]),
  encoding_format: z.enum(['float', 'base64']).optional(),
  dimensions: z.number().int().positive().max(16_384).optional(),
  user: z.string().max(256).optional(),
  provider: providerPrefsSchema.optional(),
});

export type EmbeddingsRequest = z.infer<typeof embeddingsRequestSchema>;

export interface EmbeddingsResponse {
  object: 'list';
  data: { object: 'embedding'; index: number; embedding: number[] | string }[];
  model: string;
  usage?: { prompt_tokens: number; total_tokens: number };
  [extra: string]: unknown;
}

/** Token usage as reported by an upstream (normalized). */
export interface UpstreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export type GatewayUsage = Usage & {
  /** True when the upstream reported no usage and tokens were estimated (~chars/4). */
  estimated?: boolean;
};

export type { ChatChunk, ChatMessage, ChatResponse, ContentPart };
