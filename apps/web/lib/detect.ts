/**
 * Smart input for the scam checker: one box that accepts a link, a phone
 * number, a bank account, an email address or a whole pasted message, and
 * works out which check to run. Pure and client-safe; the user can always
 * override the guess (a 10-digit number can be both a phone and an account).
 */

export type InputKind = 'url' | 'phone' | 'bank_account' | 'email' | 'text';

export interface Detection {
  kind: InputKind | 'empty';
  /** Normalised value to send to the API (digits only for phone/account, URL with scheme, …). */
  value: string;
  /** Bank recognised next to an account number ("STK 0123456789 Vietcombank"). */
  bank?: BankHint;
  /** Other plausible readings the UI can offer as one-tap alternatives. */
  alternatives: InputKind[];
}

export interface BankHint {
  /** Short code used by Vietnamese banks/VietQR, e.g. `VCB`. */
  code: string;
  name: string;
}

/** Common Vietnamese banks and wallets, matched case-insensitively as whole words. */
export const BANKS: { code: string; name: string; aliases: string[] }[] = [
  { code: 'VCB', name: 'Vietcombank', aliases: ['vcb', 'vietcombank', 'vietcom'] },
  { code: 'TCB', name: 'Techcombank', aliases: ['tcb', 'techcombank', 'techcom'] },
  { code: 'MB', name: 'MB Bank', aliases: ['mb', 'mbbank', 'mb bank', 'quân đội', 'quan doi'] },
  { code: 'ACB', name: 'ACB', aliases: ['acb', 'á châu', 'a chau'] },
  { code: 'BIDV', name: 'BIDV', aliases: ['bidv'] },
  { code: 'CTG', name: 'VietinBank', aliases: ['ctg', 'vtb', 'vietinbank', 'viettinbank', 'vietin'] },
  { code: 'VPB', name: 'VPBank', aliases: ['vpb', 'vpbank'] },
  { code: 'TPB', name: 'TPBank', aliases: ['tpb', 'tpbank', 'tiên phong'] },
  { code: 'STB', name: 'Sacombank', aliases: ['stb', 'sacombank', 'sacom'] },
  { code: 'VBA', name: 'Agribank', aliases: ['vba', 'agribank', 'agri'] },
  { code: 'VIB', name: 'VIB', aliases: ['vib'] },
  { code: 'SHB', name: 'SHB', aliases: ['shb'] },
  { code: 'HDB', name: 'HDBank', aliases: ['hdb', 'hdbank'] },
  { code: 'OCB', name: 'OCB', aliases: ['ocb', 'phương đông'] },
  { code: 'MSB', name: 'MSB', aliases: ['msb', 'maritime'] },
  { code: 'SCB', name: 'SCB', aliases: ['scb'] },
  { code: 'LPB', name: 'LPBank', aliases: ['lpb', 'lpbank', 'lienviet', 'liên việt'] },
  { code: 'SEAB', name: 'SeABank', aliases: ['seab', 'seabank'] },
  { code: 'ABB', name: 'ABBank', aliases: ['abb', 'abbank'] },
  { code: 'EIB', name: 'Eximbank', aliases: ['eib', 'eximbank', 'exim'] },
  { code: 'NAB', name: 'Nam A Bank', aliases: ['nab', 'namabank', 'nam a bank', 'nam á'] },
  { code: 'BAB', name: 'Bac A Bank', aliases: ['bab', 'bacabank', 'bắc á'] },
  { code: 'PVCB', name: 'PVcomBank', aliases: ['pvcb', 'pvcombank'] },
  { code: 'VAB', name: 'VietABank', aliases: ['vab', 'vietabank'] },
  { code: 'NCB', name: 'NCB', aliases: ['ncb'] },
  { code: 'KLB', name: 'KienlongBank', aliases: ['klb', 'kienlongbank'] },
  { code: 'CAKE', name: 'Cake by VPBank', aliases: ['cake'] },
  { code: 'TIMO', name: 'Timo', aliases: ['timo'] },
  { code: 'MOMO', name: 'MoMo', aliases: ['momo'] },
  { code: 'ZALOPAY', name: 'ZaloPay', aliases: ['zalopay', 'zalo pay'] },
  { code: 'VTPAY', name: 'Viettel Money', aliases: ['viettel money', 'viettelpay', 'viettel pay'] },
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BANK_RES = BANKS.map((b) => ({
  bank: b,
  re: new RegExp(`(^|[^\\p{L}\\p{N}])(${b.aliases.map(escapeRe).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu'),
}));

export function findBank(text: string): BankHint | undefined {
  for (const { bank, re } of BANK_RES) if (re.test(text)) return { code: bank.code, name: bank.name };
  return undefined;
}

/** Vietnamese mobile prefixes after the leading 0 (Viettel, Vina, Mobi, Vietnamobile, Gmobile, Itel, Reddi…). */
const MOBILE = /^0(3[2-9]|5[2-9]|7[06-9]|8[1-9]|9\d)\d{7}$/;
const LANDLINE = /^02\d{9}$/;
const HOTLINE = /^(1800|1900)\d{4,6}$/;

/** `+84 912 345 678` → `0912345678`. Returns null when it isn't a Vietnamese phone number. */
export function normalizePhone(raw: string): string | null {
  const compact = raw.replace(/[\s.\-()]/g, '');
  if (!/^\+?\d+$/.test(compact)) return null;
  let digits = compact.replace(/^\+/, '');
  if (digits.startsWith('84') && (digits.length === 11 || digits.length === 12))
    digits = `0${digits.slice(2)}`;
  if (MOBILE.test(digits) || LANDLINE.test(digits) || HOTLINE.test(digits)) return digits;
  return null;
}

const TLD = '(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})';
const DOMAIN_RE = new RegExp(
  `^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+${TLD}(?::\\d{2,5})?(?:[/?#][^\\s]*)?$`,
  'i',
);
const EMAIL_RE = new RegExp(`^[^\\s@]+@(?:[a-z0-9-]+\\.)+${TLD}$`, 'i');

/** `shopee-vn.top/abc` → `https://shopee-vn.top/abc`. Null when it isn't a single link. */
export function normalizeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return u.hostname.includes('.') || u.hostname === 'localhost' ? u.toString() : null;
    } catch {
      return null;
    }
  }
  if (/^www\./i.test(s) || DOMAIN_RE.test(s)) {
    // "file.txt", "v1.2" and similar aren't links: require a letter-only TLD and no leading digit-dot-digit.
    if (/^\d+(\.\d+)+$/.test(s)) return null;
    try {
      return new URL(`https://${s}`).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Guess what the user pasted. Short single-token inputs are classified by
 * shape; anything with several words is a message (the API extracts links,
 * numbers and accounts from it).
 */
export function detectInput(raw: string): Detection {
  const s = raw.trim();
  if (!s) return { kind: 'empty', value: '', alternatives: [] };

  const words = s.split(/\s+/);
  const bank = findBank(s);

  // Email
  if (words.length === 1 && EMAIL_RE.test(s))
    return { kind: 'email', value: s.toLowerCase(), alternatives: ['text'] };

  // Link
  const url = normalizeUrl(s);
  if (url) return { kind: 'url', value: url, alternatives: ['text'] };

  // Numbers: phone and/or bank account. Allow a short label ("STK", "SĐT", bank name, account holder).
  const digitGroups = s.match(/\+?\d[\d\s.-]{4,}\d/g) ?? [];
  const nonDigitWords = s
    .replace(/\+?\d[\d\s.-]{4,}\d/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !/^[-–:,/|.]+$/.test(w));
  const looksLikeLabelOnly = nonDigitWords.length <= 6 && digitGroups.length === 1;
  if (looksLikeLabelOnly) {
    const group = digitGroups[0]!;
    const phone = normalizePhone(group);
    const digits = group.replace(/\D/g, '');
    const labelSaysPhone = /(sđt|sdt|số điện thoại|so dien thoai|phone|tel|hotline|gọi|zalo)/iu.test(s);
    const labelSaysAccount =
      /(stk|số tài khoản|so tai khoan|tài khoản|tai khoan|account|acc|ngân hàng|bank)/iu.test(s);
    const accountShaped = /^\d{6,19}$/.test(digits);

    if (phone && !bank && !labelSaysAccount) {
      return {
        kind: 'phone',
        value: phone,
        alternatives: accountShaped ? ['bank_account', 'text'] : ['text'],
      };
    }
    if (accountShaped && (bank || labelSaysAccount || !phone) && !labelSaysPhone) {
      return {
        kind: 'bank_account',
        value: digits,
        bank,
        alternatives: phone ? ['phone', 'text'] : ['text'],
      };
    }
    if (phone)
      return {
        kind: 'phone',
        value: phone,
        alternatives: accountShaped ? ['bank_account', 'text'] : ['text'],
      };
  }

  return { kind: 'text', value: s, bank, alternatives: [] };
}
