import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** Keep in sync with migrations.ts (hand-written SQL is the source of truth for the database). */
export const safe = pgSchema('safe');

const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => 'bytea',
  toDriver: (v) => v,
  fromDriver: (v) => Buffer.from(v),
});

const ts = (name: string) => timestamp(name, { withTimezone: true });

/** One row per check performed (history + analytics). Inputs are stored as hashes unless the user opted in. */
export const checks = safe.table(
  'checks',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id'),
    userId: text('user_id'),
    apiKeyId: text('api_key_id'),
    via: text('via').notNull(),
    kind: text('kind').notNull(),
    inputHash: text('input_hash').notNull(),
    inputPreview: text('input_preview'),
    inputRaw: text('input_raw'),
    score: integer('score').notNull(),
    level: text('level').notNull(),
    verdict: jsonb('verdict').$type<Record<string, unknown>>().notNull(),
    cached: boolean('cached').notNull().default(false),
    chargedMicros: bigint('charged_micros', { mode: 'number' }).notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('checks_org_created_idx').on(t.orgId, t.createdAt),
    index('checks_created_idx').on(t.createdAt),
    index('checks_input_hash_idx').on(t.inputHash),
  ],
);

export const verdictCache = safe.table(
  'verdict_cache',
  {
    key: text('key').primaryKey(),
    kind: text('kind').notNull(),
    lookupKey: text('lookup_key'),
    level: text('level').notNull(),
    verdict: jsonb('verdict').$type<Record<string, unknown>>().notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('verdict_cache_expires_idx').on(t.expiresAt),
    index('verdict_cache_lookup_idx').on(t.lookupKey),
  ],
);

export const reports = safe.table(
  'reports',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    /** Normalized value (E.164 phone, digits for accounts, canonical URL, lowercase email…). */
    value: text('value').notNull(),
    /** What checks match on: host for URLs, otherwise same as value. */
    lookupKey: text('lookup_key').notNull(),
    bankCode: text('bank_code'),
    category: text('category').notNull(),
    description: text('description'),
    evidenceUrls: jsonb('evidence_urls').$type<string[]>().notNull().default([]),
    amountLostVnd: bigint('amount_lost_vnd', { mode: 'number' }),
    reporterFp: text('reporter_fp').notNull(),
    orgId: text('org_id'),
    status: text('status').notNull().default('pending'),
    moderatorNote: text('moderator_note'),
    moderatedAt: ts('moderated_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('reports_dedupe_idx').on(t.type, t.value, t.reporterFp),
    index('reports_lookup_idx').on(t.type, t.lookupKey),
    index('reports_status_created_idx').on(t.status, t.createdAt),
    index('reports_created_idx').on(t.createdAt),
  ],
);

export const reportEvidence = safe.table(
  'report_evidence',
  {
    id: text('id').primaryKey(),
    reportId: text('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    contentType: text('content_type').notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    data: bytea('data').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('report_evidence_report_idx').on(t.reportId)],
);

export const reportVotes = safe.table(
  'report_votes',
  {
    reportId: text('report_id')
      .notNull()
      .references(() => reports.id, { onDelete: 'cascade' }),
    voterFp: text('voter_fp').notNull(),
    vote: text('vote').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.reportId, t.voterFp] })],
);

export const brandOverrides = safe.table('brand_overrides', {
  brandId: text('brand_id').primaryKey(),
  name: text('name'),
  category: text('category'),
  officialDomains: text('official_domains').array().notNull().default([]),
  keywords: jsonb('keywords')
    .$type<{ k: string; mode: 'fuzzy' | 'substring' | 'prefix' | 'token' }[]>()
    .notNull()
    .default([]),
  mentions: text('mentions').array().notNull().default([]),
  disabled: boolean('disabled').notNull().default(false),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const feedEntries = safe.table(
  'feed_entries',
  {
    source: text('source').notNull(),
    url: text('url').notNull(),
    host: text('host').notNull(),
    firstSeen: ts('first_seen').notNull().defaultNow(),
    lastSeen: ts('last_seen').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.source, t.url] }),
    index('feed_entries_host_idx').on(t.host),
    index('feed_entries_url_idx').on(t.url),
  ],
);

export const feedImports = safe.table('feed_imports', {
  source: text('source').primaryKey(),
  lastRunAt: ts('last_run_at').notNull(),
  lastStatus: text('last_status').notNull(),
  lastCount: integer('last_count').notNull().default(0),
  lastError: text('last_error'),
});

export const rateLimits = safe.table(
  'rate_limits',
  {
    bucket: text('bucket').notNull(),
    keyHash: text('key_hash').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.keyHash, t.day] })],
);
