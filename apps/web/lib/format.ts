/**
 * Display formatting. Pure and client-safe (no Node imports).
 *
 * Money is stored as integer micro-USD everywhere on the platform; the console
 * shows đồng first, converted at the wallet's published rate, and USD second.
 */

export type Locale = 'vi' | 'en';

export const MICRO = 1_000_000;
export const DEFAULT_VND_PER_USD = 26_000;
/** Everything is shown in Vietnam time, whatever the server's TZ. */
export const TIME_ZONE = 'Asia/Ho_Chi_Minh';

const intlLocale = (l: Locale) => (l === 'vi' ? 'vi-VN' : 'en-US');

export function microsToVnd(micros: number, rate = DEFAULT_VND_PER_USD): number {
  return (micros * rate) / MICRO;
}

export function vndToMicros(vnd: number, rate = DEFAULT_VND_PER_USD): number {
  return Math.floor((vnd * MICRO) / rate);
}

export function formatNumber(n: number, locale: Locale = 'vi', maxFractionDigits = 0): string {
  return new Intl.NumberFormat(intlLocale(locale), { maximumFractionDigits: maxFractionDigits }).format(n);
}

export interface VndOptions {
  /**
   * Keep fractions for tiny amounts (a single API call can cost 0,16đ). Balances
   * and top-ups are whole đồng; per-request costs are not, and rounding them to
   * "0đ" would hide the real price.
   */
  precise?: boolean;
  /** Prefix positive values with "+" (ledger credits). */
  signed?: boolean;
}

/** `200.000đ` (vi) or `₫200,000` (en). Input is an amount in đồng. */
export function formatVnd(vnd: number, locale: Locale = 'vi', opts: VndOptions = {}): string {
  const abs = Math.abs(vnd);
  let digits = 0;
  if (opts.precise && abs > 0) {
    if (abs < 1) digits = abs < 0.01 ? 4 : 2;
    else if (abs < 100) digits = 1;
  }
  const rounded = digits ? abs : Math.round(abs);
  const body = new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  }).format(rounded);
  const sign = vnd < 0 && rounded !== 0 ? '−' : opts.signed && vnd > 0 ? '+' : '';
  return locale === 'vi' ? `${sign}${body}đ` : `${sign}₫${body}`;
}

/** Micro-USD → đồng string at `rate` VND per USD. */
export function formatMicrosVnd(
  micros: number,
  rate = DEFAULT_VND_PER_USD,
  locale: Locale = 'vi',
  opts: VndOptions = {},
): string {
  return formatVnd(microsToVnd(micros, rate), locale, opts);
}

/** `$2.50`; tiny amounts keep enough digits to be meaningful (`$0.000150`). */
export function formatUsd(micros: number): string {
  const usd = micros / MICRO;
  const abs = Math.abs(usd);
  const digits = abs === 0 ? 2 : abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
  const body = abs.toFixed(digits).replace(/(\.\d{2}\d*?)0+$/, '$1');
  return `${usd < 0 ? '−' : ''}$${body}`;
}

/** Price per 1M tokens in USD → `$0.16` / `4.095đ`. */
export function formatPricePerMillion(usdPerMillion: number, rate: number, locale: Locale) {
  return {
    usd: `$${usdPerMillion < 1 ? usdPerMillion.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : usdPerMillion.toFixed(2)}`,
    vnd: formatVnd(usdPerMillion * rate, locale),
  };
}

/** Short money labels for preset buttons: `100k`, `1tr`, `2,5tr` (vi) / `100K`, `1M` (en). */
export function formatCompactVnd(vnd: number, locale: Locale = 'vi'): string {
  const sep = locale === 'vi' ? ',' : '.';
  const trim = (n: number) => {
    const s = (Math.round(n * 10) / 10).toString();
    return s.replace('.', sep);
  };
  if (vnd >= 1_000_000) return `${trim(vnd / 1_000_000)}${locale === 'vi' ? 'tr' : 'M'}`;
  if (vnd >= 1_000) return `${trim(vnd / 1_000)}${locale === 'vi' ? 'k' : 'K'}`;
  return String(vnd);
}

/**
 * Parse an amount typed by a Vietnamese user: `200000`, `200.000`, `200,000`,
 * `200k`, `1tr`, `1,5tr`, `1.5 triệu`, `2 củ` is not supported (slang). Returns
 * whole đồng, or null when it isn't a number.
 */
export function parseVndInput(raw: string): number | null {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/(đ|₫|vnd|dong|đồng)$/u, '');
  if (!s) return null;
  const m = s.match(/^(\d+(?:[.,]\d+)*)(k|nghìn|ngàn|tr|triệu|trieu|m)?$/u);
  if (!m) return null;
  const [, num = '', unit] = m;
  let value: number;
  if (unit) {
    // With a unit, a single separator is a decimal point: "1,5tr" = 1.500.000.
    const parts = num.split(/[.,]/);
    value = parts.length === 2 ? Number(`${parts[0]}.${parts[1]}`) : Number(parts.join(''));
    const mult = unit === 'k' || unit === 'nghìn' || unit === 'ngàn' ? 1_000 : 1_000_000;
    value *= mult;
  } else {
    // Without a unit, separators are thousands separators: "200.000" = 200000.
    if (/[.,]\d{1,2}$/.test(num)) return null; // "200,5đ" — fractions of a đồng make no sense
    value = Number(num.replace(/[.,]/g, ''));
  }
  if (!Number.isFinite(value)) return null;
  return Math.round(value);
}

/** `1.234` tokens, `12,3k`, `4,5M`. */
export function formatTokens(n: number, locale: Locale = 'vi'): string {
  if (n < 10_000) return formatNumber(n, locale);
  const f = (v: number) => formatNumber(v, locale, 1);
  if (n < 1_000_000) return `${f(n / 1_000)}k`;
  return `${f(n / 1_000_000)}M`;
}

export function formatPercent(ratio: number, locale: Locale = 'vi', digits = 0): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: 'percent',
    maximumFractionDigits: digits,
  }).format(ratio);
}

/** `850 ms`, `2,1 s`, `1 phút 5 giây` / `1m 5s`. */
export function formatDuration(ms: number | null | undefined, locale: Locale = 'vi'): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${formatNumber(ms / 1000, locale, 1)} s`;
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (locale === 'vi') return sec ? `${min} phút ${sec} giây` : `${min} phút`;
  return sec ? `${min}m ${sec}s` : `${min}m`;
}

const toDate = (d: Date | string | number) => (d instanceof Date ? d : new Date(d));

/** `25/10/2026` (vi) / `Oct 25, 2026` (en), in Vietnam time. */
export function formatDate(d: Date | string | number, locale: Locale = 'vi'): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: locale === 'vi' ? '2-digit' : 'short',
    year: 'numeric',
  }).format(toDate(d));
}

/** `14:03 25/10/2026` (vi) / `Oct 25, 2026, 2:03 PM` (en), in Vietnam time. */
export function formatDateTime(d: Date | string | number, locale: Locale = 'vi'): string {
  const date = toDate(d);
  if (locale === 'vi') {
    const time = new Intl.DateTimeFormat('vi-VN', {
      timeZone: TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date);
    return `${time} ${formatDate(date, 'vi')}`;
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** `3 phút trước` / `3 minutes ago`. Falls back to the date after a week. */
export function formatRelative(d: Date | string | number, locale: Locale = 'vi', now = Date.now()): string {
  const date = toDate(d);
  const diffSec = Math.round((date.getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return locale === 'vi' ? 'vừa xong' : 'just now';
  const rtf = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: 'auto' });
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 7 * 86_400) return rtf.format(Math.round(diffSec / 86_400), 'day');
  return formatDate(date, locale);
}

/** UTC day key `YYYY-MM-DD` → `25/10` (vi) / `Oct 25` (en) for chart axes. */
export function formatDayKey(key: string, locale: Locale = 'vi'): string {
  const [y, m, d] = key.split('-').map(Number);
  if (!y || !m || !d) return key;
  if (locale === 'vi') return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

/** Mask the middle of a secret-ish identifier: `sk-minh-ab12…` stays as is, account numbers become `0123••••89`. */
export function maskMiddle(value: string, keepStart = 4, keepEnd = 2): string {
  if (value.length <= keepStart + keepEnd) return value;
  return `${value.slice(0, keepStart)}${'•'.repeat(Math.min(6, value.length - keepStart - keepEnd))}${value.slice(-keepEnd)}`;
}
