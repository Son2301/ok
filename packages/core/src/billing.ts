import { randomBytes } from 'node:crypto';
import { AppError, MICRO, newId } from '@ok/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Core } from './core';
import { bankTransfers, billingProfiles, topups } from './schema';

export type Topup = typeof topups.$inferSelect;
export type BillingProfile = typeof billingProfiles.$inferSelect;

export interface BankAccount {
  /** VietQR bank id/BIN or short name accepted by img.vietqr.io, e.g. `970436` or `vietcombank`. */
  bankId: string;
  accountNo: string;
  accountName: string;
}

export interface BillingOptions {
  bank?: BankAccount;
  /** Exchange rate used to convert VND top-ups into wallet credit (micro-USD). */
  vndPerUsd: number;
  minTopupVnd?: number;
  maxTopupVnd?: number;
  topupTtlMs?: number;
  /** Called after money lands, e.g. to send "Đã nhận 200.000đ" on Zalo. Errors are swallowed. */
  onTopupPaid?: (event: { orgId: string; topup: Topup; balanceMicros: number }) => void | Promise<void>;
  now?: () => Date;
}

/** Fields SePay sends to its webhook (https://docs.sepay.vn). Only the ones we use are required. */
export interface SepayTransfer {
  id: number | string;
  transferType: 'in' | 'out';
  transferAmount: number;
  content?: string | null;
  code?: string | null;
  referenceCode?: string | null;
  accountNumber?: string | null;
  transactionDate?: string | null;
  gateway?: string | null;
}

export type WebhookOutcome =
  | { status: 'credited'; topupId: string; orgId: string; creditedMicros: number }
  | { status: 'unmatched' | 'ignored'; reason: string };

const CODE_PREFIX = 'OK';
const CODE_RE = new RegExp(`${CODE_PREFIX}[A-Z0-9]{8}`, 'i');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I: people retype these by hand

function newTopupCode(): string {
  const bytes = randomBytes(8);
  let out = CODE_PREFIX;
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/**
 * VND wallet top-ups by VietQR bank transfer, auto-confirmed by a bank-feed
 * webhook (SePay). Credits never expire; the rate shown on the QR is the rate applied.
 */
export class Billing {
  private readonly db;
  constructor(
    private readonly core: Core,
    private readonly opts: BillingOptions,
  ) {
    this.db = core.database;
  }

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  get bankAccount(): BankAccount | null {
    return this.opts.bank ?? null;
  }

  publicConfig() {
    return {
      topupsEnabled: Boolean(this.opts.bank),
      minTopupVnd: this.opts.minTopupVnd ?? 20_000,
      maxTopupVnd: this.opts.maxTopupVnd ?? 50_000_000,
      vndPerUsd: this.opts.vndPerUsd,
      creditsExpire: false,
    };
  }

  vndToMicros(vnd: number, rate = this.opts.vndPerUsd): number {
    return Math.floor((vnd * MICRO) / rate);
  }

  microsToVnd(micros: number, rate = this.opts.vndPerUsd): number {
    return Math.round((micros * rate) / MICRO);
  }

  /** VietQR "quick link" image (https://www.vietqr.io) with amount and description pre-filled. */
  qrImageUrl(topup: Pick<Topup, 'amountVnd' | 'code'>): string | null {
    const bank = this.opts.bank;
    if (!bank) return null;
    const params = new URLSearchParams({
      amount: String(topup.amountVnd),
      addInfo: topup.code,
      accountName: bank.accountName,
    });
    return `https://img.vietqr.io/image/${encodeURIComponent(bank.bankId)}-${encodeURIComponent(bank.accountNo)}-compact2.png?${params}`;
  }

  async createTopup(orgId: string, amountVnd: number): Promise<Topup> {
    if (!this.opts.bank) throw new AppError('unavailable', 'Bank transfer top-ups are not configured yet');
    const min = this.opts.minTopupVnd ?? 20_000;
    const max = this.opts.maxTopupVnd ?? 50_000_000;
    if (!Number.isInteger(amountVnd) || amountVnd < min || amountVnd > max) {
      throw new AppError('bad_request', `Top-up must be a whole number between ${min} and ${max} VND`);
    }
    const [row] = await this.db
      .insert(topups)
      .values({
        id: newId('top'),
        orgId,
        code: newTopupCode(),
        amountVnd,
        vndPerUsd: this.opts.vndPerUsd,
        expiresAt: new Date(this.now().getTime() + (this.opts.topupTtlMs ?? 24 * 3600_000)),
      })
      .returning();
    return row!;
  }

  async getTopup(orgId: string, id: string): Promise<Topup> {
    const [row] = await this.db
      .select()
      .from(topups)
      .where(and(eq(topups.id, id), eq(topups.orgId, orgId)));
    if (!row) throw new AppError('not_found', 'Top-up not found');
    return row;
  }

  listTopups(orgId: string, limit = 20): Promise<Topup[]> {
    return this.db
      .select()
      .from(topups)
      .where(eq(topups.orgId, orgId))
      .orderBy(desc(topups.createdAt))
      .limit(Math.min(limit, 100));
  }

  /**
   * Process one incoming bank transfer. Idempotent: SePay retries are safe
   * because the wallet credit is keyed on the bank transaction id.
   * The customer is credited for what actually arrived, at the rate locked on
   * their QR — even if the QR has expired. Money received is never ignored.
   */
  async handleSepayTransfer(t: SepayTransfer): Promise<WebhookOutcome> {
    const txnId = `sepay:${t.id}`;
    if (t.transferType !== 'in') return { status: 'ignored', reason: 'outgoing transfer' };
    const amount = Math.round(Number(t.transferAmount));
    if (!Number.isFinite(amount) || amount <= 0) return { status: 'ignored', reason: 'non-positive amount' };

    const code = (t.code ?? '').match(CODE_RE)?.[0] ?? (t.content ?? '').match(CODE_RE)?.[0];
    const [topup] = code
      ? await this.db.select().from(topups).where(eq(topups.code, code.toUpperCase()))
      : [];

    await this.db
      .insert(bankTransfers)
      .values({
        id: txnId,
        provider: 'sepay',
        amountVnd: amount,
        content: t.content ?? null,
        topupId: topup?.id ?? null,
        status: topup ? 'matched' : 'unmatched',
        raw: t as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing();

    if (!topup)
      return { status: 'unmatched', reason: code ? `unknown code ${code}` : 'no top-up code in description' };

    const creditedMicros = this.vndToMicros(amount, topup.vndPerUsd);
    const balanceMicros = await this.core.credit(topup.orgId, creditedMicros, {
      kind: 'topup',
      ref: topup.id,
      description: `Nạp ${amount.toLocaleString('vi-VN')}đ qua chuyển khoản`,
      meta: { amount_vnd: amount, vnd_per_usd: topup.vndPerUsd, bank_txn: txnId },
      idempotencyKey: txnId,
    });

    const firstPayment = topup.status !== 'paid';
    if (firstPayment) {
      const [updated] = await this.db
        .update(topups)
        .set({
          status: 'paid',
          receivedVnd: amount,
          creditedMicros,
          bankTxnId: txnId,
          paidAt: this.now(),
        })
        .where(eq(topups.id, topup.id))
        .returning();
      try {
        await this.opts.onTopupPaid?.({ orgId: topup.orgId, topup: updated!, balanceMicros });
      } catch {}
    }
    return { status: 'credited', topupId: topup.id, orgId: topup.orgId, creditedMicros };
  }

  async walletSummary(orgId: string) {
    const [balanceMicros, avgDailyMicros] = await Promise.all([
      this.core.getBalance(orgId),
      this.core.averageDailySpend(orgId, 7),
    ]);
    const daysLeft = avgDailyMicros > 0 ? Math.max(0, Math.floor(balanceMicros / avgDailyMicros)) : null;
    return {
      balanceMicros,
      balanceVnd: this.microsToVnd(balanceMicros),
      vndPerUsd: this.opts.vndPerUsd,
      avgDailySpendMicros: avgDailyMicros,
      avgDailySpendVnd: this.microsToVnd(avgDailyMicros),
      /** "Số dư đủ dùng khoảng N ngày" — null when there is no recent spend. */
      forecastDaysLeft: daysLeft,
      creditsExpire: false,
    };
  }

  async getProfile(orgId: string): Promise<BillingProfile | null> {
    const [row] = await this.db.select().from(billingProfiles).where(eq(billingProfiles.orgId, orgId));
    return row ?? null;
  }

  async setProfile(
    orgId: string,
    input: {
      taxCode?: string | null;
      companyName?: string | null;
      address?: string | null;
      invoiceEmail?: string | null;
    },
  ): Promise<BillingProfile> {
    if (input.taxCode && !/^\d{10}(-\d{3})?$/.test(input.taxCode)) {
      throw new AppError(
        'bad_request',
        'Mã số thuế must be 10 digits, optionally followed by -XXX for a branch',
      );
    }
    const values = {
      orgId,
      taxCode: input.taxCode ?? null,
      companyName: input.companyName ?? null,
      address: input.address ?? null,
      invoiceEmail: input.invoiceEmail ?? null,
      updatedAt: new Date(),
    };
    const [row] = await this.db
      .insert(billingProfiles)
      .values(values)
      .onConflictDoUpdate({ target: billingProfiles.orgId, set: values })
      .returning();
    return row!;
  }
}
