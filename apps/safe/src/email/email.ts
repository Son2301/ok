import type { BrandRegistry } from '../url/brand-match';
import { analyzeUrlStatic } from '../url/heuristics';
import { normalizeUrl } from '../url/normalize';
import { signal } from '../verdict/signal';
import type { Signal } from '../verdict/types';

/** Common disposable / throwaway mailbox providers (curated subset; extend as needed). */
export const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'sharklasers.com',
  'grr.la',
  '10minutemail.com',
  '10minutemail.net',
  'temp-mail.org',
  'temp-mail.io',
  'tempmail.com',
  'tempmail.net',
  'tempmailo.com',
  'tempr.email',
  'yopmail.com',
  'yopmail.net',
  'trashmail.com',
  'trashmail.de',
  'getnada.com',
  'nada.email',
  'dispostable.com',
  'maildrop.cc',
  'mohmal.com',
  'throwawaymail.com',
  'fakeinbox.com',
  'emailondeck.com',
  'mintemail.com',
  'mailnesia.com',
  'discard.email',
  'spamgourmet.com',
  'moakt.com',
  'emailfake.com',
  '1secmail.com',
  '1secmail.org',
  '1secmail.net',
  'mailcatch.com',
  'mytemp.email',
  'tmpmail.org',
  'tmpmail.net',
  'burnermail.io',
  'inboxkitten.com',
  'mail.tm',
  'mailpoof.com',
  'spambox.us',
  'trash-mail.com',
  'getairmail.com',
  'fakemail.net',
  'emailtemporanea.com',
  'luxusmail.org',
  'mailforspam.com',
  'tempinbox.com',
  'mvrht.net',
  'harakirimail.com',
  'dropmail.me',
  'minuteinbox.com',
  'emltmp.com',
  'tmail.ws',
  'linshiyouxiang.net',
  'tempmail.plus',
  'mailto.plus',
  'fexpost.com',
  'fexbox.org',
]);

/** Free webmail: fine for individuals, never used by banks or government for official mail. */
export const FREEMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.com.vn',
  'hotmail.com',
  'outlook.com',
  'outlook.com.vn',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'mail.ru',
  'yandex.com',
  'gmx.com',
  'zoho.com',
  'qq.com',
  '163.com',
]);

export function parseEmail(raw: string): { email: string; local: string; domain: string } | null {
  const email = raw.trim().toLowerCase();
  const m = email.match(/^([^\s@]{1,64})@([a-z0-9.-]+\.[a-z]{2,24})$/);
  if (!m) return null;
  return { email, local: m[1]!, domain: m[2]! };
}

/** Offline signals about an email address (domain reputation, brand claims). */
export function emailSignals(
  local: string,
  domain: string,
  registry: BrandRegistry,
): { signals: Signal[]; officialBrand?: string } {
  const out: Signal[] = [];
  if (DISPOSABLE_DOMAINS.has(domain)) {
    out.push(
      signal(
        'email.disposable',
        35,
        {
          vi: 'Địa chỉ email dùng một lần (hộp thư tạm), thường dùng để lừa đảo rồi bỏ',
          en: 'Disposable (temporary) mailbox, often used for scams',
        },
        'heuristics',
        domain,
      ),
    );
  }
  let officialBrand: string | undefined;
  try {
    const n = normalizeUrl(`http://${domain}/`);
    const st = analyzeUrlStatic(n, registry);
    if (st.official && !FREEMAIL_DOMAINS.has(domain)) {
      officialBrand = st.official.name;
      out.push(
        signal(
          'email.official_domain',
          -50,
          {
            vi: `Email thuộc tên miền chính thức của ${st.official.name} (lưu ý: địa chỉ người gửi vẫn có thể bị giả mạo)`,
            en: `Email is on an official ${st.official.name} domain (note: sender addresses can still be spoofed)`,
          },
          'heuristics',
          domain,
        ),
      );
    } else if (st.governmentDomain) {
      out.push(
        signal(
          'email.gov_domain',
          -40,
          {
            vi: 'Email thuộc tên miền cơ quan nhà nước (.gov.vn)',
            en: 'Email is on a government domain (.gov.vn)',
          },
          'heuristics',
          domain,
        ),
      );
    }
    for (const s of st.signals) {
      if (
        ['url.brand_impersonation', 'url.mixed_script', 'url.fake_gov', 'url.suspicious_tld'].includes(s.id)
      ) {
        out.push({
          ...s,
          id: s.id.replace(/^url\./, 'email.'),
          label: { vi: `Tên miền email: ${lcFirst(s.label.vi)}`, en: `Email domain: ${lcFirst(s.label.en)}` },
        });
      }
    }
  } catch {
    // invalid domain already rejected by parseEmail
  }
  if (FREEMAIL_DOMAINS.has(domain)) {
    const flat = local.replace(/[^a-z0-9]/g, '');
    const claimed = registry
      .list()
      .filter((b) => ['bank', 'ewallet', 'government', 'payment', 'telco', 'logistics'].includes(b.category))
      .find((b) =>
        b.keywords.some((k) =>
          k.mode === 'token' ? local.split(/[._\-+]/).includes(k.k) : k.k.length >= 4 && flat.includes(k.k),
        ),
      );
    if (claimed) {
      out.push(
        signal(
          'email.freemail_brand',
          55,
          {
            vi: `Dùng hộp thư miễn phí (${domain}) nhưng tự xưng là ${claimed.name}: ngân hàng và cơ quan nhà nước không dùng email miễn phí`,
            en: `Free mailbox (${domain}) claiming to be ${claimed.name}: banks and agencies never use free email`,
          },
          'heuristics',
          `${local}@${domain}`,
        ),
      );
    }
  }
  return { signals: out, officialBrand };
}

function lcFirst(s: string) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
