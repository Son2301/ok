import { createHash } from 'node:crypto';
import type { Db } from '@ok/db';
import { and, eq, gt, lt } from 'drizzle-orm';
import { verdictCache } from '../db/schema';
import type { CheckKind, Level, Verdict } from '../verdict/types';

/** Cache lifetime by level: dangerous verdicts change slowly; uncertain ones are re-checked soon. */
export const CACHE_TTL_MS: Record<Level, number> = {
  critical: 6 * 3600_000,
  high: 6 * 3600_000,
  medium: 60 * 60_000,
  low: 30 * 60_000,
  safe: 12 * 3600_000,
  unknown: 10 * 60_000,
};
/** If any source errored, retry sooner. */
const ERROR_TTL_MS = 10 * 60_000;

export function ttlFor(v: Verdict): number {
  const base = CACHE_TTL_MS[v.level];
  return v.sources.some((s) => s.status === 'error') ? Math.min(base, ERROR_TTL_MS) : base;
}

export class VerdictCache {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  key(kind: CheckKind, normalized: string): string {
    return `${kind}:${createHash('sha256').update(normalized).digest('hex')}`;
  }

  async get(kind: CheckKind, normalized: string): Promise<Verdict | null> {
    const [row] = await this.db
      .select({ verdict: verdictCache.verdict })
      .from(verdictCache)
      .where(and(eq(verdictCache.key, this.key(kind, normalized)), gt(verdictCache.expiresAt, this.now())));
    return row ? (row.verdict as unknown as Verdict) : null;
  }

  async set(kind: CheckKind, normalized: string, verdict: Verdict, lookupKey?: string): Promise<void> {
    const key = this.key(kind, normalized);
    const expiresAt = new Date(this.now().getTime() + ttlFor(verdict));
    const row = {
      key,
      kind,
      lookupKey: lookupKey ?? null,
      level: verdict.level,
      verdict: verdict as unknown as Record<string, unknown>,
      expiresAt,
      createdAt: this.now(),
    };
    await this.db
      .insert(verdictCache)
      .values(row)
      .onConflictDoUpdate({
        target: verdictCache.key,
        set: {
          level: row.level,
          verdict: row.verdict,
          expiresAt,
          lookupKey: row.lookupKey,
          createdAt: row.createdAt,
        },
      });
  }

  /** Drop cached verdicts affected by a new/moderated community report. */
  async invalidate(kind: CheckKind, lookupKey: string): Promise<void> {
    await this.db
      .delete(verdictCache)
      .where(and(eq(verdictCache.kind, kind), eq(verdictCache.lookupKey, lookupKey)));
  }

  async prune(): Promise<void> {
    await this.db.delete(verdictCache).where(lt(verdictCache.expiresAt, this.now()));
  }
}
