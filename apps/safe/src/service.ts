import { createHash } from 'node:crypto';
import type { LlmClient } from '@minh/llm';
import { AppError, type Logger } from '@minh/shared';
import { judgeAiText, MIN_CHARS, styleFeatures, styleSignals } from './aitext/ai-text';
import { findBank, normalizeAccountNumber } from './bank/banks';
import { emailSignals, parseEmail } from './email/email';
import type { SafeEnv } from './env';
import { fold } from './lib/vn-text';
import { analyzeWithLlm } from './llm/scam-analysis';
import type { MediaKind } from './media/containers';
import type { MediaDetector } from './media/detectors';
import { analyzeMedia } from './media/forensics';
import type { Resolver, SafeFetcher } from './net/safe-fetch';
import { HIGH_RISK_CALLING_CODES, KNOWN_SHORT_CODES, parsePhone } from './phone/phone';
import type { ReportService } from './reports/service';
import { urlReportKey } from './reports/service';
import { runRules } from './rules/engine';
import type { FeedStore } from './sources/feeds';
import { checkRdap, checkSafeBrowsing, checkUrlhaus, checkVirusTotal } from './sources/url-reputation';
import type { VerdictCache } from './store/cache';
import { extractEntities } from './text/entities';
import type { BrandRegistry } from './url/brand-match';
import { analyzeUrlStatic } from './url/heuristics';
import { type NormalizedUrl, normalizeUrl } from './url/normalize';
import { analyzePage, parsePage } from './url/page';
import { defang, VerdictBuilder } from './verdict/builder';
import { type FetchLike, type SourceResult, signal } from './verdict/signal';
import type { Localized, Signal, Verdict } from './verdict/types';

export interface SafeServiceDeps {
  env: SafeEnv;
  registry: BrandRegistry;
  fetcher: SafeFetcher;
  resolver: Resolver;
  fetch: FetchLike;
  reports: ReportService;
  feeds: FeedStore;
  cache: VerdictCache;
  /** LLM client billed to `orgId` (gateway x-org-id); null when the gateway or org is not configured. */
  llmFor: (orgId: string | null) => LlmClient | null;
  detectors: MediaDetector[];
  now: () => Date;
  logger: Logger;
}

export interface CheckContext {
  llmOrgId: string | null;
  /** 0 for a direct check; >0 when checking entities found inside a message. */
  depth?: number;
  useCache?: boolean;
}

const MAX_TEXT_CHARS = 10_000;
const SENSITIVE_CATEGORIES = new Set(['bank', 'ewallet', 'government', 'payment', 'telco', 'logistics']);

const DETECTOR_KEYS: Record<string, string> = {
  hive: 'HIVE_API_KEY',
  sightengine: 'SIGHTENGINE_API_USER / SIGHTENGINE_API_SECRET',
  reality_defender: 'REALITY_DEFENDER_API_KEY',
};
const DETECTOR_NAMES: Record<string, string> = {
  hive: 'Hive',
  sightengine: 'Sightengine',
  reality_defender: 'Reality Defender',
};

function applySource(b: VerdictBuilder, r: SourceResult) {
  b.source(r.name, r.status, r.detail);
  b.add(...r.signals);
}

export class SafeService {
  constructor(private readonly d: SafeServiceDeps) {}

  private llmSkipReason(orgId: string | null): string {
    if (!this.d.env.GATEWAY_URL) return 'LLM gateway not configured (GATEWAY_URL)';
    if (!orgId) return 'No org to bill LLM usage to (set SAFE_PLATFORM_ORG_ID for free checks)';
    return 'LLM unavailable';
  }

  // =================================================================== URL

  async checkUrl(raw: string, ctx: CheckContext): Promise<Verdict> {
    const n = normalizeUrl(raw);
    if (ctx.useCache !== false) {
      const hit = await this.d.cache.get('url', n.href).catch(() => null);
      if (hit) return { ...hit, cached: true };
    }
    const { env, registry, fetch } = this.d;
    const b = new VerdictBuilder('url', n.href);
    b.details.host = n.unicodeHost;
    if (n.domain) b.details.domain = n.domain;
    if (n.refanged) b.details.refanged = true;

    const stat = analyzeUrlStatic(n, registry, 'input');
    b.add(...stat.signals);
    b.source('heuristics', 'ok');
    let official = stat.official;
    if (official) b.details.officialBrand = official.name;

    const [fetchRes, rdap, gsb, vt, urlhaus, feed, reports] = await Promise.all([
      env.SAFE_FETCH_ENABLED
        ? this.d.fetcher.fetch(n.href, {
            timeoutMs: env.SAFE_FETCH_TIMEOUT_MS,
            maxBytes: env.SAFE_FETCH_MAX_BYTES,
            maxRedirects: env.SAFE_FETCH_MAX_REDIRECTS,
          })
        : Promise.resolve(null),
      n.domain && env.SAFE_RDAP_ENABLED && !official
        ? checkRdap(n.domain, fetch, { baseUrl: env.SAFE_RDAP_BASE_URL, now: this.d.now() })
        : Promise.resolve<SourceResult>({
            name: 'rdap',
            status: 'skipped',
            detail: official ? 'Official domain' : n.isIp ? 'IP address' : 'RDAP disabled',
            signals: [],
          }),
      checkSafeBrowsing(n.href, env.GOOGLE_SAFE_BROWSING_API_KEY, fetch),
      checkVirusTotal(n.href, env.VIRUSTOTAL_API_KEY, fetch),
      checkUrlhaus(n.href, env.URLHAUS_AUTH_KEY, fetch),
      this.d.feeds.lookup(n),
      this.d.reports.lookupSignal('url', urlReportKey(n, registry)).catch((err) => ({ error: err as Error })),
    ]);

    // ---- landing page
    let finalN: NormalizedUrl = n;
    if (!fetchRes) {
      b.source('page_fetch', 'skipped', 'SAFE_FETCH_ENABLED=false');
    } else {
      b.details.redirectChain = fetchRes.chain.map((h) => ({ url: h.url, status: h.status, via: h.next }));
      if (fetchRes.chain.length > 1 || fetchRes.finalUrl !== n.href) {
        try {
          finalN = normalizeUrl(fetchRes.finalUrl);
        } catch {
          finalN = n;
        }
      }
      b.details.finalUrl = finalN.href;
      if (finalN.host !== n.host) {
        const fstat = analyzeUrlStatic(finalN, registry, 'final');
        b.add(...fstat.signals);
        official = fstat.official;
        b.details.officialBrand = official?.name;
        if (stat.isShortener) {
          b.add(
            signal(
              'url.shortener',
              5,
              {
                vi: `Link rút gọn (${n.host}) dẫn tới ${finalN.unicodeHost}`,
                en: `Shortened link (${n.host}) leads to ${finalN.unicodeHost}`,
              },
              'heuristics',
              n.host,
            ),
          );
        }
      }
      if (fetchRes.ok) {
        b.source('page_fetch', 'ok', `HTTP ${fetchRes.status}${fetchRes.truncated ? ' (truncated)' : ''}`);
        const ct = fetchRes.contentType ?? '';
        if (fetchRes.body && (!ct || /html|xml|text\/plain/i.test(ct))) {
          const page = parsePage(new TextDecoder('utf-8', { fatal: false }).decode(fetchRes.body));
          b.details.page = {
            title: page.title,
            sensitiveFields: page.sensitiveFields,
            forms: page.forms.length,
            apkLinks: page.apkLinks.length,
          };
          b.add(...analyzePage(page, finalN, registry, official));
        } else if (/android\.package-archive/i.test(ct)) {
          b.add(
            signal(
              'url.apk_download',
              55,
              {
                vi: 'Link tải về file cài ứng dụng Android (.apk) ngoài CH Play',
                en: 'Link downloads an Android app (.apk) outside Google Play',
              },
              'page',
              ct,
            ),
          );
        }
        if (fetchRes.tls) {
          b.details.tls = fetchRes.tls;
          const issued = fetchRes.tls.validFrom ? Date.parse(fetchRes.tls.validFrom) : Number.NaN;
          const certAgeDays = (this.d.now().getTime() - issued) / 86_400_000;
          if (!official && Number.isFinite(certAgeDays) && certAgeDays >= 0 && certAgeDays < 3) {
            b.add(
              signal(
                'url.new_certificate',
                8,
                {
                  vi: 'Chứng chỉ HTTPS vừa được cấp trong 3 ngày qua',
                  en: 'HTTPS certificate was issued in the last 3 days',
                },
                'page',
                `${fetchRes.tls.issuer ?? ''} · ${fetchRes.tls.validFrom}`,
              ),
            );
          }
        }
        if (finalN.url.protocol === 'http:' && !official) {
          b.add(
            signal(
              'url.no_https',
              8,
              { vi: 'Trang không dùng kết nối bảo mật HTTPS', en: 'The page does not use HTTPS' },
              'page',
            ),
          );
        }
      } else if (fetchRes.error) {
        const e = fetchRes.error;
        if (e.code === 'tls_error') {
          b.source('page_fetch', 'error', e.message);
          b.add(
            signal(
              'url.tls_invalid',
              30,
              {
                vi: 'Chứng chỉ bảo mật HTTPS của trang không hợp lệ',
                en: 'The site’s HTTPS certificate is invalid',
              },
              'page',
              e.message,
            ),
          );
        } else if (
          e.code === 'blocked_ip' ||
          e.code === 'blocked_host' ||
          e.code === 'blocked_port' ||
          e.code === 'blocked_scheme'
        ) {
          b.source('page_fetch', 'skipped', `Not fetched for safety: ${e.message}`);
          if (e.code === 'blocked_ip' || e.code === 'blocked_host') {
            b.add(
              signal(
                'url.private_target',
                20,
                {
                  vi: 'Link trỏ tới địa chỉ mạng nội bộ hoặc không công khai',
                  en: 'Link points to a private or non-public network address',
                },
                'page',
                e.message,
              ),
            );
          }
        } else if (e.code === 'too_many_redirects') {
          b.source('page_fetch', 'error', e.message);
          b.add(
            signal(
              'url.redirect_chain',
              20,
              {
                vi: 'Link chuyển hướng quá nhiều lần để che giấu đích đến',
                en: 'Link redirects too many times to hide its destination',
              },
              'page',
            ),
          );
        } else {
          b.source('page_fetch', 'error', e.message);
        }
      }
    }

    applySource(b, rdap);
    if (rdap.data) b.details.domainAge = rdap.data;

    // Reputation: also look up the landing URL when it differs.
    let gsbFinal = gsb;
    let feedFinal = feed;
    if (finalN.href !== n.href) {
      [gsbFinal, feedFinal] = await Promise.all([
        env.GOOGLE_SAFE_BROWSING_API_KEY
          ? checkSafeBrowsing([n.href, finalN.href], env.GOOGLE_SAFE_BROWSING_API_KEY, fetch)
          : Promise.resolve(gsb),
        feed.signals.length ? Promise.resolve(feed) : this.d.feeds.lookup(finalN),
      ]);
    }
    for (const r of [gsbFinal, vt, urlhaus, feedFinal]) applySource(b, r);
    if ('error' in reports) b.source('community_reports', 'error', reports.error.message);
    else {
      b.source('community_reports', 'ok');
      b.add(reports.signal);
      if (reports.summary.total)
        b.details.reports = { total: reports.summary.total, verified: reports.summary.verified };
    }

    // A hard reputation hit beats "official domain" (hacked sites, abused subdomains).
    const hardHit =
      b.signals.some(
        (s) => ['google_safe_browsing', 'urlhaus', 'phishing_feeds'].includes(s.source) && s.weight >= 45,
      ) || b.signals.some((s) => s.source === 'virustotal' && s.weight >= 45);
    if (hardHit) {
      for (const s of b.signals) {
        if (s.weight < 0 && s.source === 'heuristics') s.weight = 0;
      }
    }

    const ok = b.sources.filter(
      (s) => s.status === 'ok' && !['heuristics', 'community_reports'].includes(s.name),
    ).length;
    const verdict = b.build({ checkedAt: this.d.now(), limitedData: ok === 0 });
    if (ctx.useCache !== false)
      await this.d.cache.set('url', n.href, verdict, urlReportKey(n, registry)).catch(() => {});
    return verdict;
  }

  // ================================================================== TEXT

  async checkText(
    input: { text: string; channel?: string; sender?: string },
    ctx: CheckContext,
  ): Promise<Verdict> {
    const text = input.text.normalize('NFC').trim();
    if (!text) throw new AppError('bad_request', 'Text is empty', { vi: 'Bạn chưa nhập nội dung tin nhắn' });
    if (text.length > MAX_TEXT_CHARS)
      throw new AppError('bad_request', `Text is longer than ${MAX_TEXT_CHARS} characters`);
    const b = new VerdictBuilder('text', text);
    const ents = extractEntities(text);
    const hasMobile = ents.phones.some((p) => p.type === 'mobile' || p.type === 'foreign');
    const rules = runRules(text, {
      hasUrl: ents.urls.length > 0,
      hasMobile,
      hasBank: ents.bankAccounts.length > 0,
    });
    b.add(...rules.signals);
    b.source('rules', 'ok');
    b.entities = {
      urls: ents.urls,
      phones: ents.phones.map((p) => p.e164),
      bankAccounts: ents.bankAccounts,
      emails: ents.emails,
    };

    // ---- check every entity (bounded)
    const sub: CheckContext = { ...ctx, depth: (ctx.depth ?? 0) + 1 };
    const settle = <T>(p: Promise<T>) =>
      p.then(
        (v) => ({ v }),
        (e: Error) => ({ e }),
      );
    const [urlV, phoneV, bankV, emailV] = await Promise.all([
      Promise.all(ents.urls.slice(0, 3).map((u) => settle(this.checkUrl(u, sub)))),
      Promise.all(ents.phones.slice(0, 3).map((p) => settle(this.checkPhone(p.e164, sub)))),
      Promise.all(
        ents.bankAccounts
          .slice(0, 3)
          .map((a) =>
            settle(this.checkBankAccount({ accountNumber: a.accountNumber, bankName: a.bankName }, sub)),
          ),
      ),
      Promise.all(ents.emails.slice(0, 3).map((e) => settle(this.checkEmail(e, sub)))),
    ]);
    const entityChecks: { type: string; value: string; score: number; level: string; reason?: string }[] = [];
    const entityLabels: Record<string, Localized> = {
      url: {
        vi: 'Đường link trong tin nhắn có dấu hiệu nguy hiểm',
        en: 'A link in the message looks dangerous',
      },
      phone: {
        vi: 'Số điện thoại trong tin nhắn từng bị báo cáo lừa đảo',
        en: 'A phone number in the message has scam reports',
      },
      bank_account: {
        vi: 'Số tài khoản trong tin nhắn từng bị báo cáo lừa đảo',
        en: 'A bank account in the message has scam reports',
      },
      email: {
        vi: 'Địa chỉ email trong tin nhắn có dấu hiệu giả mạo',
        en: 'An email address in the message looks fake',
      },
    };
    let entityErrors = 0;
    for (const [type, list] of [
      ['url', urlV],
      ['phone', phoneV],
      ['bank_account', bankV],
      ['email', emailV],
    ] as const) {
      for (const r of list) {
        if ('e' in r) {
          entityErrors++;
          continue;
        }
        const v = r.v;
        const top = v.signals.find((s) => s.weight > 0);
        entityChecks.push({ type, value: v.input, score: v.score, level: v.level, reason: top?.label.vi });
        if (v.score >= 20) {
          const shown = type === 'url' ? defang(v.input) : v.input;
          b.add(
            signal(
              `text.entity.${type}`,
              Math.round(v.score * 0.9),
              entityLabels[type]!,
              'entities',
              `${shown}: ${top?.label.vi ?? ''} (${v.score}/100)`,
            ),
          );
        }
      }
    }
    b.source(
      'entity_checks',
      entityErrors ? 'error' : 'ok',
      entityErrors ? `${entityErrors} entity check(s) failed` : undefined,
    );

    // ---- brand claimed in text vs links that are not the brand's
    const folded = rules.normalized.text;
    const mentioned = this.d.registry
      .mentionedIn(folded)
      .filter((br) => SENSITIVE_CATEGORIES.has(br.category));
    const senderBrand = input.sender
      ? this.d.registry.mentionedIn(fold(input.sender)).find((br) => SENSITIVE_CATEGORIES.has(br.category))
      : undefined;
    for (const brand of senderBrand ? [senderBrand, ...mentioned] : mentioned) {
      const foreignLink = ents.urls.find((u) => {
        try {
          const host = new URL(u).hostname;
          return !brand.domains.some((d) => host === d || host.endsWith(`.${d}`));
        } catch {
          return false;
        }
      });
      if (foreignLink) {
        b.add(
          senderBrand === brand
            ? signal(
                'text.brandname_link',
                40,
                {
                  vi: `Tin nhắn mang tên ${brand.name} nhưng chứa link không thuộc ${brand.name}. Tin nhắn thương hiệu vẫn có thể bị giả mạo bằng trạm phát sóng giả`,
                  en: `Message sent as ${brand.name} contains a link that is not ${brand.name}'s. Branded SMS can be spoofed with fake base stations`,
                },
                'rules',
                defang(foreignLink),
              )
            : signal(
                'text.brand_link_mismatch',
                35,
                {
                  vi: `Tin nhắn nhắc tới ${brand.name} nhưng đường link không thuộc trang chính thức của ${brand.name}`,
                  en: `Message mentions ${brand.name} but the link is not an official ${brand.name} site`,
                },
                'rules',
                defang(foreignLink),
              ),
        );
        break;
      }
    }

    // ---- sender
    if (input.sender) {
      const sp = parsePhone(input.sender);
      if (sp) {
        const pv = await this.checkPhone(sp.e164, sub).catch(() => null);
        if (pv && pv.score >= 20) {
          const top = pv.signals.find((s) => s.weight > 0);
          b.add(
            signal(
              'text.sender',
              Math.round(pv.score * 0.9),
              {
                vi: `Người gửi: ${top?.label.vi ?? 'số điện thoại đáng ngờ'}`,
                en: `Sender: ${top?.label.en ?? 'suspicious number'}`,
              },
              'entities',
              sp.e164,
            ),
          );
        }
        b.details.sender = { e164: sp.e164, type: sp.type, carrier: sp.carrier, country: sp.countryName };
      }
    }

    // ---- LLM: independent opinion, bounded contribution
    const base = b.score().score;
    const llm = this.d.llmFor(ctx.llmOrgId);
    const llmRes = await analyzeWithLlm(llm, text, base, {
      model: this.d.env.SAFE_LLM_MODEL,
      channel: input.channel,
      timeoutMs: this.d.env.SAFE_LLM_TIMEOUT_MS,
      skipReason: this.llmSkipReason(ctx.llmOrgId),
    });
    b.source(llmRes.status.name, llmRes.status.status, llmRes.status.detail);
    b.add(...llmRes.signals);

    // ---- what the scammer wants / what to do instead
    for (const a of rules.advice) b.recommend(a.vi, a.en);
    if (llmRes.status.status === 'ok') for (const a of llmRes.advice.slice(0, 2)) b.recommend(a.vi, a.en);
    const scammerGoal = rules.scammerGoal ?? llmRes.scammerGoal;
    b.details.scamType =
      rules.primary?.id ??
      (llmRes.analysis && llmRes.analysis.scam_type !== 'none' ? llmRes.analysis.scam_type : null);
    b.details.category = rules.primary?.category ?? null;
    b.details.matchedRules = rules.hits.map((h) => h.rule.id);
    b.details.tactics = [...new Set([...rules.tactics, ...(llmRes.analysis?.tactics ?? [])])];
    if (scammerGoal) b.details.scammerGoal = scammerGoal;
    if (rules.policeWarned.length) b.details.policeWarnedScripts = rules.policeWarned;
    if (entityChecks.length) b.details.entityChecks = entityChecks;
    if (llmRes.analysis) {
      b.details.llm = {
        scamType: llmRes.analysis.scam_type,
        probability: llmRes.analysis.scam_probability,
        confidence: llmRes.analysis.confidence,
        appliedDelta: llmRes.appliedDelta,
      };
    }
    if (input.channel) b.details.channel = input.channel;

    const notes: Localized[] = [];
    const prelim = b.score().score;
    if (rules.policeWarned.length && prelim >= 25) {
      notes.push({
        vi: `Giống kịch bản đã được công an cảnh báo: ${rules.policeWarned[0]!.vi}.`,
        en: `Matches a scam script publicly warned about by police: ${rules.policeWarned[0]!.en}.`,
      });
    }
    return b.build({ checkedAt: this.d.now(), summaryNotes: notes, limitedData: false });
  }

  // ================================================================= PHONE

  async checkPhone(raw: string, _ctx: CheckContext): Promise<Verdict> {
    const p = parsePhone(raw);
    if (!p)
      throw new AppError('bad_request', 'Invalid phone number', {
        vi: 'Số điện thoại không hợp lệ. Hãy nhập dạng 09xx xxx xxx hoặc +84 9xx xxx xxx',
      });
    const b = new VerdictBuilder('phone', p.e164);
    b.details.e164 = p.e164;
    if (p.national) b.details.national = p.national;
    b.details.type = p.type;
    b.details.country = p.country;
    if (p.countryName) b.details.countryName = p.countryName;
    if (p.carrier) b.details.carrier = p.carrier;
    if (p.area) b.details.area = p.area;
    b.source('number_format', 'ok');

    switch (p.type) {
      case 'mobile':
        b.details.portabilityNote = {
          vi: 'Nhà mạng theo đầu số gốc; số có thể đã chuyển mạng giữ số.',
          en: 'Carrier by original prefix; the number may have been ported.',
        };
        b.add(
          signal(
            'phone.carrier',
            0,
            {
              vi: `Số di động ${p.carrier} (theo đầu số gốc)`,
              en: `${p.carrier} mobile number (by original prefix)`,
            },
            'number_format',
            p.national,
          ),
        );
        break;
      case 'landline':
        b.add(
          signal(
            'phone.landline',
            0,
            { vi: `Số cố định khu vực ${p.area}`, en: `Landline in ${p.area}` },
            'number_format',
            p.national,
          ),
        );
        break;
      case 'premium':
        b.add(
          signal(
            'phone.premium',
            0,
            {
              vi: 'Đầu số 1900 là tổng đài tính phí cao; hãy cẩn thận nếu bị dụ gọi lại để "nhận thưởng"',
              en: '1900 numbers are premium-rate; be careful if urged to call back to "claim a prize"',
            },
            'number_format',
            p.e164,
          ),
        );
        break;
      case 'toll_free':
        b.add(
          signal(
            'phone.toll_free',
            0,
            { vi: 'Đầu số 1800 là tổng đài miễn phí', en: '1800 numbers are toll-free hotlines' },
            'number_format',
            p.e164,
          ),
        );
        break;
      case 'short_code':
        b.add(
          signal(
            'phone.short_code',
            0,
            {
              vi: `Đầu số ngắn${KNOWN_SHORT_CODES[p.e164] ? `: ${KNOWN_SHORT_CODES[p.e164]}` : ''}`,
              en: 'Short code',
            },
            'number_format',
            p.e164,
          ),
        );
        break;
      case 'foreign': {
        const risky = HIGH_RISK_CALLING_CODES.has(p.country);
        b.add(
          signal(
            'phone.foreign',
            risky ? 30 : 20,
            {
              vi: `Số nước ngoài${p.countryName ? ` (${p.countryName})` : ''}: kẻ gian hay gọi từ số nước ngoài để giả danh cơ quan, ngân hàng trong nước${risky ? '; nhiều đường dây lừa người Việt hoạt động từ khu vực này' : ''}`,
              en: `Foreign number${p.countryName ? ` (${p.countryName})` : ''}: scammers often call from abroad posing as local agencies or banks${risky ? '; many scam rings targeting Vietnamese people operate from this region' : ''}`,
            },
            'number_format',
            p.e164,
          ),
        );
        break;
      }
    }
    await this.addReports(b, 'phone', p.e164);
    return b.build({ checkedAt: this.d.now() });
  }

  // ========================================================== BANK ACCOUNT

  async checkBankAccount(
    input: { accountNumber: string; bankName?: string },
    _ctx: CheckContext,
  ): Promise<Verdict> {
    const acc = normalizeAccountNumber(input.accountNumber);
    if (!acc)
      throw new AppError('bad_request', 'Invalid bank account number (6–19 digits)', {
        vi: 'Số tài khoản không hợp lệ (6–19 chữ số)',
      });
    const bank = findBank(input.bankName);
    const b = new VerdictBuilder('bank_account', acc);
    b.details.accountNumber = acc;
    if (bank) {
      b.details.bankCode = bank.code;
      b.details.bankName = bank.name;
    }
    const asPhone = parsePhone(acc);
    if (asPhone?.type === 'mobile') b.details.looksLikePhoneNumber = true;
    b.source(
      'bank_lookup',
      'skipped',
      'No access to bank, NAPAS or SIMO systems: account holders are not verified; only community reports are checked',
    );
    await this.addReports(b, 'bank_account', acc);
    return b.build({ checkedAt: this.d.now(), limitedData: false });
  }

  // ================================================================= EMAIL

  async checkEmail(raw: string, _ctx: CheckContext): Promise<Verdict> {
    const e = parseEmail(raw);
    if (!e) throw new AppError('bad_request', 'Invalid email address', { vi: 'Địa chỉ email không hợp lệ' });
    const b = new VerdictBuilder('email', e.email);
    b.details.domain = e.domain;
    b.source('email_syntax', 'ok');
    const es = emailSignals(e.local, e.domain, this.d.registry);
    b.add(...es.signals);
    b.source('heuristics', 'ok');
    if (es.officialBrand) b.details.officialBrand = es.officialBrand;
    try {
      const mx = await Promise.race([
        this.d.resolver.resolveMx(e.domain),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('MX lookup timed out')), 3_000)),
      ]);
      b.details.mx = mx.slice(0, 5).map((m) => m.exchange);
      b.source('mx', 'ok');
      if (!mx.length)
        b.add(
          signal(
            'email.no_mx',
            25,
            {
              vi: 'Tên miền email không có máy chủ nhận thư (MX)',
              en: 'Email domain has no mail servers (MX)',
            },
            'mx',
            e.domain,
          ),
        );
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') {
        b.source('mx', 'ok', code);
        b.add(
          signal(
            'email.no_mx',
            25,
            {
              vi: 'Tên miền email không tồn tại hoặc không nhận được thư',
              en: 'Email domain does not exist or cannot receive mail',
            },
            'mx',
            e.domain,
          ),
        );
      } else {
        b.source('mx', 'error', (err as Error).message);
      }
    }
    await this.addReports(b, 'email', e.email);
    return b.build({ checkedAt: this.d.now() });
  }

  private async addReports(b: VerdictBuilder, type: 'phone' | 'bank_account' | 'email', key: string) {
    try {
      const { summary, signal: s } = await this.d.reports.lookupSignal(type, key);
      b.source('community_reports', 'ok');
      b.add(s);
      b.details.reports = {
        total: summary.total,
        verified: summary.verified,
        pending: summary.pending,
        categories: summary.categories,
        lastReportedAt: summary.lastReportedAt,
      };
    } catch (err) {
      b.source('community_reports', 'error', (err as Error).message);
    }
  }

  // ================================================================= MEDIA

  async checkMedia(
    input: { bytes: Uint8Array; filename?: string; kind: MediaKind },
    _ctx: CheckContext,
  ): Promise<Verdict> {
    const f = analyzeMedia(input.bytes);
    if (!f.meta)
      throw new AppError('bad_request', 'Unsupported or unrecognized media format', {
        vi: 'Không nhận dạng được định dạng tệp',
      });
    if (f.meta.kind !== input.kind) {
      throw new AppError(
        'bad_request',
        `This file looks like ${f.meta.kind} (${f.meta.format}); use /v1/check/${f.meta.kind}`,
      );
    }
    const sha = createHash('sha256').update(input.bytes).digest('hex');
    const sizeKb = Math.max(1, Math.round(input.bytes.byteLength / 1024));
    const dims = f.meta.width && f.meta.height ? ` · ${f.meta.width}x${f.meta.height}` : '';
    const b = new VerdictBuilder(
      input.kind,
      `${f.meta.format}${dims} · ${sizeKb} KB · sha256:${sha.slice(0, 16)}`,
    );
    b.add(...f.signals);
    b.source('metadata', 'ok');
    b.source(
      'c2pa',
      'ok',
      f.c2pa
        ? f.c2pa.parseError
          ? `manifest present, partially parsed: ${f.c2pa.parseError}`
          : 'manifest present (signature not verified)'
        : 'no manifest',
    );

    const detectorResults: {
      name: string;
      status: string;
      aiProbability?: number;
      detail?: string;
      verified: false;
    }[] = [];
    const configured = this.d.detectors.filter((d) => d.supports(input.kind));
    const results = await Promise.all(
      configured.map((d) =>
        d.detect({
          bytes: input.bytes,
          mime: f.meta!.mime,
          filename: input.filename ?? `upload.${f.meta!.format}`,
          kind: input.kind,
        }),
      ),
    );
    for (const r of results) {
      detectorResults.push(r);
      b.source(r.name, r.status, `${r.detail ? `${r.detail} · ` : ''}unverified adapter`);
      if (r.status === 'ok' && typeof r.aiProbability === 'number') {
        const p = r.aiProbability;
        const w = p >= 0.5 ? Math.round((p - 0.5) * 2 * 65) : -Math.round((0.5 - p) * 2 * 20);
        const pct = Math.round(p * 100);
        b.add(
          signal(
            `media.detector.${r.name}`,
            w,
            {
              vi: `Bộ phát hiện ${DETECTOR_NAMES[r.name] ?? r.name} ước tính khả năng nội dung do AI tạo hoặc bị chỉnh sửa: ${pct}% (bộ phát hiện có thể báo nhầm)`,
              en: `${DETECTOR_NAMES[r.name] ?? r.name} estimates a ${pct}% chance the content is AI-generated or manipulated (detectors can be wrong)`,
            },
            r.name,
            `${pct}%`,
          ),
        );
      }
    }
    for (const name of Object.keys(DETECTOR_KEYS)) {
      if (!configured.some((d) => d.name === name) && this.detectorSupports(name, input.kind)) {
        b.source(name, 'skipped', `${DETECTOR_KEYS[name]} not set`);
      }
    }

    const m = f.meta;
    b.details.format = m.format;
    b.details.mime = m.mime;
    if (m.width) b.details.width = m.width;
    if (m.height) b.details.height = m.height;
    b.details.sizeBytes = input.bytes.byteLength;
    b.details.sha256 = sha;
    if (m.exif) {
      b.details.exif = {
        make: m.exif.make,
        model: m.exif.model,
        software: m.exif.software,
        dateTimeOriginal: m.exif.dateTimeOriginal,
        hasGps: m.exif.hasGps ?? false,
      };
      if (m.exif.hasGps) {
        b.recommend(
          'Tệp này có chứa vị trí GPS. Hãy xóa thông tin vị trí trước khi chia sẻ lên mạng.',
          'This file contains GPS location data. Remove it before sharing online.',
        );
      }
    }
    if (f.xmp) b.details.xmp = f.xmp;
    if (Object.keys(m.iptc).length) b.details.iptc = m.iptc;
    if (Object.keys(m.text).length) b.details.textChunks = Object.keys(m.text).slice(0, 20);
    if (f.c2pa) b.details.c2pa = { ...f.c2pa, signatureVerified: false };
    if (f.aiMarkers.length) b.details.aiMarkers = f.aiMarkers;
    b.details.detectors = detectorResults;
    b.details.disclaimer = {
      vi: 'Không công cụ nào kết luận chắc chắn được nội dung là thật hay giả. Siêu dữ liệu có thể bị xóa hoặc làm giả; các bộ phát hiện AI có tỉ lệ báo nhầm đáng kể.',
      en: 'No tool can conclusively tell real from fake. Metadata can be stripped or forged; AI detectors have significant false-alarm rates.',
    };
    const insufficient = f.insufficientData && !results.some((r) => typeof r.aiProbability === 'number');
    return b.build({ checkedAt: this.d.now(), insufficientData: insufficient });
  }

  private detectorSupports(name: string, kind: MediaKind): boolean {
    return name === 'reality_defender' ? true : kind !== 'audio';
  }

  // =============================================================== AI TEXT

  async checkAiText(rawText: string, ctx: CheckContext): Promise<Verdict> {
    const text = rawText.normalize('NFC').trim();
    if (!text) throw new AppError('bad_request', 'Text is empty');
    if (text.length > 20_000) throw new AppError('bad_request', 'Text is longer than 20000 characters');
    const b = new VerdictBuilder('ai_text', text);
    b.details.disclaimer = {
      vi: 'Ước lượng văn bản do AI viết có độ tin cậy thấp; người viết không phải người bản xứ hoặc văn phong trang trọng dễ bị nhận nhầm. Không dùng để kết luận hay buộc tội.',
      en: 'AI-writing estimates are low-confidence; formal or non-native writing is often misjudged. Never use this to accuse anyone.',
    };
    if (text.length < MIN_CHARS) {
      b.source('stylometry', 'skipped', `Text shorter than ${MIN_CHARS} characters`);
      b.source('llm_judge', 'skipped', 'Text too short');
      return b.build({ checkedAt: this.d.now(), insufficientData: true, maxLevel: 'medium', maxScore: 60 });
    }
    const features = styleFeatures(text);
    b.add(...styleSignals(features));
    b.source('stylometry', 'ok');
    b.details.features = features;
    const judge = await judgeAiText(this.d.llmFor(ctx.llmOrgId), text, {
      model: this.d.env.SAFE_LLM_MODEL,
      timeoutMs: this.d.env.SAFE_LLM_TIMEOUT_MS,
      skipReason: this.llmSkipReason(ctx.llmOrgId),
    });
    b.source(judge.status.name, judge.status.status, judge.status.detail);
    b.add(...judge.signals);
    if (judge.data) b.details.judge = judge.data;
    const meaningful = b.signals.some((s: Signal) => Math.abs(s.weight) >= 10);
    return b.build({
      checkedAt: this.d.now(),
      maxLevel: 'medium',
      maxScore: 60,
      insufficientData: !meaningful && judge.status.status !== 'ok',
    });
  }
}
