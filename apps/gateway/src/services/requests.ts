import type { Db } from '@minh/db';
import { AppError } from '@minh/shared';
import { and, desc, eq, gte, lt, type SQL, sql } from 'drizzle-orm';
import { type NewRequestRow, type RequestRow, requests } from '../db/schema';

export type UsageGroupBy = 'day' | 'model' | 'provider' | 'key' | 'product';

export interface UsageBucket {
  key: string;
  requests: number;
  errors: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_micros: number;
  avg_latency_ms: number | null;
}

interface Cursor {
  t: string;
  id: string;
}

export function encodeCursor(row: Pick<RequestRow, 'createdAt' | 'id'>): string {
  return Buffer.from(
    JSON.stringify({ t: row.createdAt.toISOString(), id: row.id } satisfies Cursor),
  ).toString('base64url');
}

export function decodeCursor(cursor: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor;
    if (typeof c.t !== 'string' || typeof c.id !== 'string' || Number.isNaN(Date.parse(c.t)))
      throw new Error('bad');
    return c;
  } catch {
    throw new AppError('bad_request', 'Invalid cursor');
  }
}

const num = (v: unknown) => Number(v ?? 0);

/** Persistence + analytics over `gateway.requests`. Every query is scoped to one org. */
export class RequestLog {
  constructor(private readonly db: Db) {}

  async insert(row: NewRequestRow): Promise<void> {
    await this.db.insert(requests).values(row);
  }

  async get(orgId: string, id: string): Promise<RequestRow | null> {
    const [row] = await this.db
      .select()
      .from(requests)
      .where(and(eq(requests.orgId, orgId), eq(requests.id, id)));
    return row ?? null;
  }

  /** Newest first, keyset-paginated on (created_at, id). */
  async list(
    orgId: string,
    opts: { limit: number; cursor?: string; status?: string; model?: string },
  ): Promise<{ rows: RequestRow[]; nextCursor: string | null }> {
    const conditions: SQL[] = [eq(requests.orgId, orgId)];
    if (opts.cursor) {
      const c = decodeCursor(opts.cursor);
      conditions.push(sql`(${requests.createdAt}, ${requests.id}) < (${c.t}::timestamptz, ${c.id})`);
    }
    if (opts.status) conditions.push(eq(requests.status, opts.status));
    if (opts.model) conditions.push(eq(requests.model, opts.model));
    const rows = await this.db
      .select()
      .from(requests)
      .where(and(...conditions))
      .orderBy(desc(requests.createdAt), desc(requests.id))
      .limit(opts.limit + 1);
    const page = rows.slice(0, opts.limit);
    return { rows: page, nextCursor: rows.length > opts.limit ? encodeCursor(page[page.length - 1]!) : null };
  }

  async usage(orgId: string, opts: { from: Date; to: Date; groupBy: UsageGroupBy }): Promise<UsageBucket[]> {
    const keyExpr: SQL<string> = {
      day: sql<string>`to_char(${requests.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      model: sql<string>`coalesce(${requests.model}, ${requests.requestedModel})`,
      provider: sql<string>`coalesce(${requests.provider}, 'none')`,
      key: sql<string>`coalesce(${requests.apiKeyId}, 'internal')`,
      product: sql<string>`${requests.product}`,
    }[opts.groupBy];

    const rows = await this.db
      .select({
        key: keyExpr,
        requests: sql`count(*)`.mapWith(num),
        errors: sql`count(*) filter (where ${requests.status} <> 'success')`.mapWith(num),
        prompt_tokens: sql`coalesce(sum(${requests.promptTokens}), 0)`.mapWith(num),
        completion_tokens: sql`coalesce(sum(${requests.completionTokens}), 0)`.mapWith(num),
        cost_micros: sql`coalesce(sum(${requests.costMicros}), 0)`.mapWith(num),
        avg_latency_ms: sql`avg(${requests.latencyMs})`.mapWith((v: unknown) =>
          v == null ? null : Math.round(Number(v)),
        ),
      })
      .from(requests)
      .where(
        and(eq(requests.orgId, orgId), gte(requests.createdAt, opts.from), lt(requests.createdAt, opts.to)),
      )
      .groupBy(keyExpr)
      .orderBy(keyExpr);
    return rows.map((r) => ({ ...r, key: String(r.key) }));
  }
}
