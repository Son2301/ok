import { MockLlm } from '@ok/llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaDetector } from './media/detectors';
import {
  fakeResolver,
  fakeTransport,
  INTERNAL_TOKEN,
  post,
  scamReply,
  setupSafe,
  type TestSafe,
} from './test/helpers';
import { buildJpeg, buildPng, buildTiff, TAG } from './test/media-fixtures';
import { type Verdict, verdictSchema } from './verdict/types';

const VERDICT_KEYS = [
  'cached',
  'checkedAt',
  'id',
  'input',
  'kind',
  'level',
  'recommendations',
  'score',
  'shareText',
  'signals',
  'sources',
  'summary',
];

async function verdictOf(res: Response): Promise<Verdict> {
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  return verdictSchema.parse(body);
}

describe('check endpoints (offline: external sources skipped)', () => {
  let t: TestSafe;
  const llm = new MockLlm((req) => {
    const text = String(req.messages[1]?.content ?? '');
    if (/công an/i.test(text))
      return scamReply({ prob: 0.95, conf: 0.9, quotes: ['chuyển tiền vào tài khoản tạm giữ'] });
    if (
      /ai_probability|<text>/.test(text) ||
      /estimate whether a text/.test(String(req.messages[0]?.content))
    ) {
      return JSON.stringify({
        ai_probability: 0.7,
        confidence: 0.5,
        indicators: [{ indicator_vi: 'Văn phong khuôn mẫu', indicator_en: 'Formulaic style' }],
      });
    }
    return scamReply({ prob: 0.05, conf: 0.8, type: 'none', goal: '' });
  });
  const fakeDetector: MediaDetector = {
    name: 'hive',
    supports: (k) => k === 'image',
    detect: async () => ({ name: 'hive', status: 'ok', aiProbability: 0.92, verified: false }),
  };

  beforeAll(async () => {
    const resolver = fakeResolver(
      { 'bit.ly': ['67.199.248.10'], 'vcb-secure-login.top': ['45.77.1.2'], 'media.test': ['93.184.216.34'] },
      {
        'gmail.com': [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }],
        'vietcombank.com.vn': [{ exchange: 'mx.vietcombank.com.vn', priority: 10 }],
      },
    );
    const transport = fakeTransport({
      'https://bit.ly/3vcbx': {
        status: 301,
        headers: { location: 'https://vcb-secure-login.top/dang-nhap' },
      },
      'https://vcb-secure-login.top/dang-nhap': {
        tls: { issuer: "Let's Encrypt", validFrom: new Date(Date.now() - 86_400_000).toUTCString() },
        body: '<html><head><title>Vietcombank | Đăng nhập VCB Digibank</title></head><body><form action="/x"><input name="username"><input type="password" name="pwd"><input name="otp"></form></body></html>',
      },
      'https://media.test/ai.png': {
        headers: { 'content-type': 'image/png' },
        body: buildPng({
          width: 1024,
          height: 1024,
          text: { parameters: 'cat\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1' },
        }),
      },
    });
    t = await setupSafe({ llm, resolver, transport, detectors: [fakeDetector] });
  });
  afterAll(() => t.close());

  it('GET /health', async () => {
    const res = await t.app.request('/health');
    expect(await res.json()).toEqual({ ok: true, service: 'safe', db: 'ok' });
  });

  it('URL: brand impersonation is caught offline; missing credentials are "skipped", never a crash', async () => {
    const res = await post(t.app, '/v1/check/url', { url: 'vietcombank-xacthuc.com/login' });
    const v = await verdictOf(res);
    expect(v.kind).toBe('url');
    expect(v.input).toBe('http://vietcombank-xacthuc.com/login');
    expect(['high', 'critical']).toContain(v.level);
    expect(v.signals[0]!.id).toBe('url.brand_impersonation');
    const byName = Object.fromEntries(v.sources.map((s) => [s.name, s.status]));
    expect(byName).toMatchObject({
      heuristics: 'ok',
      google_safe_browsing: 'skipped',
      virustotal: 'skipped',
      urlhaus: 'skipped',
      phishing_feeds: 'skipped',
      rdap: 'skipped',
      page_fetch: 'error',
    });
    expect(v.ifAlreadyPaid?.vi.length).toBeGreaterThan(0);
    expect(v.shareText.vi).toContain('vietcombank-xacthuc[.]com');
    expect(res.headers.get('x-ratelimit-limit')).toBe('30');
    expect(Object.keys(v).sort()).toEqual([...VERDICT_KEYS, 'details', 'ifAlreadyPaid'].sort());
  });

  it('URL: repeated checks are served from cache with a fresh id', async () => {
    const a = await verdictOf(await post(t.app, '/v1/check/url', { url: 'https://evn-thanhtoan.top/pay' }));
    const b = await verdictOf(await post(t.app, '/v1/check/url', { url: 'https://evn-thanhtoan.top/pay' }));
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(b.id).not.toBe(a.id);
    expect(b.score).toBe(a.score);
    const c = await verdictOf(
      await post(t.app, '/v1/check/url', {
        url: 'https://evn-thanhtoan.top/pay',
        options: { noCache: true },
      }),
    );
    expect(c.cached).toBe(false);
  });

  it('URL: expands a shortener through the SSRF-safe fetcher and inspects the landing page', async () => {
    const v = await verdictOf(await post(t.app, '/v1/check/url', { url: 'https://bit.ly/3vcbx' }));
    expect(v.details?.finalUrl).toBe('https://vcb-secure-login.top/dang-nhap');
    const ids = v.signals.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'url.brand_impersonation.final',
        'page.brand_claim',
        'page.credential_form',
        'url.new_certificate',
      ]),
    );
    expect(v.level).toBe('critical');
  });

  it('URL: official domains come back as level "safe" without claiming safety in words', async () => {
    const v = await verdictOf(await post(t.app, '/v1/check/url', { url: 'https://vietcombank.com.vn' }));
    expect(v.level).toBe('safe');
    expect(v.summary.vi).toContain('Chưa phát hiện dấu hiệu lừa đảo');
    expect(v.summary.vi.toLowerCase()).not.toContain('an toàn');
    expect(v.summary.vi).toContain('chính thức của Vietcombank');
  });

  it('URL: rejects garbage and dangerous schemes', async () => {
    expect((await post(t.app, '/v1/check/url', { url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await post(t.app, '/v1/check/url', { nope: 1 })).status).toBe(400);
  });

  it('TEXT: rules + entity checks + bounded LLM, with scammer goal and police-warned note', async () => {
    const text =
      'Đây là Công an quận 1. Anh có liên quan đến vụ án rửa tiền, yêu cầu chuyển tiền vào tài khoản tạm giữ STK 0011004123456 Vietcombank - NGUYEN VAN A trong hôm nay. Xem lệnh tại https://bocongan-gov.top/lenh. Tuyệt đối giữ bí mật.';
    const v = await verdictOf(await post(t.app, '/v1/check/text', { text, channel: 'zalo' }));
    expect(v.level).toBe('critical');
    const ids = v.signals.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'text.rule.fake_authority',
        'text.rule.secrecy',
        'text.authority_payment',
        'text.entity.url',
        'llm.assessment',
      ]),
    );
    expect(v.entities).toEqual({
      urls: ['https://bocongan-gov.top/lenh'],
      phones: [],
      bankAccounts: [
        {
          accountNumber: '0011004123456',
          bankCode: 'VCB',
          bankName: 'Vietcombank',
          accountName: 'NGUYEN VAN A',
        },
      ],
      emails: [],
    });
    expect(v.details?.scammerGoal).toMatchObject({ vi: expect.stringContaining('tài khoản tạm giữ') });
    expect(v.summary.vi).toContain('Giống kịch bản đã được công an cảnh báo');
    expect(v.recommendations.vi.join(' ')).toContain('Công an');
    expect(v.sources.find((s) => s.name === 'llm')?.status).toBe('ok');
    const llmSig = v.signals.find((s) => s.id === 'llm.assessment')!;
    expect(llmSig.weight).toBeLessThanOrEqual(25);
    expect(t.llmOrgs).toContain('org_platform');
  });

  it('TEXT: a benign message stays low even with the LLM consulted', async () => {
    const v = await verdictOf(
      await post(t.app, '/v1/check/text', { text: 'Tối nay mấy giờ con về ăn cơm? Mẹ nấu canh chua nhé.' }),
    );
    expect(['low', 'safe']).toContain(v.level);
    expect(v.score).toBeLessThan(25);
    expect(v.summary.vi).toContain('Chưa phát hiện dấu hiệu lừa đảo');
  });

  it('TEXT: SMS sent as a bank brandname with a foreign link is flagged', async () => {
    const v = await verdictOf(
      await post(t.app, '/v1/check/text', {
        text: 'Quy khach vui long cap nhat thong tin tai https://vcb-update.top',
        sender: 'Vietcombank',
      }),
    );
    expect(v.signals.map((s) => s.id)).toContain('text.brandname_link');
  });

  it('PHONE: normalizes, detects carrier and explains portability', async () => {
    const v = await verdictOf(await post(t.app, '/v1/check/phone', { phone: '+84 98 765 4321' }));
    expect(v.input).toBe('+84987654321');
    expect(v.details).toMatchObject({ national: '0987654321', type: 'mobile', carrier: 'Viettel' });
    expect(v.level).toBe('low');
    expect(v.summary.vi).toContain('Chưa phát hiện dấu hiệu lừa đảo');
    const foreign = await verdictOf(await post(t.app, '/v1/check/phone', { phone: '+855 12 345 678' }));
    expect(foreign.signals[0]).toMatchObject({ id: 'phone.foreign', weight: 30 });
    expect((await post(t.app, '/v1/check/phone', { phone: '0112345678' })).status).toBe(400);
  });

  it('BANK ACCOUNT: honest about data sources (no bank/SIMO access)', async () => {
    const v = await verdictOf(
      await post(t.app, '/v1/check/bank-account', { accountNumber: '1903 4567 8901 23', bankName: 'tcb' }),
    );
    expect(v.details).toMatchObject({ accountNumber: '19034567890123', bankCode: 'TCB' });
    expect(v.sources.find((s) => s.name === 'bank_lookup')).toMatchObject({
      status: 'skipped',
      detail: expect.stringContaining('SIMO'),
    });
  });

  it('EMAIL: freemail claiming to be a bank, disposable domains, official domains', async () => {
    const fake = await verdictOf(
      await post(t.app, '/v1/check/email', { email: 'vietcombank.hotro@gmail.com' }),
    );
    expect(fake.signals.map((s) => s.id)).toContain('email.freemail_brand');
    expect(fake.details?.mx).toEqual(['gmail-smtp-in.l.google.com']);
    const tmp = await verdictOf(await post(t.app, '/v1/check/email', { email: 'abc@mailinator.com' }));
    expect(tmp.signals.map((s) => s.id)).toEqual(expect.arrayContaining(['email.disposable', 'email.no_mx']));
    const official = await verdictOf(
      await post(t.app, '/v1/check/email', { email: 'cskh@vietcombank.com.vn' }),
    );
    expect(official.level).toBe('safe');
    const look = await verdictOf(
      await post(t.app, '/v1/check/email', { email: 'support@vietcombank-xacthuc.com' }),
    );
    expect(look.signals.map((s) => s.id)).toContain('email.brand_impersonation');
  });

  it('IMAGE: multipart upload, metadata forensics + (fake) detector, always with a disclaimer', async () => {
    const form = new FormData();
    form.append(
      'file',
      new Blob(
        [
          buildPng({
            width: 1024,
            height: 1024,
            text: { parameters: 'portrait\nSteps: 28, Sampler: Euler, CFG scale: 6, Seed: 9' },
          }) as Uint8Array<ArrayBuffer>,
        ],
        { type: 'image/png' },
      ),
      'x.png',
    );
    const res = await t.app.request('/v1/check/image', {
      method: 'POST',
      body: form,
      headers: { 'x-forwarded-for': '198.51.100.7' },
    });
    const v = await verdictOf(res);
    expect(v.kind).toBe('image');
    expect(v.input).toMatch(/^png · 1024x1024 · \d+ KB · sha256:[0-9a-f]{16}$/);
    expect(['high', 'critical']).toContain(v.level);
    expect(v.signals.map((s) => s.id)).toEqual(
      expect.arrayContaining(['media.generation_parameters', 'media.detector.hive']),
    );
    expect(v.summary.vi).toContain('không công cụ nào');
    expect(v.sources.find((s) => s.name === 'hive')?.detail).toContain('unverified');
    expect(v.sources.find((s) => s.name === 'sightengine')).toMatchObject({ status: 'skipped' });
    expect(v.details?.detectors as unknown[]).toHaveLength(1);
  });

  it('IMAGE: by URL through the SSRF-safe fetcher; blocked internal URLs are rejected', async () => {
    const v = await verdictOf(
      await post(
        t.app,
        '/v1/check/image',
        { url: 'https://media.test/ai.png' },
        { 'x-forwarded-for': '198.51.100.8' },
      ),
    );
    expect(v.signals.map((s) => s.id)).toContain('media.generation_parameters');
    const blocked = await post(
      t.app,
      '/v1/check/image',
      { url: 'http://169.254.169.254/latest/meta-data' },
      { 'x-forwarded-for': '198.51.100.9' },
    );
    expect(blocked.status).toBe(400);
  });

  it('IMAGE: camera photo without AI markers stays low; a stripped photo is "unknown"; wrong kind is rejected', async () => {
    const t2 = await setupSafe();
    const upload = async (bytes: Uint8Array, ip: string, kind = 'image') => {
      const form = new FormData();
      form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>]), 'a.jpg');
      return t2.app.request(`/v1/check/${kind}`, {
        method: 'POST',
        body: form,
        headers: { 'x-forwarded-for': ip },
      });
    };
    try {
      const cam = await verdictOf(
        await upload(
          buildJpeg({
            tiff: buildTiff(
              { [TAG.make]: 'Samsung', [TAG.model]: 'SM-S918B' },
              { [TAG.dateTimeOriginal]: '2025:09:01 10:00:00' },
            ),
          }),
          '192.0.2.1',
        ),
      );
      expect(['low', 'safe']).toContain(cam.level);
      expect(cam.summary.vi).toContain('Chưa thấy dấu hiệu cảnh báo');
      const stripped = await verdictOf(await upload(buildJpeg({ width: 1280, height: 960 }), '192.0.2.2'));
      expect(stripped.level).toBe('unknown');
      expect(stripped.summary.vi).toContain('Chưa đủ dữ liệu');
      expect((await upload(buildJpeg(), '192.0.2.3', 'video')).status).toBe(400);
    } finally {
      await t2.close();
    }
  });

  it('AI-TEXT: too short → unknown; long text is capped at "medium" and never accusatory', async () => {
    const short = await verdictOf(
      await post(t.app, '/v1/check/ai-text', { text: 'Xin chào bạn.' }, { 'x-forwarded-for': '192.0.2.50' }),
    );
    expect(short.level).toBe('unknown');
    const long =
      'Dưới đây là một số lưu ý quan trọng. Ngoài ra, việc bảo vệ thông tin cá nhân đóng vai trò quan trọng. Bên cạnh đó, người dùng cần cẩn trọng với đường link lạ. Tóm lại, nâng cao nhận thức là cách hiệu quả nhất. Điều quan trọng là luôn cập nhật kiến thức. Hy vọng thông tin này hữu ích cho bạn.';
    const v = await verdictOf(
      await post(t.app, '/v1/check/ai-text', { text: long }, { 'x-forwarded-for': '192.0.2.50' }),
    );
    expect(['low', 'medium']).toContain(v.level);
    expect(v.score).toBeLessThanOrEqual(60);
    expect(v.summary.vi).toContain('độ tin cậy thấp');
    expect(v.summary.vi).not.toMatch(/do AI viết\./);
  });

  it('verdict shape is stable across every check kind', async () => {
    const headers = { authorization: `Bearer ${INTERNAL_TOKEN}`, 'x-org-id': 'org_x' };
    const responses = await Promise.all([
      post(t.app, '/v1/check/url', { url: 'https://example.org' }, headers),
      post(t.app, '/v1/check/text', { text: 'Chào bạn' }, headers),
      post(t.app, '/v1/check/phone', { phone: '0912345678' }, headers),
      post(t.app, '/v1/check/bank-account', { accountNumber: '0123456789' }, headers),
      post(t.app, '/v1/check/email', { email: 'a@example.org' }, headers),
      post(t.app, '/v1/check/ai-text', { text: 'ngắn' }, headers),
    ]);
    for (const res of responses) {
      const v = await verdictOf(res);
      for (const k of VERDICT_KEYS) expect(v, `${v.kind}.${k}`).toHaveProperty(k);
      expect(
        Object.keys(v).every((k) => [...VERDICT_KEYS, 'details', 'entities', 'ifAlreadyPaid'].includes(k)),
      ).toBe(true);
      expect(v.id).toMatch(/^chk_/);
      expect(Number.isNaN(Date.parse(v.checkedAt))).toBe(false);
      expect(v.recommendations.vi.length).toBe(v.recommendations.en.length);
    }
  });
});
