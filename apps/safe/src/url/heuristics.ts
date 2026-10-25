import { signal } from '../verdict/signal';
import type { Signal } from '../verdict/types';
import { type BrandHit, type BrandRegistry, detectBrandHits, isUserContentHost } from './brand-match';
import { type Brand, PHISHING_WORDS, SHORTENERS, SUSPICIOUS_TLDS, USER_CONTENT_HOSTS } from './brands';
import { isOnDomain, type NormalizedUrl } from './normalize';
import { scriptsIn } from './similarity';

const SRC = 'heuristics';
const BRAND_SRC = 'brand_impersonation';

export interface StaticAnalysis {
  signals: Signal[];
  official: Brand | null;
  governmentDomain: boolean;
  brandHits: BrandHit[];
  isShortener: boolean;
  userContentPlatform: string | null;
}

export function isShortener(host: string): boolean {
  return SHORTENERS.some((d) => isOnDomain(host, d));
}

/**
 * Offline, deterministic signals about a URL: who it claims to be versus where it really points.
 * `stage` = 'final' when analysing the landing URL after redirects (labels say so).
 */
export function analyzeUrlStatic(
  n: NormalizedUrl,
  registry: BrandRegistry,
  stage: 'input' | 'final' = 'input',
): StaticAnalysis {
  const out: Signal[] = [];
  const suffix =
    stage === 'final'
      ? { vi: ' (trang đích sau khi chuyển hướng)', en: ' (landing page after redirects)' }
      : { vi: '', en: '' };
  const id = (s: string) => (stage === 'final' ? `${s}.final` : s);
  const official = registry.officialFor(n.host);
  const governmentDomain = !n.isIp && (n.publicSuffix === 'gov.vn' || n.host.endsWith('.gov.vn'));
  const platform = USER_CONTENT_HOSTS.find((d) => isOnDomain(n.host, d)) ?? null;
  const shortener = isShortener(n.host);

  // ---- trust evidence
  if (official) {
    if (official.userContent) {
      out.push(
        signal(
          id('url.official_domain'),
          -35,
          {
            vi: `Tên miền thật của ${official.name}, nhưng nội dung trên trang do người dùng đăng tải nên vẫn cần cẩn thận${suffix.vi}`,
            en: `Real ${official.name} domain, but the page content is user-generated, so stay careful${suffix.en}`,
          },
          SRC,
          n.host,
        ),
      );
    } else {
      out.push(
        signal(
          id('url.official_domain'),
          -90,
          {
            vi: `Đây là tên miền chính thức của ${official.name}${suffix.vi}`,
            en: `This is an official ${official.name} domain${suffix.en}`,
          },
          SRC,
          n.host,
        ),
      );
    }
  } else if (governmentDomain) {
    // .gov.vn registration is restricted, but hacked government sites do host scam pages.
    out.push(
      signal(
        id('url.gov_domain'),
        -60,
        {
          vi: `Tên miền thuộc cơ quan nhà nước (.gov.vn)${suffix.vi}`,
          en: `Government domain (.gov.vn)${suffix.en}`,
        },
        SRC,
        n.host,
      ),
    );
  }

  // ---- brand impersonation
  const brandHits = official || governmentDomain ? [] : detectBrandHits(n, registry);
  for (const h of brandHits) out.push(brandSignal(h, n, platform, stage));

  // ---- fake government label on a non-.gov.vn domain ("dichvucong-gov.top", "gov-vn.com")
  if (!governmentDomain && !n.isIp && !official) {
    const labels = n.host.split('.');
    const tokens = labels.flatMap((l) => l.split('-'));
    const claimsGov =
      tokens.some((t) => t === 'gov' || t === 'govvn' || t === 'gove') || /gov\.vn\./.test(n.host);
    if (claimsGov) {
      out.push(
        signal(
          id('url.fake_gov'),
          45,
          {
            vi: `Tên miền gắn chữ "gov" để giả làm trang nhà nước nhưng không có đuôi .gov.vn${suffix.vi}`,
            en: `Domain uses "gov" to look official but is not under .gov.vn${suffix.en}`,
          },
          BRAND_SRC,
          n.host,
        ),
      );
    }
  }

  // ---- IDN / homoglyphs
  if (n.host.split('.').some((l) => l.startsWith('xn--'))) {
    const unicodeLabels = n.unicodeHost.split('.');
    const mixed = unicodeLabels.some((l) => {
      const s = scriptsIn(l);
      return s.size > 1 && s.has('latin');
    });
    const nonLatin = unicodeLabels.some((l) => {
      const s = scriptsIn(l);
      return s.size >= 1 && !s.has('latin');
    });
    if (mixed) {
      out.push(
        signal(
          id('url.mixed_script'),
          45,
          {
            vi: `Tên miền trộn chữ cái của nhiều bảng chữ (ví dụ chữ Nga lẫn chữ Latin) để trông giống tên quen thuộc${suffix.vi}`,
            en: `Domain mixes alphabets (e.g. Cyrillic and Latin) to imitate a familiar name${suffix.en}`,
          },
          BRAND_SRC,
          `${n.unicodeHost} (${n.host})`,
        ),
      );
    } else if (nonLatin) {
      out.push(
        signal(
          id('url.non_latin_idn'),
          15,
          {
            vi: `Tên miền dùng ký tự ngoài bảng chữ Latin${suffix.vi}`,
            en: `Domain uses non-Latin characters${suffix.en}`,
          },
          SRC,
          `${n.unicodeHost} (${n.host})`,
        ),
      );
    } else {
      out.push(
        signal(
          id('url.idn'),
          5,
          {
            vi: `Tên miền có dấu hoặc ký tự đặc biệt (dạng punycode)${suffix.vi}`,
            en: `Internationalized domain name (punycode)${suffix.en}`,
          },
          SRC,
          `${n.unicodeHost} (${n.host})`,
        ),
      );
    }
  }

  // ---- structural red flags
  if (n.isIp) {
    out.push(
      signal(
        id('url.ip_host'),
        35,
        {
          vi: `Link dùng dãy số IP thay vì tên miền${suffix.vi}`,
          en: `Link uses a raw IP address instead of a domain${suffix.en}`,
        },
        SRC,
        n.host,
      ),
    );
  }
  if (n.hadCredentials && stage === 'input') {
    out.push(
      signal(
        'url.userinfo',
        45,
        {
          vi: 'Link dùng ký tự @ để che địa chỉ thật: phần trước @ chỉ là trang trí',
          en: 'Link uses "@" to hide the real address: everything before "@" is decoration',
        },
        SRC,
        `"${n.hadCredentials}@" → thực ra mở ${n.host}`,
      ),
    );
  }
  const tld = n.publicSuffix?.split('.').pop() ?? '';
  if (!official && tld && SUSPICIOUS_TLDS.has(tld)) {
    out.push(
      signal(
        id('url.suspicious_tld'),
        15,
        {
          vi: `Đuôi tên miền .${tld} rẻ, hay bị dùng cho trang lừa đảo dùng một lần${suffix.vi}`,
          en: `The .${tld} ending is cheap and often used for throwaway scam sites${suffix.en}`,
        },
        SRC,
        n.host,
      ),
    );
  }
  const subLabels = n.subdomain ? n.subdomain.split('.').filter((l) => l !== 'www') : [];
  if (!official && subLabels.length >= 3) {
    out.push(
      signal(
        id('url.many_subdomains'),
        15,
        {
          vi: `Tên miền có quá nhiều tầng (${subLabels.length + 2} phần) để làm rối mắt${suffix.vi}`,
          en: `Unusually deep domain (${subLabels.length + 2} levels) designed to confuse${suffix.en}`,
        },
        SRC,
        n.host,
      ),
    );
  }
  const regLabel = n.domainName ?? '';
  if (!official && (regLabel.match(/-/g)?.length ?? 0) >= 3) {
    out.push(
      signal(
        id('url.many_hyphens'),
        10,
        {
          vi: `Tên miền có nhiều dấu gạch ngang${suffix.vi}`,
          en: `Domain contains many hyphens${suffix.en}`,
        },
        SRC,
        n.host,
      ),
    );
  }
  if (n.url.port && !['80', '443'].includes(n.url.port)) {
    out.push(
      signal(
        id('url.nonstandard_port'),
        10,
        {
          vi: `Link dùng cổng mạng lạ (:${n.url.port})${suffix.vi}`,
          en: `Link uses an unusual port (:${n.url.port})${suffix.en}`,
        },
        SRC,
        n.url.host,
      ),
    );
  }
  if (shortener && stage === 'input') {
    out.push(
      signal(
        'url.shortener',
        10,
        {
          vi: `Link rút gọn (${n.host}) che giấu địa chỉ thật`,
          en: `Shortened link (${n.host}) hides the real destination`,
        },
        SRC,
        n.host,
      ),
    );
  }
  if (platform && !brandHits.length) {
    out.push(
      signal(
        id('url.user_content_host'),
        10,
        {
          vi: `Trang được dựng trên dịch vụ mà ai cũng tạo được (${platform})${suffix.vi}`,
          en: `Page is hosted on a service anyone can publish to (${platform})${suffix.en}`,
        },
        SRC,
        n.host,
      ),
    );
  }

  // ---- file downloads (fake VNeID/tax/EVN apps are distributed as .apk)
  const path = n.url.pathname.toLowerCase();
  if (/\.apk$|\.xapk$|\.apks$/.test(path)) {
    out.push(
      signal(
        id('url.apk_download'),
        55,
        {
          vi: `Link tải thẳng file cài ứng dụng Android (.apk) ngoài CH Play: thủ đoạn cài phần mềm gián điệp để chiếm tài khoản ngân hàng${suffix.vi}`,
          en: `Direct Android app (.apk) download outside Google Play: a common way to install spyware that takes over bank accounts${suffix.en}`,
        },
        SRC,
        n.url.pathname,
      ),
    );
  } else if (/\.(exe|scr|msi|bat|cmd|vbs|js|jar|ps1|dmg|pkg|ipa)$/.test(path)) {
    out.push(
      signal(
        id('url.executable_download'),
        40,
        {
          vi: `Link tải thẳng file chương trình chạy được${suffix.vi}`,
          en: `Direct download of an executable file${suffix.en}`,
        },
        SRC,
        n.url.pathname,
      ),
    );
  }

  // ---- phishing words in path without any brand (weak)
  if (!official && !brandHits.length) {
    const flatPath = `${n.url.pathname}${n.url.search}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    const words = PHISHING_WORDS.filter((w) => w.length >= 5 && flatPath.includes(w));
    if (words.length >= 2) {
      out.push(
        signal(
          id('url.phishing_words'),
          8,
          {
            vi: `Đường dẫn chứa các từ hay gặp ở trang lừa đảo (${words.slice(0, 3).join(', ')})${suffix.vi}`,
            en: `Path contains words common on phishing pages (${words.slice(0, 3).join(', ')})${suffix.en}`,
          },
          SRC,
        ),
      );
    }
  }

  if (n.href.length > 200) {
    out.push(
      signal(
        id('url.very_long'),
        5,
        { vi: `Link dài bất thường${suffix.vi}`, en: `Unusually long link${suffix.en}` },
        SRC,
        `${n.href.length} ký tự`,
      ),
    );
  }

  return {
    signals: out,
    official,
    governmentDomain,
    brandHits,
    isShortener: shortener,
    userContentPlatform: platform ?? (isUserContentHost(n.host) ? n.host : null),
  };
}

function brandSignal(
  h: BrandHit,
  n: NormalizedUrl,
  platform: string | null,
  stage: 'input' | 'final',
): Signal {
  const b = h.brand;
  const officialList = b.domains.slice(0, 2).join(', ');
  const suffix =
    stage === 'final'
      ? { vi: ' (trang đích sau khi chuyển hướng)', en: ' (landing page after redirects)' }
      : { vi: '', en: '' };
  const phish = h.phishingWords.length > 0;
  const shortKeyword = b.keywords.find((k) => k.k === h.keyword)?.mode === 'token';
  const gov = b.category === 'government' || b.category === 'bank' ? 5 : 0;
  let weight: number;
  let label: { vi: string; en: string };
  const evidence = `${n.unicodeHost}${h.where === 'path' ? n.url.pathname : ''} — trang chính thức: ${officialList}`;

  if (h.where === 'domain') {
    if (h.how === 'homoglyph') {
      weight = 75;
      label = {
        vi: `Tên miền dùng ký tự trông giống hệt để giả mạo ${b.name}`,
        en: `Domain uses look-alike characters to impersonate ${b.name}`,
      };
    } else if (h.how === 'lookalike') {
      weight = phish ? 70 : 55;
      label = {
        vi: `Tên miền na ná ${b.name} ("${h.matched}" gần giống "${h.keyword}") nhưng không phải trang chính thức`,
        en: `Domain imitates ${b.name} ("${h.matched}" ≈ "${h.keyword}") but is not official`,
      };
    } else {
      weight = shortKeyword ? (phish ? 60 : 35) : phish ? 70 : 50;
      if (platform) weight = Math.max(weight, phish ? 70 : 55);
      // .vn registration requires identity documents; a bare brand word there (no "login", "otp"…)
      // is more often a related business than a throwaway phishing domain.
      else if (!phish && n.publicSuffix?.split('.').pop() === 'vn') weight -= 10;
      label = {
        vi: `Giả mạo ${b.name} (tên miền có chữ ${b.name} nhưng không phải trang chính thức)`,
        en: `Impersonates ${b.name} (the domain contains the brand name but is not an official site)`,
      };
    }
  } else if (h.where === 'subdomain') {
    weight = h.how === 'official_domain_in_subdomain' ? 70 : phish ? 60 : 50;
    label = {
      vi: `Gắn tên ${b.name} vào phần đầu tên miền để đánh lừa, trong khi tên miền thật là ${n.domain ?? n.host}`,
      en: `Puts ${b.name} at the start of the host to mislead; the real domain is ${n.domain ?? n.host}`,
    };
  } else {
    weight = platform ? 35 : phish ? 30 : 12;
    label = {
      vi: `Đường dẫn nhắc đến ${b.name} nhưng trang không thuộc ${b.name}`,
      en: `The link path mentions ${b.name} but the site does not belong to ${b.name}`,
    };
  }
  weight = Math.min(90, weight + (h.where === 'path' ? 0 : gov));
  return signal(
    stage === 'final' ? `url.brand_impersonation.final` : 'url.brand_impersonation',
    weight,
    { vi: label.vi + suffix.vi, en: label.en + suffix.en },
    BRAND_SRC,
    evidence,
  );
}
