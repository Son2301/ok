import { bigint, index, integer, jsonb, pgSchema, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const core = pgSchema('core');

export const orgs = core.table('orgs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  plan: text('plan').notNull().default('free'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = core.table('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const memberships = core.table(
  'memberships',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const sessions = core.table('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  orgId: text('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const apiKeys = core.table(
  'api_keys',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** First characters of the key, safe to display (e.g. `sk-ok-ab12…`). */
    prefix: text('prefix').notNull(),
    hash: text('hash').notNull().unique(),
    /** Products this key may call; `*` means all. */
    scopes: text('scopes').array().notNull().default(['*']),
    spendLimitMicros: bigint('spend_limit_micros', { mode: 'number' }),
    spentMicros: bigint('spent_micros', { mode: 'number' }).notNull().default(0),
    rateLimitRpm: integer('rate_limit_rpm'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_keys_org_idx').on(t.orgId)],
);

export const balances = core.table('balances', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  balanceMicros: bigint('balance_micros', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const walletEntries = core.table(
  'wallet_entries',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** Positive = credit, negative = debit. */
    amountMicros: bigint('amount_micros', { mode: 'number' }).notNull(),
    balanceAfterMicros: bigint('balance_after_micros', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    product: text('product'),
    apiKeyId: text('api_key_id'),
    ref: text('ref'),
    description: text('description'),
    meta: jsonb('meta').$type<Record<string, unknown>>(),
    /** When set, a second debit/credit with the same key for the org is a no-op. */
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('wallet_entries_org_created_idx').on(t.orgId, t.createdAt)],
);

export const topups = core.table(
  'topups',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** Short code the customer puts in the bank-transfer description, e.g. `OKA7F3K2QX`. */
    code: text('code').notNull().unique(),
    amountVnd: bigint('amount_vnd', { mode: 'number' }).notNull(),
    /** Exchange rate locked when the QR was shown, so the customer gets exactly what they saw. */
    vndPerUsd: integer('vnd_per_usd').notNull(),
    status: text('status').notNull().default('pending'),
    receivedVnd: bigint('received_vnd', { mode: 'number' }),
    creditedMicros: bigint('credited_micros', { mode: 'number' }),
    bankTxnId: text('bank_txn_id'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('topups_org_idx').on(t.orgId, t.createdAt)],
);

export const bankTransfers = core.table('bank_transfers', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  amountVnd: bigint('amount_vnd', { mode: 'number' }).notNull(),
  content: text('content'),
  topupId: text('topup_id').references(() => topups.id, { onDelete: 'set null' }),
  status: text('status').notNull(),
  raw: jsonb('raw').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const billingProfiles = core.table('billing_profiles', {
  orgId: text('org_id')
    .primaryKey()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  taxCode: text('tax_code'),
  companyName: text('company_name'),
  address: text('address'),
  invoiceEmail: text('invoice_email'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
