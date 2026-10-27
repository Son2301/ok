import type { Core } from '@minh/core';
import { AppError } from '@minh/shared';
import type { SafeEnv } from '../env';
import { type CheckKind, MEDIA_KINDS } from '../verdict/types';
import type { DailyLimiter, LimitResult } from './limiter';

export type Caller =
  | { type: 'anonymous'; ip: string }
  | { type: 'api_key'; orgId: string; apiKeyId: string }
  | { type: 'internal'; orgId: string; userId?: string }
  | { type: 'telegram'; chatId: string };

export interface CheckTicket {
  caller: Caller;
  kind: CheckKind;
  checkId: string;
  chargedMicros: number;
  /** Org billed for LLM usage (gateway `x-org-id`); null → LLM analysis is skipped. */
  llmOrgId: string | null;
  limit?: LimitResult;
}

const KIND_LABEL_VI: Record<CheckKind, string> = {
  url: 'kiểm tra',
  text: 'kiểm tra',
  phone: 'kiểm tra',
  bank_account: 'kiểm tra',
  email: 'kiểm tra',
  ai_text: 'kiểm tra',
  image: 'kiểm tra ảnh/video/âm thanh',
  video: 'kiểm tra ảnh/video/âm thanh',
  audio: 'kiểm tra ảnh/video/âm thanh',
};

/**
 * Who pays for a check:
 *  - anonymous (per-IP daily quota) and Telegram (per-chat quota): free, LLM billed to SAFE_PLATFORM_ORG_ID;
 *  - console users (internal token): free with a generous per-org quota, LLM billed to the platform org;
 *  - API keys: charged per check via core.debit (product "safe"), LLM billed to the caller's org.
 */
export class Metering {
  constructor(
    private readonly core: Core,
    private readonly limiter: DailyLimiter,
    private readonly env: SafeEnv,
    private readonly prices: Record<CheckKind, number>,
  ) {}

  price(kind: CheckKind): number {
    return this.prices[kind];
  }

  async begin(caller: Caller, kind: CheckKind, checkId: string): Promise<CheckTicket> {
    const platform = this.env.SAFE_PLATFORM_ORG_ID ?? null;
    const isMedia = MEDIA_KINDS.includes(kind);
    switch (caller.type) {
      case 'anonymous': {
        const bucket = isMedia ? 'anon_media' : 'anon_check';
        const max = isMedia ? this.env.SAFE_ANON_DAILY_MEDIA : this.env.SAFE_ANON_DAILY_CHECKS;
        const limit = await this.limiter.hit(bucket, caller.ip, max);
        if (!limit.allowed) throw quotaError(limit, KIND_LABEL_VI[kind]);
        return { caller, kind, checkId, chargedMicros: 0, llmOrgId: platform, limit };
      }
      case 'telegram': {
        const limit = await this.limiter.hit('telegram', caller.chatId, this.env.SAFE_TELEGRAM_DAILY_CHECKS);
        if (!limit.allowed) throw quotaError(limit, KIND_LABEL_VI[kind]);
        return { caller, kind, checkId, chargedMicros: 0, llmOrgId: platform, limit };
      }
      case 'internal': {
        const limit = await this.limiter.hit('internal', caller.orgId, this.env.SAFE_INTERNAL_DAILY_CHECKS);
        if (!limit.allowed) throw quotaError(limit, KIND_LABEL_VI[kind]);
        return { caller, kind, checkId, chargedMicros: 0, llmOrgId: platform, limit };
      }
      case 'api_key': {
        const price = this.prices[kind];
        await this.core.debit(caller.orgId, price, {
          product: 'safe',
          apiKeyId: caller.apiKeyId,
          ref: checkId,
          description: `Safe ${kind} check`,
          meta: { kind },
        });
        return { caller, kind, checkId, chargedMicros: price, llmOrgId: caller.orgId };
      }
    }
  }

  /** Give the money back when a paid check fails on our side. */
  async refund(ticket: CheckTicket, reason: string): Promise<void> {
    if (ticket.caller.type !== 'api_key' || ticket.chargedMicros <= 0) return;
    await this.core.credit(ticket.caller.orgId, ticket.chargedMicros, {
      kind: 'refund',
      ref: ticket.checkId,
      description: `Refund: Safe ${ticket.kind} check failed`,
      meta: { reason: reason.slice(0, 200) },
    });
  }
}

function quotaError(limit: LimitResult, what: string): AppError {
  return new AppError(
    'rate_limited',
    `Daily free limit of ${limit.limit} reached. Try again after ${limit.resetAt.toISOString()} or use an API key.`,
    {
      vi: `Bạn đã dùng hết ${limit.limit} lượt ${what} miễn phí hôm nay. Vui lòng quay lại sau 0 giờ (giờ Việt Nam).`,
      limit: limit.limit,
      resetAt: limit.resetAt.toISOString(),
    },
  );
}
