import type { Migration } from '@minh/db';

/** Hand-written SQL; keep in sync with schema.ts. Never edit a shipped migration — add a new one. */
export const reviewMigrations: Migration[] = [
  {
    id: '0001_init',
    sql: `
CREATE TABLE review.installations (
  id bigint PRIMARY KEY,
  account_login text NOT NULL,
  account_type text NOT NULL DEFAULT 'Organization',
  account_id bigint,
  org_id text,
  status text NOT NULL DEFAULT 'active',
  linked_at timestamptz,
  last_event_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX installations_org_idx ON review.installations (org_id);

CREATE TABLE review.repos (
  id bigint PRIMARY KEY,
  installation_id bigint NOT NULL REFERENCES review.installations(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  private boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX repos_installation_idx ON review.repos (installation_id);
CREATE INDEX repos_full_name_lower_idx ON review.repos (lower(full_name));

CREATE TABLE review.repo_settings (
  repo_id bigint PRIMARY KEY REFERENCES review.repos(id) ON DELETE CASCADE,
  settings jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE review.reviews (
  id text PRIMARY KEY,
  installation_id bigint NOT NULL,
  repo_id bigint NOT NULL,
  repo_full_name text NOT NULL,
  pr_number integer NOT NULL,
  pr_title text,
  head_sha text,
  base_sha text,
  from_sha text,
  mode text NOT NULL,
  trigger text NOT NULL,
  status text NOT NULL,
  status_reason text,
  billed_org_id text,
  billed_to text,
  error text,
  stats jsonb,
  counts jsonb,
  findings_count integer NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  llm_calls integer NOT NULL DEFAULT 0,
  duration_ms integer,
  github_review_id bigint,
  check_run_id bigint,
  config_error text,
  models jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX reviews_pr_idx ON review.reviews (repo_id, pr_number, created_at);
CREATE INDEX reviews_installation_idx ON review.reviews (installation_id, created_at);

CREATE TABLE review.findings (
  id text PRIMARY KEY,
  review_id text NOT NULL REFERENCES review.reviews(id) ON DELETE CASCADE,
  repo_id bigint NOT NULL,
  pr_number integer NOT NULL,
  local_id text NOT NULL,
  path text NOT NULL,
  line integer NOT NULL,
  end_line integer,
  original_line integer NOT NULL,
  original_end_line integer,
  severity text NOT NULL,
  original_severity text NOT NULL,
  category text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  failure_scenario text NOT NULL,
  suggestion text,
  replacement text,
  confidence real NOT NULL,
  verdict text NOT NULL,
  critic_reason text,
  line_corrected boolean NOT NULL DEFAULT false,
  anchored boolean NOT NULL DEFAULT false,
  status text NOT NULL,
  status_reason text,
  fingerprint text NOT NULL,
  snippet_hash text NOT NULL,
  github_comment_id bigint,
  open boolean NOT NULL DEFAULT false,
  tracked_line integer,
  tracked_end_line integer,
  tracked_sha text,
  resolved_in_review_id text,
  resolved_at timestamptz,
  dismissed_at timestamptz,
  dismissed_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX findings_review_idx ON review.findings (review_id);
CREATE INDEX findings_pr_open_idx ON review.findings (repo_id, pr_number, open);
CREATE INDEX findings_fingerprint_idx ON review.findings (repo_id, fingerprint);

CREATE TABLE review.suppressions (
  repo_id bigint NOT NULL,
  fingerprint text NOT NULL,
  path text NOT NULL,
  snippet_hash text NOT NULL,
  title text NOT NULL,
  reason text NOT NULL,
  pr_number integer,
  finding_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, fingerprint)
);

CREATE TABLE review.quota_usage (
  installation_id bigint NOT NULL,
  period text NOT NULL,
  reviews_used integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, period)
);

CREATE TABLE review.pr_notices (
  repo_id bigint NOT NULL,
  pr_number integer NOT NULL,
  kind text NOT NULL,
  key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, pr_number, kind, key)
);

CREATE TABLE review.jobs (
  key text PRIMARY KEY,
  kind text NOT NULL DEFAULT 'review',
  payload jsonb NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_status_idx ON review.jobs (status);
`,
  },
];
