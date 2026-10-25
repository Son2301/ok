/** Response shapes of the Safe service (see apps/safe/README.md). */

export type CheckKind =
  | 'url'
  | 'text'
  | 'phone'
  | 'bank_account'
  | 'email'
  | 'image'
  | 'video'
  | 'audio'
  | 'ai_text';
export const MEDIA_KINDS: CheckKind[] = ['image', 'video', 'audio'];

/** `safe` is a machine value only: it is never shown to people as "an toàn". */
export type Level = 'safe' | 'low' | 'medium' | 'high' | 'critical' | 'unknown';

export interface Localized {
  vi: string;
  en: string;
}

export interface Signal {
  id: string;
  label: Localized;
  weight: number;
  evidence?: string;
  source: string;
}

export interface SourceStatus {
  name: string;
  status: 'ok' | 'skipped' | 'error';
  detail?: string;
}

export interface Verdict {
  id: string;
  kind: CheckKind;
  input: string;
  score: number;
  level: Level;
  summary: Localized;
  signals: Signal[];
  entities?: {
    urls: string[];
    phones: string[];
    bankAccounts: { accountNumber: string; bankCode?: string; bankName?: string; accountName?: string }[];
    emails: string[];
  };
  recommendations: { vi: string[]; en: string[] };
  ifAlreadyPaid?: { vi: string[]; en: string[] };
  shareText: Localized;
  sources: SourceStatus[];
  details: Record<string, unknown> & {
    scammerGoal?: Localized;
    policeWarnedScripts?: Localized[];
    disclaimer?: Localized | string;
  };
  checkedAt: string;
  cached: boolean;
}

export interface SafeStats {
  days: number;
  totalReports: number;
  verifiedReports: number;
  amountLostVnd: number;
  topCategories: { category: string; label: Localized; count: number }[];
  byType: Record<string, number>;
  totalChecks: number;
  dangerousFound: number;
}

export interface CheckHistoryRow {
  id: string;
  kind: CheckKind;
  level: Level;
  score: number;
  inputPreview: string | null;
  via: string;
  cached: boolean;
  chargedMicros: number | null;
  createdAt: string;
}

export interface SafePricing {
  currency: string;
  perCheck: Partial<Record<CheckKind, number>>;
  freeTier: { checksPerDay: number; mediaChecksPerDay: number; reportsPerDay: number };
}

export type ReportType = 'phone' | 'bank_account' | 'url' | 'email' | 'social_profile';
export const REPORT_TYPES: ReportType[] = ['phone', 'bank_account', 'url', 'email', 'social_profile'];

export const REPORT_CATEGORIES: Record<string, Localized> = {
  impersonation_authority: {
    vi: 'Giả danh công an, cơ quan nhà nước',
    en: 'Impersonating police or government',
  },
  impersonation_bank: { vi: 'Giả danh ngân hàng', en: 'Impersonating a bank' },
  impersonation_utility: {
    vi: 'Giả danh điện lực, nhà mạng, dịch vụ',
    en: 'Impersonating utilities or carriers',
  },
  impersonation_relative: { vi: 'Giả danh người thân, bạn bè', en: 'Impersonating relatives or friends' },
  job_task: { vi: 'Việc làm online, "làm nhiệm vụ"', en: 'Online jobs and task scams' },
  investment: { vi: 'Đầu tư, tiền ảo', en: 'Investment and crypto' },
  loan: { vi: 'Vay tiền online', en: 'Online loans' },
  prize: { vi: 'Trúng thưởng, quà tặng', en: 'Prizes and gifts' },
  delivery: { vi: 'Giao hàng, bưu kiện', en: 'Deliveries and parcels' },
  ecommerce: { vi: 'Mua bán online', en: 'Online shopping' },
  romance: { vi: 'Hẹn hò, tình cảm', en: 'Romance' },
  charity: { vi: 'Từ thiện giả', en: 'Fake charity' },
  emergency: { vi: 'Báo tin người thân gặp nạn', en: 'Fake emergencies' },
  credential_theft: { vi: 'Đánh cắp tài khoản, mã OTP', en: 'Account and OTP theft' },
  malware: { vi: 'Ứng dụng, file độc hại', en: 'Malicious apps and files' },
  recovery: { vi: '"Lấy lại tiền bị lừa"', en: 'Fund recovery scams' },
  account_trade: { vi: 'Mua bán tài khoản', en: 'Account trading' },
  phishing_link: { vi: 'Trang web giả mạo', en: 'Phishing websites' },
  gambling: { vi: 'Cờ bạc online', en: 'Online gambling' },
  spam: { vi: 'Quảng cáo, làm phiền', en: 'Spam and nuisance' },
  other: { vi: 'Khác', en: 'Other' },
};
