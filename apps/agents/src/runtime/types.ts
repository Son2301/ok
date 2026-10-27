import type { ChatMessage, ToolDefinition } from '@minh/llm';

/**
 * Wire protocol between the control plane and an agent runtime (inline or
 * container). The control plane builds the full context; runtimes are
 * stateless and never touch the database or third-party credentials.
 */
export interface TurnBudget {
  /** Max total LLM tokens (prompt + completion, summed over steps) for one turn. */
  maxTokens: number;
  /** Wall-clock limit for the whole turn. */
  maxMs: number;
}

export interface TurnRequest {
  agentId: string;
  conversationId: string;
  model: string;
  /** System prompt + history + the new user message. */
  messages: ChatMessage[];
  tools: ToolDefinition[];
  /** Tools whose calls must run one at a time (side effects); others may run in parallel. */
  sequentialTools?: string[];
  maxSteps: number;
  budget: TurnBudget;
  temperature?: number;
  locale?: 'vi' | 'en';
}

export type StopReason = 'final' | 'max_steps' | 'token_budget' | 'time_budget';

export interface ToolTrace {
  id: string;
  name: string;
  arguments: unknown;
  ok: boolean;
  outcome?: string;
  error?: string;
  preview: string;
  durationMs: number;
}

export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costMicros: number;
}

export interface TurnResult {
  reply: string;
  /** New assistant/tool messages produced during the turn, in order. */
  messages: (ChatMessage & { usage?: { prompt: number; completion: number } })[];
  toolCalls: ToolTrace[];
  usage: TurnUsage;
  steps: number;
  stopReason: StopReason;
}

export type TurnEvent =
  | { type: 'start'; conversationId: string }
  | { type: 'step'; step: number }
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      ok: boolean;
      outcome?: string;
      preview: string;
      durationMs: number;
    };

/** Outcome of executing one tool call (wherever it runs, tools execute in the control plane). */
export interface ToolOutcome {
  ok: boolean;
  /** `executed`, `pending_approval`, `drafted`, `denied` or `error`. */
  outcome: string;
  result?: unknown;
  error?: string;
  durationMs: number;
}
