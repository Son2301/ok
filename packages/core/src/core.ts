import type { DbHandle } from '@ok/db';
import { migrate } from '@ok/db';
import { AppError, newId, type ProductId } from '@ok/shared';
import { and, asc, desc, eq, gt, gte, isNull, lt, sql } from 'drizzle-orm';
import { generateApiKey, generateSessionToken, hashPassword, sha256, verifyPassword } from './crypto';
import { coreMigrations } from './migrations';
import { apiKeys, balances, memberships, orgs, sessions, users, walletEntries } from './schema';

export type ApiKeyRecord = typeof apiKeys.$inferSelect;
export type WalletEntry = typeof walletEntries.$inferSelect;
export type Org = typeof orgs.$inferSelect;
export type User = Omit<typeof users.$inferSelect, 'passwordHash'>;

export interface CoreOptions {
  /** Credit granted to every new org, in micro-USD. */
  welcomeCreditMicros?: number;
  sessionTtlMs?: number;
}

export interface DebitOptions {
  product: ProductId;
  kind?: 'usage' | 'subscription' | 'adjustment';
  apiKeyId?: string;
  ref?: string;
  description?: string;
  meta?: Record<string, unknown>;
  /**
   * Makes the charge safe to retry: a second debit with the same key for the
   * same org returns the original result instead of charging again.
   */
  idempotencyKey?: string;
  /**
   * Charge even if it takes the balance below zero. Used for post-paid usage
   * whose exact cost is only known after the work is done (e.g. LLM tokens).
   */
  force?: boolean;
}

/**
 * Accounts, API keys and the shared wallet. One wallet funds every product,
 * so a customer tops up once and spends across Gateway, Agents, Safe and Review.
 */
export class Core {
  private readonly db;
  constructor(
    private readonly handle: DbHandle,
    private readonly opts: CoreOptions = {},
  ) {
    this.db = handle.db;
  }

  migrate() {
    return migrate(this.handle, 'core', coreMigrations);
  }

  /** Underlying Drizzle handle, for platform modules (billing) that share the core schema. */
  get database() {
    return this.db;
  }

  // ---------------------------------------------------------------- accounts

  async signUp(input: {
    email: string;
    password: string;
    name?: string;
    orgName?: string;
  }): Promise<{ user: User; org: Org }> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError('bad_request', 'Invalid email');
    if (input.password.length < 8)
      throw new AppError('bad_request', 'Password must be at least 8 characters');
    const existing = await this.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (existing.length) throw new AppError('conflict', 'An account with this email already exists');

    const passwordHash = await hashPassword(input.password);
    return this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ id: newId('usr'), email, name: input.name ?? null, passwordHash })
        .returning();
      const [org] = await tx
        .insert(orgs)
        .values({ id: newId('org'), name: input.orgName ?? input.name ?? email.split('@')[0]! })
        .returning();
      await tx.insert(memberships).values({ orgId: org!.id, userId: user!.id, role: 'owner' });
      const welcome = this.opts.welcomeCreditMicros ?? 0;
      await tx.insert(balances).values({ orgId: org!.id, balanceMicros: welcome });
      if (welcome > 0) {
        await tx.insert(walletEntries).values({
          id: newId('wle'),
          orgId: org!.id,
          amountMicros: welcome,
          balanceAfterMicros: welcome,
          kind: 'grant',
          description: 'Welcome credit',
        });
      }
      const { passwordHash: _, ...safeUser } = user!;
      return { user: safeUser, org: org! };
    });
  }

  /** Create an org without a user (service accounts, tests, seeding). */
  async createOrg(name: string, initialCreditMicros = 0): Promise<Org> {
    return this.db.transaction(async (tx) => {
      const [org] = await tx
        .insert(orgs)
        .values({ id: newId('org'), name })
        .returning();
      await tx.insert(balances).values({ orgId: org!.id, balanceMicros: initialCreditMicros });
      if (initialCreditMicros > 0) {
        await tx.insert(walletEntries).values({
          id: newId('wle'),
          orgId: org!.id,
          amountMicros: initialCreditMicros,
          balanceAfterMicros: initialCreditMicros,
          kind: 'grant',
        });
      }
      return org!;
    });
  }

  /** Idempotently create an org with a fixed id (e.g. the platform org that funds free tiers). */
  async ensureOrg(id: string, name: string, initialCreditMicros = 0): Promise<Org> {
    const existing = await this.getOrg(id);
    if (existing) return existing;
    return this.db.transaction(async (tx) => {
      const [org] = await tx.insert(orgs).values({ id, name }).onConflictDoNothing().returning();
      if (!org) return (await this.getOrg(id))!;
      await tx.insert(balances).values({ orgId: id, balanceMicros: initialCreditMicros });
      if (initialCreditMicros > 0) {
        await tx.insert(walletEntries).values({
          id: newId('wle'),
          orgId: id,
          amountMicros: initialCreditMicros,
          balanceAfterMicros: initialCreditMicros,
          kind: 'grant',
          description: 'Initial platform credit',
        });
      }
      return org;
    });
  }

  async login(emailRaw: string, password: string): Promise<{ token: string; user: User; orgId: string }> {
    const email = emailRaw.trim().toLowerCase();
    const [row] = await this.db.select().from(users).where(eq(users.email, email));
    if (!row || !(await verifyPassword(password, row.passwordHash))) {
      throw new AppError('unauthorized', 'Wrong email or password');
    }
    const [membership] = await this.db.select().from(memberships).where(eq(memberships.userId, row.id));
    if (!membership) throw new AppError('forbidden', 'User has no organization');
    const token = generateSessionToken();
    await this.db.insert(sessions).values({
      tokenHash: sha256(token),
      userId: row.id,
      orgId: membership.orgId,
      expiresAt: new Date(Date.now() + (this.opts.sessionTtlMs ?? 30 * 24 * 3600_000)),
    });
    const { passwordHash: _, ...user } = row;
    return { token, user, orgId: membership.orgId };
  }

  async getSession(token: string): Promise<{ user: User; org: Org; role: string } | null> {
    const [row] = await this.db
      .select({ session: sessions, user: users, org: orgs })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(orgs, eq(orgs.id, sessions.orgId))
      .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())));
    if (!row) return null;
    const [m] = await this.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, row.org.id), eq(memberships.userId, row.user.id)));
    const { passwordHash: _, ...user } = row.user;
    return { user, org: row.org, role: m?.role ?? 'member' };
  }

  async logout(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
  }

  async renameOrg(orgId: string, name: string): Promise<Org> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200)
      throw new AppError('bad_request', 'Organization name must be 1–200 characters');
    const [org] = await this.db.update(orgs).set({ name: trimmed }).where(eq(orgs.id, orgId)).returning();
    if (!org) throw new AppError('not_found', 'Organization not found');
    return org;
  }

  listMembers(orgId: string) {
    return this.db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        role: memberships.role,
        createdAt: users.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(eq(memberships.orgId, orgId))
      .orderBy(asc(users.createdAt));
  }

  async getOrg(orgId: string): Promise<Org | null> {
    const [org] = await this.db.select().from(orgs).where(eq(orgs.id, orgId));
    return org ?? null;
  }

  // ---------------------------------------------------------------- api keys

  async createApiKey(
    orgId: string,
    input: {
      name: string;
      scopes?: (ProductId | '*')[];
      spendLimitMicros?: number | null;
      rateLimitRpm?: number | null;
    },
  ): Promise<{ key: string; record: ApiKeyRecord }> {
    const key = generateApiKey();
    const [record] = await this.db
      .insert(apiKeys)
      .values({
        id: newId('key'),
        orgId,
        name: input.name,
        prefix: `${key.slice(0, 12)}…`,
        hash: sha256(key),
        scopes: input.scopes?.length ? input.scopes : ['*'],
        spendLimitMicros: input.spendLimitMicros ?? null,
        rateLimitRpm: input.rateLimitRpm ?? null,
      })
      .returning();
    return { key, record: record! };
  }

  listApiKeys(orgId: string): Promise<ApiKeyRecord[]> {
    return this.db.select().from(apiKeys).where(eq(apiKeys.orgId, orgId)).orderBy(desc(apiKeys.createdAt));
  }

  async revokeApiKey(orgId: string, keyId: string): Promise<void> {
    const res = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    if (!res.length) throw new AppError('not_found', 'API key not found');
  }

  /** Update an active key's name, scopes or limits. `null` removes a limit. */
  async updateApiKey(
    orgId: string,
    keyId: string,
    patch: {
      name?: string;
      scopes?: (ProductId | '*')[];
      spendLimitMicros?: number | null;
      rateLimitRpm?: number | null;
    },
  ): Promise<ApiKeyRecord> {
    const set: Partial<typeof apiKeys.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.scopes !== undefined) set.scopes = patch.scopes.length ? patch.scopes : ['*'];
    if (patch.spendLimitMicros !== undefined) set.spendLimitMicros = patch.spendLimitMicros;
    if (patch.rateLimitRpm !== undefined) set.rateLimitRpm = patch.rateLimitRpm;
    if (!Object.keys(set).length) throw new AppError('bad_request', 'Nothing to update');
    const [record] = await this.db
      .update(apiKeys)
      .set(set)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, orgId), isNull(apiKeys.revokedAt)))
      .returning();
    if (!record) throw new AppError('not_found', 'API key not found');
    return record;
  }

  /** Returns the key record if the plaintext key is valid and active, else null. */
  async verifyApiKey(plaintext: string): Promise<ApiKeyRecord | null> {
    const [record] = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.hash, sha256(plaintext)), isNull(apiKeys.revokedAt)));
    if (!record) return null;
    // Best-effort, throttled to one write per minute per key.
    if (!record.lastUsedAt || Date.now() - record.lastUsedAt.getTime() > 60_000) {
      void this.db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, record.id))
        .catch(() => {});
    }
    return record;
  }

  // ------------------------------------------------------------------ wallet

  async getBalance(orgId: string): Promise<number> {
    const [row] = await this.db.select().from(balances).where(eq(balances.orgId, orgId));
    return row?.balanceMicros ?? 0;
  }

  async credit(
    orgId: string,
    amountMicros: number,
    opts: {
      kind?: 'topup' | 'grant' | 'refund' | 'promo';
      ref?: string;
      description?: string;
      meta?: Record<string, unknown>;
      /** A second credit with the same key for the org is a no-op (safe webhook retries). */
      idempotencyKey?: string;
    } = {},
  ): Promise<number> {
    if (!Number.isInteger(amountMicros) || amountMicros <= 0)
      throw new AppError('bad_request', 'Credit amount must be a positive integer');
    if (opts.idempotencyKey) {
      const prior = await this.findByIdempotencyKey(orgId, opts.idempotencyKey);
      if (prior) return prior.balanceAfterMicros;
    }
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(balances)
          .values({ orgId, balanceMicros: amountMicros })
          .onConflictDoUpdate({
            target: balances.orgId,
            set: { balanceMicros: sql`${balances.balanceMicros} + ${amountMicros}`, updatedAt: new Date() },
          })
          .returning();
        await tx.insert(walletEntries).values({
          id: newId('wle'),
          orgId,
          amountMicros,
          balanceAfterMicros: row!.balanceMicros,
          kind: opts.kind ?? 'topup',
          ref: opts.ref ?? null,
          description: opts.description ?? null,
          meta: opts.meta ?? null,
          idempotencyKey: opts.idempotencyKey ?? null,
        });
        return row!.balanceMicros;
      });
    } catch (err) {
      if (opts.idempotencyKey && isUniqueViolation(err)) {
        const prior = await this.findByIdempotencyKey(orgId, opts.idempotencyKey);
        if (prior) return prior.balanceAfterMicros;
      }
      throw err;
    }
  }

  /** Average daily spend over the last `days` days, in micro-USD (debits only). */
  async averageDailySpend(orgId: string, days = 7): Promise<number> {
    const since = new Date(Date.now() - days * 86_400_000);
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(-${walletEntries.amountMicros}), 0)` })
      .from(walletEntries)
      .where(
        and(
          eq(walletEntries.orgId, orgId),
          lt(walletEntries.amountMicros, 0),
          gte(walletEntries.createdAt, since),
        ),
      );
    return Math.round(Number(row?.total ?? 0) / days);
  }

  /** Atomically charge the org. Throws `payment_required` if funds are insufficient (unless `force`). */
  async debit(orgId: string, amountMicros: number, opts: DebitOptions): Promise<number> {
    if (!Number.isInteger(amountMicros) || amountMicros < 0)
      throw new AppError('bad_request', 'Debit amount must be a non-negative integer');
    if (amountMicros === 0) return this.getBalance(orgId);
    if (opts.idempotencyKey) {
      const prior = await this.findByIdempotencyKey(orgId, opts.idempotencyKey);
      if (prior) return prior.balanceAfterMicros;
    }
    try {
      return await this.applyDebit(orgId, amountMicros, opts);
    } catch (err) {
      // Lost a race with a concurrent retry carrying the same key.
      if (opts.idempotencyKey && isUniqueViolation(err)) {
        const prior = await this.findByIdempotencyKey(orgId, opts.idempotencyKey);
        if (prior) return prior.balanceAfterMicros;
      }
      throw err;
    }
  }

  private async findByIdempotencyKey(orgId: string, key: string): Promise<WalletEntry | undefined> {
    const [row] = await this.db
      .select()
      .from(walletEntries)
      .where(and(eq(walletEntries.orgId, orgId), eq(walletEntries.idempotencyKey, key)));
    return row;
  }

  private applyDebit(orgId: string, amountMicros: number, opts: DebitOptions): Promise<number> {
    return this.db.transaction(async (tx) => {
      const conditions = [eq(balances.orgId, orgId)];
      if (!opts.force) conditions.push(gte(balances.balanceMicros, amountMicros));
      const [row] = await tx
        .update(balances)
        .set({ balanceMicros: sql`${balances.balanceMicros} - ${amountMicros}`, updatedAt: new Date() })
        .where(and(...conditions))
        .returning();
      if (!row) throw new AppError('payment_required', 'Insufficient balance. Please top up your wallet.');
      await tx.insert(walletEntries).values({
        id: newId('wle'),
        orgId,
        amountMicros: -amountMicros,
        balanceAfterMicros: row.balanceMicros,
        kind: opts.kind ?? 'usage',
        product: opts.product,
        apiKeyId: opts.apiKeyId ?? null,
        ref: opts.ref ?? null,
        description: opts.description ?? null,
        meta: opts.meta ?? null,
        idempotencyKey: opts.idempotencyKey ?? null,
      });
      if (opts.apiKeyId) {
        await tx
          .update(apiKeys)
          .set({ spentMicros: sql`${apiKeys.spentMicros} + ${amountMicros}` })
          .where(eq(apiKeys.id, opts.apiKeyId));
      }
      return row.balanceMicros;
    });
  }

  listWalletEntries(
    orgId: string,
    opts: { limit?: number; before?: Date; product?: ProductId } = {},
  ): Promise<WalletEntry[]> {
    const conditions = [eq(walletEntries.orgId, orgId)];
    if (opts.before) conditions.push(lt(walletEntries.createdAt, opts.before));
    if (opts.product) conditions.push(eq(walletEntries.product, opts.product));
    return this.db
      .select()
      .from(walletEntries)
      .where(and(...conditions))
      .orderBy(desc(walletEntries.createdAt))
      .limit(Math.min(opts.limit ?? 50, 500));
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}
