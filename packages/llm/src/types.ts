/** OpenAI Chat Completions wire types (the subset the platform uses). */

export type Role = 'system' | 'user' | 'assistant' | 'tool' | 'developer';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Streaming tool-call fragment: `index` identifies which call the fragment belongs to. */
export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

/** OpenRouter-style provider routing preferences (gateway extension). */
export interface ProviderPreferences {
  order?: string[];
  only?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
  sort?: 'price' | 'latency' | 'throughput' | 'uptime';
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  seed?: number;
  parallel_tool_calls?: boolean;
  stream_options?: { include_usage?: boolean };
  stop?: string | string[];
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  response_format?:
    | { type: 'text' | 'json_object' }
    | {
        type: 'json_schema';
        json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean };
      };
  stream?: boolean;
  user?: string;
  /** Gateway extension: fallback models tried in order if `model` fails. */
  models?: string[];
  /** Gateway extension. */
  provider?: ProviderPreferences;
  metadata?: Record<string, string>;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Gateway extension: what this call cost the caller, in micro-USD. */
  cost_micros?: number;
  /** Gateway extension: true when the upstream reported no usage and tokens were estimated. */
  estimated?: boolean;
}

/** Gateway extension describing how a request was routed. */
export interface RoutingInfo {
  requested_model?: string;
  model?: string;
  tier?: string;
  reason?: string;
  [key: string]: unknown;
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | null;
}

export interface ChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: Usage;
  /** Gateway extension: which upstream provider served the request. */
  provider?: string;
  routing?: RoutingInfo;
}

export type ChatDelta = Omit<Partial<ChatMessage>, 'tool_calls'> & { tool_calls?: ToolCallDelta[] };

export interface ChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: { index: number; delta: ChatDelta; finish_reason: ChatChoice['finish_reason'] }[];
  usage?: Usage | null;
  provider?: string;
  routing?: RoutingInfo;
  /** Present when the upstream failed mid-stream. */
  error?: { code?: string; message: string };
}
