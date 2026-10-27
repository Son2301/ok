import { createHash } from 'node:crypto';
import type { Db } from '@minh/db';
import { lt, sql } from 'drizzle-orm';
import { rateLimits } from '../db/schema';

const VN_OFFSET_MS = 7 * 3600_000;

/** Calendar day in Vietnam (UTC+7), so free quotas reset at local midnight. */
export function vnDay(now: Date): string {
  return new Date(now.getTime() + VN_OFFSET_MS).toISOString().slice(0, 10);
}

export function nextVnMidnight(now: Date): Date {
  const day = vnDay(now);
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000 - VN_OFFSET_MS);
}

export interface LimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  resetAt: Date;
}

/**
 * Daily counters persisted in Postgres (works across replicas). Keys (IPs, chat ids) are
 * stored only as salted SHA-256 hashes.
 */
export class DailyLimiter {
  constructor(
    private readonly db: Db,
    private readonly salt: string,
  ) {}

  hashKey(raw: string): string {
    return createHash('sha256').update(`${this.salt}:${raw}`).digest('hex').slice(0, 40);
  }

  async hit(bucket: string, rawKey: string, limit: number, now = new Date()): Promise<LimitResult> {
    const day = vnDay(now);
    const keyHash = this.hashKey(rawKey);
    const [row] = await this.db
      .insert(rateLimits)
      .values({ bucket, keyHash, day, count: 1 })
      .onConflictDoUpdate({
        target: [rateLimits.bucket, rateLimits.keyHash, rateLimits.day],
        set: { count: sql`${rateLimits.count} + 1` },
      })
      .returning({ count: rateLimits.count });
    const count = row?.count ?? 1;
    return {
      allowed: count <= limit,
      count,
      limit,
      remaining: Math.max(0, limit - count),
      resetAt: nextVnMidnight(now),
    };
  }

  async prune(now = new Date()): Promise<void> {
    const cutoff = vnDay(new Date(now.getTime() - 3 * 86_400_000));
    await this.db.delete(rateLimits).where(lt(rateLimits.day, cutoff));
  }
}
