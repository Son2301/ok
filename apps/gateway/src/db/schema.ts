import { bigint, boolean, index, integer, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

export const gateway = pgSchema('gateway');

/** One fallback attempt against one upstream endpoint. */
export interface AttemptLog {
  model: string;
  provider: string;
  endpoint: string;
  upstream_model: string;
  status: 'success' | 'error';
  error_kind?: string;
  http_status?: number;
  error?: string;
  latency_ms: number;
  ttft_ms?: number;
}

/**
 * Request log. One row per gateway request (chat or embeddings). Prompt and
 * completion contents are never stored.
 */
export const requests = gateway.table(
  'requests',
  {
    /** Generation id (`gen_…`), returned to the caller and used as the wallet `ref`. */
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    apiKeyId: text('api_key_id'),
    product: text('product').notNull(),
    kind: text('kind').notNull().default('chat'),
    requestedModel: text('requested_model').notNull(),
    model: text('model'),
    provider: text('provider'),
    /** success | error | partial (upstream failed mid-stream) | aborted (client went away) */
    status: text('status').notNull(),
    error: text('error'),
    finishReason: text('finish_reason'),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    usageEstimated: boolean('usage_estimated').notNull().default(false),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    /** What the upstream charged us. Internal only — never returned to customers. */
    upstreamCostMicros: bigint('upstream_cost_micros', { mode: 'number' }).notNull().default(0),
    latencyMs: integer('latency_ms'),
    ttftMs: integer('ttft_ms'),
    attempts: jsonb('attempts').$type<AttemptLog[]>().notNull().default([]),
    routing: jsonb('routing').$type<Record<string, unknown>>(),
    stream: boolean('stream').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('requests_org_created_idx').on(t.orgId, t.createdAt, t.id)],
);

export type RequestRow = typeof requests.$inferSelect;
export type NewRequestRow = typeof requests.$inferInsert;
