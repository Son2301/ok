import { type DbHandle, type Migration, migrate } from '@ok/db';

/** Hand-written SQL for the `agents` schema. Keep in sync with `schema.ts`. Never edit a shipped migration. */
export const agentsMigrations: Migration[] = [
  {
    id: '0001_init',
    sql: `
CREATE TABLE agents.org_profiles (
  org_id text PRIMARY KEY,
  company_name text,
  company_description text,
  language text NOT NULL DEFAULT 'vi',
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents.agents (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  name text NOT NULL,
  avatar_url text,
  role text NOT NULL DEFAULT 'Assistant',
  job_description text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT 'auto',
  runtime text NOT NULL DEFAULT 'builtin' CHECK (runtime IN ('builtin', 'openclaw', 'hermes')),
  plan text NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter', 'pro')),
  integrations jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  reports_to text REFERENCES agents.agents(id) ON DELETE SET NULL,
  budget_monthly_micros bigint CHECK (budget_monthly_micros IS NULL OR budget_monthly_micros >= 0),
  status text NOT NULL DEFAULT 'draft',
  status_reason text,
  deployed_at timestamptz,
  last_heartbeat_at timestamptz,
  last_daily_summary_on text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reports_to IS NULL OR reports_to <> id)
);
CREATE INDEX agents_org_idx ON agents.agents (org_id);
CREATE INDEX agents_status_idx ON agents.agents (status);

CREATE TABLE agents.integration_credentials (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  agent_id text NOT NULL REFERENCES agents.agents(id) ON DELETE CASCADE,
  integration_id text NOT NULL,
  ciphertext text NOT NULL,
  key_id text NOT NULL,
  masked jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX integration_credentials_agent_integration_uq ON agents.integration_credentials (agent_id, integration_id);

CREATE TABLE agents.kb_documents (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  agent_id text REFERENCES agents.agents(id) ON DELETE CASCADE,
  title text NOT NULL,
  source text,
  mime_type text NOT NULL,
  chars integer NOT NULL,
  chunk_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kb_documents_org_agent_idx ON agents.kb_documents (org_id, agent_id);

-- 'simple' text search config: no stemming/stop words, so Vietnamese works without a dictionary.
-- content_normalized is lowercased with diacritics stripped (done in the app) so "khong dau" queries match.
CREATE TABLE agents.kb_chunks (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES agents.kb_documents(id) ON DELETE CASCADE,
  org_id text NOT NULL,
  agent_id text,
  ordinal integer NOT NULL,
  content text NOT NULL,
  content_normalized text NOT NULL,
  tokens integer NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED,
  tsv_normalized tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content_normalized)) STORED
);
CREATE INDEX kb_chunks_org_agent_idx ON agents.kb_chunks (org_id, agent_id);
CREATE INDEX kb_chunks_document_idx ON agents.kb_chunks (document_id);
CREATE INDEX kb_chunks_tsv_idx ON agents.kb_chunks USING gin (tsv);
CREATE INDEX kb_chunks_tsv_normalized_idx ON agents.kb_chunks USING gin (tsv_normalized);

CREATE TABLE agents.conversations (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  agent_id text NOT NULL REFERENCES agents.agents(id) ON DELETE CASCADE,
  channel text NOT NULL,
  external_user_id text NOT NULL,
  title text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_disclosed_at timestamptz,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX conversations_key_uq ON agents.conversations (agent_id, channel, external_user_id);
CREATE INDEX conversations_org_idx ON agents.conversations (org_id);

CREATE TABLE agents.messages (
  id text PRIMARY KEY,
  seq bigserial NOT NULL,
  conversation_id text NOT NULL REFERENCES agents.conversations(id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  org_id text NOT NULL,
  role text NOT NULL,
  content text,
  tool_calls jsonb,
  tool_call_id text,
  name text,
  prompt_tokens integer,
  completion_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_seq_idx ON agents.messages (conversation_id, seq);
CREATE INDEX messages_agent_created_idx ON agents.messages (agent_id, created_at);

CREATE TABLE agents.tool_calls (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  agent_id text NOT NULL REFERENCES agents.agents(id) ON DELETE CASCADE,
  conversation_id text REFERENCES agents.conversations(id) ON DELETE SET NULL,
  tool_call_id text,
  tool text NOT NULL,
  integration_id text,
  arguments jsonb,
  result jsonb,
  ok boolean NOT NULL,
  outcome text NOT NULL,
  error text,
  duration_ms integer NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tool_calls_agent_created_idx ON agents.tool_calls (agent_id, created_at);

CREATE TABLE agents.approvals (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  agent_id text NOT NULL REFERENCES agents.agents(id) ON DELETE CASCADE,
  conversation_id text REFERENCES agents.conversations(id) ON DELETE SET NULL,
  tool_call_id text,
  tool text NOT NULL,
  integration_id text NOT NULL,
  arguments jsonb NOT NULL,
  mode text NOT NULL CHECK (mode IN ('approve', 'draft')),
  status text NOT NULL CHECK (status IN ('pending', 'drafted', 'executed', 'failed', 'rejected')),
  result jsonb,
  error text,
  decided_by text,
  decision_note text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approvals_org_status_idx ON agents.approvals (org_id, status, created_at);

CREATE TABLE agents.tasks (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  assignee_agent_id text REFERENCES agents.agents(id) ON DELETE SET NULL,
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'agent')),
  created_by_id text,
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'blocked', 'done')),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  due_at timestamptz,
  parent_task_id text REFERENCES agents.tasks(id) ON DELETE CASCADE,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_org_assignee_status_idx ON agents.tasks (org_id, assignee_agent_id, status);
CREATE INDEX tasks_parent_idx ON agents.tasks (parent_task_id);

CREATE TABLE agents.task_comments (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES agents.tasks(id) ON DELETE CASCADE,
  org_id text NOT NULL,
  author_type text NOT NULL CHECK (author_type IN ('user', 'agent')),
  author_id text,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_comments_task_idx ON agents.task_comments (task_id, created_at);

CREATE TABLE agents.reports (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  agent_id text NOT NULL REFERENCES agents.agents(id) ON DELETE CASCADE,
  manager_agent_id text REFERENCES agents.agents(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('report', 'daily_summary')),
  title text NOT NULL,
  body text NOT NULL,
  task_id text REFERENCES agents.tasks(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_org_created_idx ON agents.reports (org_id, created_at);
CREATE INDEX reports_manager_created_idx ON agents.reports (manager_agent_id, created_at);

-- Kept after an agent is deleted (billing history), hence no foreign key.
CREATE TABLE agents.usage_monthly (
  agent_id text NOT NULL,
  month text NOT NULL,
  org_id text NOT NULL,
  requests integer NOT NULL DEFAULT 0,
  prompt_tokens bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0,
  total_tokens bigint NOT NULL DEFAULT 0,
  platform_tokens bigint NOT NULL DEFAULT 0,
  customer_tokens bigint NOT NULL DEFAULT 0,
  platform_cost_micros bigint NOT NULL DEFAULT 0,
  customer_cost_micros bigint NOT NULL DEFAULT 0,
  budget_warned_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, month)
);
CREATE INDEX usage_monthly_org_month_idx ON agents.usage_monthly (org_id, month);

CREATE TABLE agents.billing_charges (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  agent_id text NOT NULL,
  day text NOT NULL,
  plan text NOT NULL,
  amount_micros bigint NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'charged', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- At most one live (pending or charged) charge per agent per day: makes daily billing idempotent across replicas.
CREATE UNIQUE INDEX billing_charges_agent_day_uq ON agents.billing_charges (agent_id, day) WHERE status IN ('pending', 'charged');
CREATE INDEX billing_charges_org_idx ON agents.billing_charges (org_id, created_at);

CREATE TABLE agents.channels (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  agent_id text NOT NULL REFERENCES agents.agents(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('telegram', 'zalo', 'web')),
  enabled boolean NOT NULL DEFAULT true,
  public_token text,
  secret_hash text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX channels_agent_type_uq ON agents.channels (agent_id, type);
CREATE UNIQUE INDEX channels_public_token_uq ON agents.channels (public_token) WHERE public_token IS NOT NULL;

CREATE TABLE agents.runtime_tokens (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  agent_id text NOT NULL REFERENCES agents.agents(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('container', 'external')),
  label text,
  token_hash text NOT NULL,
  prefix text NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX runtime_tokens_hash_uq ON agents.runtime_tokens (token_hash);
CREATE INDEX runtime_tokens_agent_idx ON agents.runtime_tokens (agent_id);

CREATE TABLE agents.agent_events (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  agent_id text NOT NULL REFERENCES agents.agents(id) ON DELETE CASCADE,
  level text NOT NULL,
  type text NOT NULL,
  message text NOT NULL,
  data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_events_agent_created_idx ON agents.agent_events (agent_id, created_at);

CREATE TABLE agents.inbound_events (
  agent_id text NOT NULL REFERENCES agents.agents(id) ON DELETE CASCADE,
  channel text NOT NULL,
  external_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, channel, external_id)
);
`,
  },
];

export function migrateAgents(handle: DbHandle): Promise<string[]> {
  return migrate(handle, 'agents', agentsMigrations);
}
