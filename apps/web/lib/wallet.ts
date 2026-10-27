import 'server-only';
import type { WalletEntry } from '@minh/core';
import { coreSchema } from '@minh/core';
import { PRODUCT_IDS, type ProductId } from '@minh/shared';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { env } from './env';
import { platform } from './platform';
import { gatewayApi } from './services';
import type { WalletSummary } from './types/gateway';

export type { WalletEntry };

export interface WalletView {
  summary: WalletSummary;
  /** `local` = computed from the shared database because the gateway was unreachable. */
  source: 'gateway' | 'local';
}

/**
 * Balance + run-out forecast. The gateway is authoritative (it holds the
 * published VND rate); when it is down we compute the same numbers from the
 * shared ledger so the console still shows the balance.
 */
export async function getWallet(orgId: string): Promise<WalletView> {
  const res = await gatewayApi.wallet(orgId);
  if (res.ok) return { summary: res.data, source: 'gateway' };
  const { core } = await platform();
  const rate = env().vndPerUsd;
  const [balanceMicros, avgDailySpendMicros] = await Promise.all([
    core.getBalance(orgId),
    core.averageDailySpend(orgId, 7),
  ]);
  return {
    source: 'local',
    summary: {
      balanceMicros,
      balanceVnd: Math.round((balanceMicros * rate) / 1_000_000),
      vndPerUsd: rate,
      avgDailySpendMicros,
      avgDailySpendVnd: Math.round((avgDailySpendMicros * rate) / 1_000_000),
      forecastDaysLeft:
        avgDailySpendMicros > 0 ? Math.max(0, Math.floor(balanceMicros / avgDailySpendMicros)) : null,
      creditsExpire: false,
    },
  };
}

export function isProduct(v: unknown): v is ProductId {
  return typeof v === 'string' && (PRODUCT_IDS as string[]).includes(v);
}

export async function listLedger(
  orgId: string,
  opts: { product?: ProductId; before?: Date; limit?: number } = {},
): Promise<WalletEntry[]> {
  const { core } = await platform();
  return core.listWalletEntries(orgId, {
    limit: opts.limit ?? 50,
    before: opts.before,
    product: opts.product,
  });
}

export async function getLedgerEntry(orgId: string, id: string): Promise<WalletEntry | null> {
  const { core } = await platform();
  const e = coreSchema.walletEntries;
  const [row] = await core.database
    .select()
    .from(e)
    .where(and(eq(e.orgId, orgId), eq(e.id, id)));
  return row ?? null;
}

export interface ProductSpend {
  product: ProductId | 'other';
  micros: number;
  count: number;
}

/** Debits per product over the last `days` days (from the shared ledger, so every product is included). */
export async function spendByProduct(orgId: string, days = 30): Promise<ProductSpend[]> {
  const { core } = await platform();
  const e = coreSchema.walletEntries;
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await core.database
    .select({
      product: e.product,
      micros: sql<string>`coalesce(sum(-${e.amountMicros}), 0)`,
      count: sql<string>`count(*)`,
    })
    .from(e)
    .where(and(eq(e.orgId, orgId), lt(e.amountMicros, 0), gte(e.createdAt, since)))
    .groupBy(e.product);
  const byProduct = new Map<string, ProductSpend>();
  for (const r of rows) {
    const key = isProduct(r.product) ? r.product : 'other';
    const prev = byProduct.get(key) ?? { product: key, micros: 0, count: 0 };
    prev.micros += Number(r.micros);
    prev.count += Number(r.count);
    byProduct.set(key, prev);
  }
  return [...PRODUCT_IDS, 'other' as const]
    .map((p) => byProduct.get(p) ?? { product: p, micros: 0, count: 0 })
    .filter((p) => p.product !== 'other' || p.micros > 0);
}

/** Debits per Vietnam-time day over the last `days` days, zero-filled, oldest first. */
export async function dailySpend(orgId: string, days = 30): Promise<{ day: string; micros: number }[]> {
  const { core } = await platform();
  const e = coreSchema.walletEntries;
  const since = new Date(Date.now() - days * 86_400_000);
  const dayExpr = sql<string>`to_char(${e.createdAt} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`;
  const rows = await core.database
    .select({ day: dayExpr, micros: sql<string>`coalesce(sum(-${e.amountMicros}), 0)` })
    .from(e)
    .where(and(eq(e.orgId, orgId), lt(e.amountMicros, 0), gte(e.createdAt, since)))
    .groupBy(dayExpr);
  const map = new Map(rows.map((r) => [r.day, Number(r.micros)]));
  const out: { day: string; micros: number }[] = [];
  const vnNow = new Date(Date.now() + 7 * 3600_000); // UTC+7, no DST
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(vnNow.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    out.push({ day: d, micros: map.get(d) ?? 0 });
  }
  return out;
}
