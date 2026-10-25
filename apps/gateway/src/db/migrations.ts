import type { Migration } from '@ok/db';

/** Hand-written SQL; keep in sync with ./schema.ts. Never edit a shipped migration — add a new one. */
export const gatewayMigrations: Migration[] = [
  {
    id: '0001_requests',
    sql: `
CREATE TABLE gateway.requests (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  api_key_id text,
  product text NOT NULL,
  kind text NOT NULL DEFAULT 'chat',
  requested_model text NOT NULL,
  model text,
  provider text,
  status text NOT NULL,
  error text,
  finish_reason text,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  usage_estimated boolean NOT NULL DEFAULT false,
  cost_micros bigint NOT NULL DEFAULT 0,
  upstream_cost_micros bigint NOT NULL DEFAULT 0,
  latency_ms integer,
  ttft_ms integer,
  attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
  routing jsonb,
  stream boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX requests_org_created_idx ON gateway.requests (org_id, created_at, id);
`,
  },
];
