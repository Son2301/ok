import { createHash } from 'node:crypto';
import type { Db } from '@ok/db';
import { AppError, formatVnd, newId } from '@ok/shared';
import { and, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { findBank, maskAccount, normalizeAccountNumber } from '../bank/banks';
import { reportEvidence, reports, reportVotes } from '../db/schema';
import { sniff } from '../media/containers';
import { maskPhone, parsePhone } from '../phone/phone';
import type { BrandRegistry } from '../url/brand-match';
import { isUserContentHost } from '../url/brand-match';
import { isShortener } from '../url/heuristics';
import { hostKey, type NormalizedUrl, normalizeUrl } from '../url/normalize';
import { signal } from '../verdict/signal';
import type { Signal } from '../verdict/types';
import {
  REPORT_CATEGORIES,
  type ReportCategory,
  type ReportStatus,
  type ReportType,
  TYPE_NOUN,
} from './categories';

export interface ReportInput {
  type: ReportType;
  value: string;
  bankName?: string;
  category: ReportCategory;
  description?: string;
  evidenceUrls?: string[];
  evidenceImages?: { contentType: string; dataBase64: string }[];
  amountLostVnd?: number;
}

export interface NormalizedReportValue {
  value: string;
  lookupKey: string;
  bankCode?: string;
  display: string;
}

export interface ReportSummary {
  total: number;
  verified: number;
  pending: number;
  rejected: number;
  confirmVotes: number;
  disputeVotes: number;
  categories: { category: string; count: number }[];
  lastReportedAt?: string;
  amountLostVnd: number;
  /** Weighted evidence used for scoring (see README). */
  effective: number;
}

export type ReportRow = typeof reports.$inferSelect;

const MAX_IMAGE_BYTES = 1024 * 1024;

/**
 * Key used to match URL reports against URL checks. Normally the host (all pages of a scam
 * domain share a reputation), but on platforms where anyone can publish (facebook.com profiles,
 * sites.google.com pages, shorteners) the path identifies the scammer, not the host.
 */
export function urlReportKey(n: NormalizedUrl, registry?: BrandRegistry): string {
  const host = hostKey(n.host);
  const official = registry?.officialFor(n.host);
  if (official?.userContent || isUserContentHost(n.host) || isShortener(n.host)) {
    const path = n.url.pathname.replace(/\/+$/, '').toLowerCase();
    return `${host}${path}`;
  }
  return host;
}

export class ReportService {
  constructor(
    private readonly db: Db,
    private readonly registry: BrandRegistry,
    private readonly now: () => Date = () => new Date(),
  ) {}

  normalize(type: ReportType, raw: string, bankName?: string): NormalizedReportValue {
    const v = raw.trim();
    switch (type) {
      case 'phone': {
        const p = parsePhone(v);
        if (!p || p.type === 'short_code')
          throw new AppError('bad_request', 'Invalid phone number', { vi: 'Số điện thoại không hợp lệ' });
        return { value: p.e164, lookupKey: p.e164, display: maskPhone(p.national ?? p.e164) };
      }
      case 'bank_account': {
        const acc = normalizeAccountNumber(v);
        if (!acc)
          throw new AppError('bad_request', 'Invalid bank account number (6–19 digits)', {
            vi: 'Số tài khoản không hợp lệ (6–19 chữ số)',
          });
        const bank = findBank(bankName);
        return { value: acc, lookupKey: acc, bankCode: bank?.code, display: maskAccount(acc) };
      }
      case 'url': {
        const n = normalizeUrl(v);
        return { value: n.href, lookupKey: urlReportKey(n, this.registry), display: n.unicodeHost };
      }
      case 'email': {
        const e = v.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e))
          throw new AppError('bad_request', 'Invalid email address', { vi: 'Địa chỉ email không hợp lệ' });
        return { value: e, lookupKey: e, display: e.replace(/^(.).*(@.*)$/, '$1***$2') };
      }
      case 'social_profile': {
        if (/^@?[a-z0-9._-]{2,60}$/i.test(v)) {
          const handle = `handle:${v.replace(/^@/, '').toLowerCase()}`;
          return { value: handle, lookupKey: handle, display: v };
        }
        const n = normalizeUrl(v);
        const key = `${hostKey(n.host)}${n.url.pathname.replace(/\/+$/, '').toLowerCase()}`;
        return { value: key, lookupKey: key, display: key };
      }
    }
  }

  async create(
    input: ReportInput,
    reporterFp: string,
    orgId?: string,
  ): Promise<{ report: ReportRow; deduplicated: boolean }> {
    const norm = this.normalize(input.type, input.value, input.bankName);
    const evidenceUrls = (input.evidenceUrls ?? []).map((u) => {
      try {
        return normalizeUrl(u).href;
      } catch {
        throw new AppError('bad_request', `Invalid evidence URL: ${u.slice(0, 80)}`);
      }
    });
    const images = (input.evidenceImages ?? []).map((img) => {
      const data = Buffer.from(img.dataBase64.replace(/^data:[^,]+,/, ''), 'base64');
      if (!data.length || data.length > MAX_IMAGE_BYTES)
        throw new AppError('bad_request', 'Each evidence image must be 1MB or smaller');
      const kind = sniff(data);
      if (kind?.kind !== 'image')
        throw new AppError('bad_request', 'Evidence images must be PNG, JPEG, WebP or GIF');
      return { data, contentType: kind!.mime };
    });
    const now = this.now();
    const values = {
      id: newId('rpt'),
      type: input.type,
      value: norm.value,
      lookupKey: norm.lookupKey,
      bankCode: norm.bankCode ?? null,
      category: input.category,
      description: input.description?.trim() || null,
      evidenceUrls,
      amountLostVnd: input.amountLostVnd ?? null,
      reporterFp,
      orgId: orgId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    const inserted = await this.db.insert(reports).values(values).onConflictDoNothing().returning();
    let report = inserted[0];
    let deduplicated = false;
    if (!report) {
      // Same reporter, same target: update their report instead of counting it twice.
      deduplicated = true;
      const [updated] = await this.db
        .update(reports)
        .set({
          category: input.category,
          description: values.description ?? sql`${reports.description}`,
          evidenceUrls: evidenceUrls.length ? evidenceUrls : sql`${reports.evidenceUrls}`,
          amountLostVnd: input.amountLostVnd ?? sql`${reports.amountLostVnd}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(reports.type, input.type),
            eq(reports.value, norm.value),
            eq(reports.reporterFp, reporterFp),
          ),
        )
        .returning();
      report = updated!;
    }
    for (const img of images.slice(0, 3)) {
      await this.db.insert(reportEvidence).values({
        id: newId('evd'),
        reportId: report.id,
        contentType: img.contentType,
        sha256: createHash('sha256').update(img.data).digest('hex'),
        sizeBytes: img.data.length,
        data: img.data,
      });
    }
    return { report, deduplicated };
  }

  async vote(
    reportId: string,
    voterFp: string,
    vote: 'confirm' | 'dispute',
  ): Promise<{ confirm: number; dispute: number }> {
    const [r] = await this.db.select({ id: reports.id }).from(reports).where(eq(reports.id, reportId));
    if (!r) throw new AppError('not_found', 'Report not found');
    await this.db
      .insert(reportVotes)
      .values({ reportId, voterFp, vote })
      .onConflictDoUpdate({
        target: [reportVotes.reportId, reportVotes.voterFp],
        set: { vote, createdAt: this.now() },
      });
    const rows = await this.db
      .select({ vote: reportVotes.vote, n: sql<number>`count(*)::int` })
      .from(reportVotes)
      .where(eq(reportVotes.reportId, reportId))
      .groupBy(reportVotes.vote);
    return {
      confirm: Number(rows.find((x) => x.vote === 'confirm')?.n ?? 0),
      dispute: Number(rows.find((x) => x.vote === 'dispute')?.n ?? 0),
    };
  }

  async moderate(id: string, status: ReportStatus, note?: string): Promise<ReportRow> {
    const [row] = await this.db
      .update(reports)
      .set({ status, moderatorNote: note ?? null, moderatedAt: this.now(), updatedAt: this.now() })
      .where(eq(reports.id, id))
      .returning();
    if (!row) throw new AppError('not_found', 'Report not found');
    return row;
  }

  async get(id: string): Promise<ReportRow | null> {
    const [row] = await this.db.select().from(reports).where(eq(reports.id, id));
    return row ?? null;
  }

  async list(
    opts: { status?: ReportStatus; type?: ReportType; limit?: number; before?: Date } = {},
  ): Promise<ReportRow[]> {
    const conds = [];
    if (opts.status) conds.push(eq(reports.status, opts.status));
    if (opts.type) conds.push(eq(reports.type, opts.type));
    if (opts.before) conds.push(lt(reports.createdAt, opts.before));
    return this.db
      .select()
      .from(reports)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(reports.createdAt))
      .limit(Math.min(opts.limit ?? 50, 200));
  }

  async evidence(reportId: string) {
    return this.db
      .select({
        id: reportEvidence.id,
        contentType: reportEvidence.contentType,
        sha256: reportEvidence.sha256,
        sizeBytes: reportEvidence.sizeBytes,
        data: reportEvidence.data,
      })
      .from(reportEvidence)
      .where(eq(reportEvidence.reportId, reportId));
  }

  /** Aggregate reports for one target (only the last 2 years count). */
  async summarize(type: ReportType, lookupKey: string): Promise<ReportSummary> {
    const now = this.now();
    const since = new Date(now.getTime() - 2 * 365 * 86_400_000);
    const rows = await this.db
      .select({
        id: reports.id,
        status: reports.status,
        category: reports.category,
        createdAt: reports.createdAt,
        amount: reports.amountLostVnd,
      })
      .from(reports)
      .where(and(eq(reports.type, type), eq(reports.lookupKey, lookupKey), gte(reports.createdAt, since)))
      .limit(1000);
    const ids = rows.filter((r) => r.status !== 'rejected').map((r) => r.id);
    const votes = ids.length
      ? await this.db
          .select({ reportId: reportVotes.reportId, vote: reportVotes.vote })
          .from(reportVotes)
          .where(inArray(reportVotes.reportId, ids))
      : [];
    const cats = new Map<string, number>();
    let effective = 0;
    let amount = 0;
    let last: Date | undefined;
    for (const r of rows) {
      if (r.status === 'rejected') continue;
      cats.set(r.category, (cats.get(r.category) ?? 0) + 1);
      amount += Number(r.amount ?? 0);
      if (!last || r.createdAt > last) last = r.createdAt;
      const ageDays = Math.max(0, (now.getTime() - r.createdAt.getTime()) / 86_400_000);
      const statusWeight = r.status === 'verified' ? 1 : 0.4;
      const rv = votes.filter((v) => v.reportId === r.id);
      const net = Math.max(
        -0.6,
        Math.min(
          0.6,
          0.15 *
            (rv.filter((v) => v.vote === 'confirm').length - rv.filter((v) => v.vote === 'dispute').length),
        ),
      );
      effective += statusWeight * 0.5 ** (ageDays / 180) * (1 + net);
    }
    return {
      total: rows.filter((r) => r.status !== 'rejected').length,
      verified: rows.filter((r) => r.status === 'verified').length,
      pending: rows.filter((r) => r.status === 'pending').length,
      rejected: rows.filter((r) => r.status === 'rejected').length,
      confirmVotes: votes.filter((v) => v.vote === 'confirm').length,
      disputeVotes: votes.filter((v) => v.vote === 'dispute').length,
      categories: [...cats.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
      lastReportedAt: last?.toISOString(),
      amountLostVnd: amount,
      effective: Math.round(effective * 100) / 100,
    };
  }

  /**
   * Community evidence → signal weight:
   *   effective = Σ status_weight × 0.5^(age_days/180) × (1 + vote_adjust)
   *     status_weight: verified 1.0, pending 0.4, rejected 0;  vote_adjust = ±0.15 per vote, capped ±0.6
   *   weight = min(80, round(30 × log2(1 + 2 × effective)))
   */
  reportSignal(type: ReportType, s: ReportSummary): Signal | null {
    if (s.total === 0 || s.effective <= 0) return null;
    const weight = Math.min(80, Math.round(30 * Math.log2(1 + 2 * s.effective)));
    if (weight <= 0) return null;
    const noun = TYPE_NOUN[type];
    const topCats = s.categories
      .slice(0, 2)
      .map((c) => REPORT_CATEGORIES[c.category as ReportCategory]?.vi ?? c.category);
    const ago = s.lastReportedAt ? relativeVi(new Date(s.lastReportedAt), this.now()) : '';
    const parts = [
      topCats.length ? `Loại: ${topCats.join(', ')}` : '',
      ago ? `gần nhất: ${ago}` : '',
      s.amountLostVnd > 0 ? `thiệt hại khai báo: ${s.amountLostVnd.toLocaleString('vi-VN')} ₫` : '',
    ].filter(Boolean);
    return signal(
      'reports.community',
      weight,
      {
        vi: `Cộng đồng đã báo cáo ${noun.vi} này ${s.total} lần${s.verified ? ` (${s.verified} báo cáo đã được xác minh)` : ' (chưa được xác minh)'}`,
        en: `The community has reported this ${noun.en} ${s.total} time(s)${s.verified ? ` (${s.verified} verified)` : ' (not yet verified)'}`,
      },
      'community_reports',
      parts.join('; '),
    );
  }

  async lookupSignal(
    type: ReportType,
    lookupKey: string,
  ): Promise<{ summary: ReportSummary; signal: Signal | null }> {
    const summary = await this.summarize(type, lookupKey);
    return { summary, signal: this.reportSignal(type, summary) };
  }

  /** Public aggregates for the homepage. Never exposes reported values. */
  async stats(days: number) {
    const since = new Date(this.now().getTime() - days * 86_400_000);
    const where = and(gte(reports.createdAt, since), ne(reports.status, 'rejected'));
    const [byCategory, byType, totals] = await Promise.all([
      this.db
        .select({ category: reports.category, n: sql<number>`count(*)::int` })
        .from(reports)
        .where(where)
        .groupBy(reports.category)
        .orderBy(desc(sql`count(*)`))
        .limit(10),
      this.db
        .select({ type: reports.type, n: sql<number>`count(*)::int` })
        .from(reports)
        .where(where)
        .groupBy(reports.type),
      this.db
        .select({
          total: sql<number>`count(*)::int`,
          verified: sql<number>`count(*) filter (where ${reports.status} = 'verified')::int`,
          amount: sql<string>`coalesce(sum(${reports.amountLostVnd}), 0)::text`,
        })
        .from(reports)
        .where(where),
    ]);
    return {
      totalReports: Number(totals[0]?.total ?? 0),
      verifiedReports: Number(totals[0]?.verified ?? 0),
      amountLostVnd: Number(totals[0]?.amount ?? 0),
      amountLostDisplay: `${Number(totals[0]?.amount ?? 0).toLocaleString('vi-VN')} ₫`,
      topCategories: byCategory.map((c) => ({
        category: c.category,
        label: REPORT_CATEGORIES[c.category as ReportCategory] ?? { vi: c.category, en: c.category },
        count: Number(c.n),
      })),
      byType: Object.fromEntries(byType.map((t) => [t.type, Number(t.n)])),
    };
  }
}

function relativeVi(d: Date, now: Date): string {
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days <= 0) return 'hôm nay';
  if (days === 1) return 'hôm qua';
  if (days < 30) return `${days} ngày trước`;
  if (days < 365) return `${Math.floor(days / 30)} tháng trước`;
  return `${Math.floor(days / 365)} năm trước`;
}

export { formatVnd };
