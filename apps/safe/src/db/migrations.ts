import type { Migration } from '@ok/db';

/** Hand-written SQL migrations for the `safe` schema. Keep in sync with schema.ts. Never edit a shipped migration. */
export const safeMigrations: Migration[] = [
  {
    id: '0001_init',
    sql: `
CREATE TABLE safe.checks (
  id text PRIMARY KEY,
  org_id text,
  user_id text,
  api_key_id text,
  via text NOT NULL,
  kind text NOT NULL,
  input_hash text NOT NULL,
  input_preview text,
  input_raw text,
  score integer NOT NULL,
  level text NOT NULL,
  verdict jsonb NOT NULL,
  cached boolean NOT NULL DEFAULT false,
  charged_micros bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checks_org_created_idx ON safe.checks (org_id, created_at);
CREATE INDEX checks_created_idx ON safe.checks (created_at);
CREATE INDEX checks_input_hash_idx ON safe.checks (input_hash);

CREATE TABLE safe.verdict_cache (
  key text PRIMARY KEY,
  kind text NOT NULL,
  lookup_key text,
  level text NOT NULL,
  verdict jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verdict_cache_expires_idx ON safe.verdict_cache (expires_at);
CREATE INDEX verdict_cache_lookup_idx ON safe.verdict_cache (lookup_key);

CREATE TABLE safe.reports (
  id text PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('phone', 'bank_account', 'url', 'email', 'social_profile')),
  value text NOT NULL,
  lookup_key text NOT NULL,
  bank_code text,
  category text NOT NULL,
  description text,
  evidence_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  amount_lost_vnd bigint CHECK (amount_lost_vnd IS NULL OR amount_lost_vnd >= 0),
  reporter_fp text NOT NULL,
  org_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  moderator_note text,
  moderated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX reports_dedupe_idx ON safe.reports (type, value, reporter_fp);
CREATE INDEX reports_lookup_idx ON safe.reports (type, lookup_key);
CREATE INDEX reports_status_created_idx ON safe.reports (status, created_at);
CREATE INDEX reports_created_idx ON safe.reports (created_at);

CREATE TABLE safe.report_evidence (
  id text PRIMARY KEY,
  report_id text NOT NULL REFERENCES safe.reports(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  sha256 text NOT NULL,
  size_bytes integer NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_evidence_report_idx ON safe.report_evidence (report_id);

CREATE TABLE safe.report_votes (
  report_id text NOT NULL REFERENCES safe.reports(id) ON DELETE CASCADE,
  voter_fp text NOT NULL,
  vote text NOT NULL CHECK (vote IN ('confirm', 'dispute')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (report_id, voter_fp)
);

CREATE TABLE safe.brand_overrides (
  brand_id text PRIMARY KEY,
  name text,
  category text,
  official_domains text[] NOT NULL DEFAULT ARRAY[]::text[],
  keywords jsonb NOT NULL DEFAULT '[]'::jsonb,
  mentions text[] NOT NULL DEFAULT ARRAY[]::text[],
  disabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE safe.feed_entries (
  source text NOT NULL,
  url text NOT NULL,
  host text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, url)
);
CREATE INDEX feed_entries_host_idx ON safe.feed_entries (host);
CREATE INDEX feed_entries_url_idx ON safe.feed_entries (url);

CREATE TABLE safe.feed_imports (
  source text PRIMARY KEY,
  last_run_at timestamptz NOT NULL,
  last_status text NOT NULL,
  last_count integer NOT NULL DEFAULT 0,
  last_error text
);

CREATE TABLE safe.rate_limits (
  bucket text NOT NULL,
  key_hash text NOT NULL,
  day date NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, key_hash, day)
);
`,
  },
];
