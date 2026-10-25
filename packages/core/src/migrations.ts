import type { Migration } from '@ok/db';

export const coreMigrations: Migration[] = [
  {
    id: '0001_init',
    sql: `
CREATE TABLE core.orgs (
  id text PRIMARY KEY,
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE core.users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE core.memberships (
  org_id text NOT NULL REFERENCES core.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  PRIMARY KEY (org_id, user_id)
);
CREATE TABLE core.sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES core.users(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES core.orgs(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE core.api_keys (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES core.orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['*'],
  spend_limit_micros bigint,
  spent_micros bigint NOT NULL DEFAULT 0,
  rate_limit_rpm integer,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_org_idx ON core.api_keys (org_id);
CREATE TABLE core.balances (
  org_id text PRIMARY KEY REFERENCES core.orgs(id) ON DELETE CASCADE,
  balance_micros bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE core.wallet_entries (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES core.orgs(id) ON DELETE CASCADE,
  amount_micros bigint NOT NULL,
  balance_after_micros bigint NOT NULL,
  kind text NOT NULL,
  product text,
  api_key_id text,
  ref text,
  description text,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_entries_org_created_idx ON core.wallet_entries (org_id, created_at);
`,
  },
  {
    id: '0002_wallet_idempotency',
    sql: `
ALTER TABLE core.wallet_entries ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX wallet_entries_org_idem_idx ON core.wallet_entries (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
`,
  },
];
