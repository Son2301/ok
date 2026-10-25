import type { Localized } from '../verdict/types';

export const REPORT_TYPES = ['phone', 'bank_account', 'url', 'email', 'social_profile'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_STATUSES = ['pending', 'verified', 'rejected'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_CATEGORIES = {
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
} as const satisfies Record<string, Localized>;

export type ReportCategory = keyof typeof REPORT_CATEGORIES;
export const REPORT_CATEGORY_IDS = Object.keys(REPORT_CATEGORIES) as [ReportCategory, ...ReportCategory[]];

export const TYPE_NOUN: Record<ReportType, Localized> = {
  phone: { vi: 'số điện thoại', en: 'phone number' },
  bank_account: { vi: 'số tài khoản', en: 'bank account' },
  url: { vi: 'trang web', en: 'website' },
  email: { vi: 'địa chỉ email', en: 'email address' },
  social_profile: { vi: 'tài khoản mạng xã hội', en: 'social media profile' },
};
