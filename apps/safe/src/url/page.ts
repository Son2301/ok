import { parse as parseDomain } from 'tldts';
import { fold } from '../lib/vn-text';
import { signal } from '../verdict/signal';
import type { Signal } from '../verdict/types';
import type { BrandRegistry } from './brand-match';
import type { Brand } from './brands';
import type { NormalizedUrl } from './normalize';

export interface PageInfo {
  title?: string;
  siteName?: string;
  forms: { action?: string; method?: string }[];
  sensitiveFields: string[];
  hasPassword: boolean;
  apkLinks: string[];
  telegramExfil: boolean;
  obfuscatedJs: boolean;
}

const SRC = 'page';

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
  )) {
    out[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? '').trim();
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

const SENSITIVE_NAME =
  /pass(word)?|passwd|mat_?khau|matkhau|\botp\b|otp|\bpin\b|cvv|cvc|card_?(number|no)|so_?the|sothe|cccd|cmnd|socmnd|expiry|exp_?date|ngay_?het_?han|tai_?khoan|username|login_?id|account_?(number|no)|stk/i;

/** Extract the bits of a landing page that matter for phishing detection (regex-based, bounded input). */
export function parsePage(html: string): PageInfo {
  const doc = html.slice(0, 600_000);
  const title =
    decodeEntities(doc.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '')
      .replace(/\s+/g, ' ')
      .trim() || undefined;
  let siteName: string | undefined;
  for (const m of doc.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if ((a.property === 'og:site_name' || a.name === 'application-name') && a.content)
      siteName = decodeEntities(a.content);
  }
  const forms = [...doc.matchAll(/<form\b[^>]*>/gi)].map((m) => {
    const a = attrs(m[0]);
    return { action: a.action, method: a.method };
  });
  const sensitive = new Set<string>();
  let hasPassword = false;
  for (const m of doc.matchAll(/<input\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const type = (a.type ?? 'text').toLowerCase();
    if (type === 'hidden' || type === 'submit' || type === 'button') continue;
    if (type === 'password') {
      hasPassword = true;
      sensitive.add('password');
    }
    const hay = `${a.name ?? ''} ${a.id ?? ''} ${a.placeholder ?? ''} ${a.autocomplete ?? ''}`;
    const foldedHay = fold(hay);
    if (SENSITIVE_NAME.test(hay) || /mat khau|ma otp|so the|ma pin|so tai khoan|can cuoc/.test(foldedHay)) {
      const label = (a.name || a.id || a.placeholder || type).slice(0, 40);
      sensitive.add(label);
    }
    if (a.autocomplete && /cc-number|cc-csc|one-time-code|current-password/.test(a.autocomplete))
      sensitive.add(a.autocomplete);
  }
  const apkLinks = [...doc.matchAll(/href\s*=\s*["']([^"']+\.apk(?:\?[^"']*)?)["']/gi)]
    .map((m) => m[1]!)
    .slice(0, 5);
  const telegramExfil = /api\.telegram\.org\/bot|\/sendMessage\?chat_id=|telegram\.org\/bot\d+/i.test(doc);
  const obfuscatedJs =
    /eval\s*\(\s*(atob|unescape|decodeURIComponent)\s*\(|document\.write\s*\(\s*unescape\s*\(|\\x[0-9a-f]{2}(\\x[0-9a-f]{2}){40,}/i.test(
      doc,
    );
  return {
    title,
    siteName,
    forms,
    sensitiveFields: [...sensitive].slice(0, 8),
    hasPassword,
    apkLinks,
    telegramExfil,
    obfuscatedJs,
  };
}

/** Signals about the landing page itself (only meaningful when it is not an official domain). */
export function analyzePage(
  page: PageInfo,
  final: NormalizedUrl,
  registry: BrandRegistry,
  official: Brand | null,
): Signal[] {
  const out: Signal[] = [];
  if (official && !official.userContent) return out;

  const titleText = `${page.title ?? ''} ${page.siteName ?? ''}`.trim();
  const claimed = titleText
    ? registry
        .mentionedIn(fold(titleText))
        .filter((b) => !b.domains.some((d) => final.host === d || final.host.endsWith(`.${d}`)))
    : [];
  const sensitiveBrand =
    claimed.find((b) =>
      ['bank', 'ewallet', 'government', 'payment', 'telco', 'logistics', 'ecommerce'].includes(b.category),
    ) ?? claimed[0];
  if (sensitiveBrand && !official) {
    out.push(
      signal(
        'page.brand_claim',
        sensitiveBrand.category === 'bank' || sensitiveBrand.category === 'government' ? 45 : 35,
        {
          vi: `Trang tự giới thiệu là ${sensitiveBrand.name} nhưng không nằm trên tên miền chính thức`,
          en: `The page presents itself as ${sensitiveBrand.name} but is not on an official domain`,
        },
        SRC,
        `Tiêu đề trang: "${titleText.slice(0, 120)}"`,
      ),
    );
  }

  if (page.sensitiveFields.length && !official) {
    out.push(
      signal(
        'page.credential_form',
        sensitiveBrand ? 55 : 40,
        {
          vi: 'Trang có ô yêu cầu nhập mật khẩu, mã OTP, số thẻ hoặc số giấy tờ',
          en: 'The page asks for a password, OTP, card number or ID number',
        },
        SRC,
        `Các ô nhập: ${page.sensitiveFields.join(', ')}`,
      ),
    );
    if (final.url.protocol === 'http:') {
      out.push(
        signal(
          'page.insecure_credentials',
          30,
          {
            vi: 'Trang đòi mật khẩu/OTP mà không có kết nối bảo mật HTTPS',
            en: 'The page asks for credentials without a secure HTTPS connection',
          },
          SRC,
        ),
      );
    }
  }

  const finalDomain = final.domain;
  for (const f of page.forms) {
    if (!f.action || !/^https?:\/\//i.test(f.action)) continue;
    const target = parseDomain(f.action).domain;
    if (target && finalDomain && target !== finalDomain && page.sensitiveFields.length) {
      out.push(
        signal(
          'page.form_offsite',
          35,
          {
            vi: 'Thông tin nhập vào bị gửi sang một tên miền khác',
            en: 'Form data is sent to a different domain',
          },
          SRC,
          `${f.action.slice(0, 120)}`,
        ),
      );
      break;
    }
  }

  if (page.telegramExfil) {
    out.push(
      signal(
        'page.telegram_exfil',
        60,
        {
          vi: 'Mã nguồn trang gửi dữ liệu về bot Telegram: dấu hiệu điển hình của bộ công cụ lừa đảo đánh cắp tài khoản',
          en: 'Page source sends data to a Telegram bot: a hallmark of phishing kits stealing credentials',
        },
        SRC,
      ),
    );
  }
  if (page.apkLinks.length) {
    out.push(
      signal(
        'page.apk_link',
        40,
        {
          vi: 'Trang mời tải file cài ứng dụng (.apk) ngoài CH Play',
          en: 'The page offers an app installer (.apk) outside Google Play',
        },
        SRC,
        page.apkLinks[0],
      ),
    );
  }
  if (page.obfuscatedJs) {
    out.push(
      signal(
        'page.obfuscated_js',
        15,
        {
          vi: 'Mã nguồn trang bị làm rối để che giấu hành vi',
          en: 'Page source is obfuscated to hide its behaviour',
        },
        SRC,
      ),
    );
  }
  return out;
}
