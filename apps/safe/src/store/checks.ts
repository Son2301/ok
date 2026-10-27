import { createHash } from 'node:crypto';
import type { Db } from '@minh/db';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { CheckTicket } from '../billing/metering';
import { checks } from '../db/schema';
import { buildShareText } from '../verdict/builder';
import type { CheckKind, Verdict } from '../verdict/types';

/** Kinds whose input is private content (a message, a document) rather than an identifier. */
const PRIVATE_KINDS: CheckKind[] = ['text', 'ai_text'];

export function inputHash(kind: CheckKind, normalized: string): string {
  return createHash('sha256').update(`${kind}:${normalized}`).digest('hex');
}

/** Short, non-sensitive preview of the input for history lists. */
export function inputPreview(v: Verdict): string | null {
  switch (v.kind) {
    case 'url':
      try {
        return new URL(v.input).hostname;
      } catch {
        return null;
      }
    case 'phone':
      return v.input.length > 6 ? `${v.input.slice(0, v.input.length - 6)}***${v.input.slice(-3)}` : v.input;
    case 'bank_account':
      return v.input.length > 6 ? `${v.input.slice(0, 4)}***${v.input.slice(-3)}` : v.input;
    case 'email':
      return v.input.replace(/^(.).*(@.*)$/, '$1***$2');
    case 'image':
    case 'video':
    case 'audio':
      return v.input;
    default:
      return null;
  }
}

/**
 * Remove private content from a stored verdict unless the user opted in: the message itself,
 * quotes used as evidence, extracted entities and the share card (which quotes the message).
 */
export function redactVerdict(v: Verdict): Verdict {
  if (!PRIVATE_KINDS.includes(v.kind)) return v;
  const signals = v.signals.map(({ evidence: _e, ...s }) => s);
  const { entities: _ent, ...rest } = v;
  return {
    ...rest,
    input: '[redacted]',
    signals,
    shareText: buildShareText(v.kind, '', v.level, v.score, signals),
  };
}

export type CheckRow = typeof checks.$inferSelect;

export class CheckStore {
  constructor(private readonly db: Db) {}

  async record(
    v: Verdict,
    ticket: CheckTicket,
    opts: { storeInput?: boolean; rawInput?: string } = {},
  ): Promise<void> {
    const caller = ticket.caller;
    const keepRaw = Boolean(opts.storeInput) && PRIVATE_KINDS.includes(v.kind);
    await this.db.insert(checks).values({
      id: v.id,
      orgId: caller.type === 'api_key' || caller.type === 'internal' ? caller.orgId : null,
      userId: caller.type === 'internal' ? (caller.userId ?? null) : null,
      apiKeyId: caller.type === 'api_key' ? caller.apiKeyId : null,
      via: caller.type,
      kind: v.kind,
      inputHash: inputHash(v.kind, opts.rawInput ?? v.input),
      inputPreview: inputPreview(v),
      inputRaw: keepRaw ? (opts.rawInput ?? v.input) : null,
      score: v.score,
      level: v.level,
      verdict: (keepRaw ? v : redactVerdict(v)) as unknown as Record<string, unknown>,
      cached: v.cached,
      chargedMicros: ticket.chargedMicros,
    });
  }

  async list(
    orgId: string,
    opts: { limit?: number; before?: Date; kind?: CheckKind; userId?: string } = {},
  ): Promise<CheckRow[]> {
    const conds = [eq(checks.orgId, orgId)];
    if (opts.before) conds.push(lt(checks.createdAt, opts.before));
    if (opts.kind) conds.push(eq(checks.kind, opts.kind));
    if (opts.userId) conds.push(eq(checks.userId, opts.userId));
    return this.db
      .select()
      .from(checks)
      .where(and(...conds))
      .orderBy(desc(checks.createdAt))
      .limit(Math.min(opts.limit ?? 20, 100));
  }

  async get(orgId: string, id: string): Promise<CheckRow | null> {
    const [row] = await this.db
      .select()
      .from(checks)
      .where(and(eq(checks.id, id), eq(checks.orgId, orgId)));
    return row ?? null;
  }

  async stats(days: number, now = new Date()) {
    const since = new Date(now.getTime() - days * 86_400_000);
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        dangerous: sql<number>`count(*) filter (where ${checks.level} in ('high', 'critical'))::int`,
      })
      .from(checks)
      .where(gte(checks.createdAt, since));
    return { totalChecks: Number(row?.total ?? 0), dangerousFound: Number(row?.dangerous ?? 0) };
  }
}
