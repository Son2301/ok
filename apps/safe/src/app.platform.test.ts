import { MockLlm } from '@minh/llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatTelegramReply } from './channels/telegram';
import {
  fakeResolver,
  fakeTransport,
  INTERNAL_TOKEN,
  post,
  scamReply,
  setupSafe,
  type TestSafe,
} from './test/helpers';
import { buildPng } from './test/media-fixtures';
import { type Verdict, verdictSchema } from './verdict/types';

const admin = { authorization: `Bearer ${INTERNAL_TOKEN}` };
const internal = (org: string, user?: string) => ({
  authorization: `Bearer ${INTERNAL_TOKEN}`,
  'x-org-id': org,
  ...(user ? { 'x-user-id': user } : {}),
});
const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

describe('community reports', () => {
  let t: TestSafe;
  beforeAll(async () => {
    t = await setupSafe({ env: { SAFE_ANON_DAILY_REPORTS: '3' } });
  });
  afterAll(() => t.close());

  const phoneScore = async () =>
    (
      await json<Verdict>(
        await post(t.app, '/v1/check/phone', { phone: '0901234567' }, { 'x-forwarded-for': '192.0.2.200' }),
      )
    ).score;

  it('anonymous reports dedupe per reporter and raise the score of the target', async () => {
    expect(await phoneScore()).toBe(0);
    const r1 = await post(
      t.app,
      '/v1/reports',
      {
        type: 'phone',
        value: '090 123 4567',
        category: 'impersonation_authority',
        description: 'Gọi xưng công an',
      },
      { 'x-forwarded-for': '198.51.100.1' },
    );
    expect(r1.status).toBe(201);
    const b1 = await json(r1);
    expect(b1).toMatchObject({ type: 'phone', status: 'pending', deduplicated: false });

    const again = await post(
      t.app,
      '/v1/reports',
      { type: 'phone', value: '+84901234567', category: 'impersonation_authority', amountLostVnd: 5_000_000 },
      { 'x-forwarded-for': '198.51.100.1' },
    );
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ id: b1.id, deduplicated: true });

    const pendingOne = await phoneScore();
    expect(pendingOne).toBe(25);

    await post(
      t.app,
      '/v1/reports',
      { type: 'phone', value: '0901234567', category: 'impersonation_authority' },
      { 'x-forwarded-for': '198.51.100.2' },
    );
    const v = verdictSchema.parse(
      await json(
        await post(t.app, '/v1/check/phone', { phone: '0901234567' }, { 'x-forwarded-for': '192.0.2.200' }),
      ),
    );
    expect(v.score).toBeGreaterThan(pendingOne);
    expect(v.signals[0]).toMatchObject({ id: 'reports.community', source: 'community_reports' });
    expect(v.signals[0]!.label.vi).toContain('2 lần');
    expect(v.signals[0]!.evidence).toContain('5.000.000');
    expect(v.details?.reports).toMatchObject({ total: 2, verified: 0, pending: 2 });
  });

  it('verified reports weigh more; rejected ones stop counting (admin moderation)', async () => {
    const list = await json<{ data: { id: string; status: string }[] }>(
      await t.app.request('/admin/reports?status=pending&type=phone', { headers: admin }),
    );
    expect(list.data).toHaveLength(2);
    const before = await phoneScore();
    for (const r of list.data) {
      const res = await post(
        t.app,
        `/admin/reports/${r.id}/moderate`,
        { status: 'verified', note: 'Đã xác minh qua ghi âm' },
        admin,
      );
      expect(res.status).toBe(200);
    }
    const verified = await phoneScore();
    expect(verified).toBeGreaterThan(before);
    expect(verified).toBeGreaterThanOrEqual(60);
    for (const r of list.data)
      await post(t.app, `/admin/reports/${r.id}/moderate`, { status: 'rejected' }, admin);
    expect(await phoneScore()).toBe(0);
  });

  it('URL reports invalidate the cached verdict and are keyed by path on user-content platforms', async () => {
    const first = await json<Verdict>(
      await post(t.app, '/v1/check/url', { url: 'https://quick-loan-vn.top/apply' }),
    );
    await post(
      t.app,
      '/v1/reports',
      { type: 'url', value: 'https://quick-loan-vn.top/other', category: 'loan' },
      { 'x-forwarded-for': '198.51.100.3' },
    );
    const after = await json<Verdict>(
      await post(t.app, '/v1/check/url', { url: 'https://quick-loan-vn.top/apply' }),
    );
    expect(after.cached).toBe(false);
    expect(after.score).toBeGreaterThan(first.score);

    await post(
      t.app,
      '/v1/reports',
      { type: 'url', value: 'https://www.facebook.com/fake.vcb.support', category: 'impersonation_bank' },
      { 'x-forwarded-for': '198.51.100.3' },
    );
    const fbOther = await json<Verdict>(
      await post(t.app, '/v1/check/url', { url: 'https://www.facebook.com/somebody.else' }),
    );
    expect(fbOther.signals.map((s) => s.id)).not.toContain('reports.community');
    const fbScammer = await json<Verdict>(
      await post(t.app, '/v1/check/url', { url: 'https://facebook.com/fake.vcb.support' }),
    );
    expect(fbScammer.signals.map((s) => s.id)).toContain('reports.community');
  });

  it('bank account and email reports, votes, and evidence images (admin only)', async () => {
    const png = Buffer.from(buildPng({ width: 10, height: 10 })).toString('base64');
    const r = await post(
      t.app,
      '/v1/reports',
      {
        type: 'bank_account',
        value: '1903 4567 8901 23',
        bankName: 'Techcombank',
        category: 'job_task',
        evidenceUrls: ['https://imgur.com/abc'],
        evidenceImages: [{ contentType: 'image/png', dataBase64: png }],
      },
      internal('org_reporter'),
    );
    expect(r.status).toBe(201);
    const { id } = await json<{ id: string }>(r);
    const vote = await post(
      t.app,
      `/v1/reports/${id}/votes`,
      { vote: 'confirm' },
      { 'x-forwarded-for': '198.51.100.9' },
    );
    expect(await json(vote)).toMatchObject({ votes: { confirm: 1, dispute: 0 } });
    const acc = await json<Verdict>(
      await post(t.app, '/v1/check/bank-account', { accountNumber: '19034567890123' }),
    );
    expect(acc.signals.map((s) => s.id)).toContain('reports.community');

    const detail = await json<{ evidence: { id: string; contentType: string }[] }>(
      await t.app.request(`/admin/reports/${id}`, { headers: admin }),
    );
    expect(detail.evidence[0]!.contentType).toBe('image/png');
    const img = await t.app.request(`/admin/reports/${id}/evidence/${detail.evidence[0]!.id}`, {
      headers: admin,
    });
    expect(img.headers.get('content-type')).toBe('image/png');
    expect((await img.arrayBuffer()).byteLength).toBeGreaterThan(30);
    expect((await t.app.request(`/admin/reports/${id}`)).status).toBe(401);

    const bad = await post(
      t.app,
      '/v1/reports',
      {
        type: 'email',
        value: 'x@y.co',
        category: 'other',
        evidenceImages: [
          { contentType: 'image/png', dataBase64: Buffer.from('not an image').toString('base64') },
        ],
      },
      internal('org_reporter'),
    );
    expect(bad.status).toBe(400);
  });

  it('validates input and rate-limits anonymous reporters', async () => {
    expect(
      (
        await post(
          t.app,
          '/v1/reports',
          { type: 'phone', value: 'abc', category: 'other' },
          { 'x-forwarded-for': '198.51.100.50' },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          t.app,
          '/v1/reports',
          { type: 'phone', value: '0912345678', category: 'not-a-category' },
          { 'x-forwarded-for': '198.51.100.50' },
        )
      ).status,
    ).toBe(400);
    const ip = { 'x-forwarded-for': '198.51.100.60' };
    for (const n of ['0912000001', '0912000002', '0912000004'])
      expect(
        (await post(t.app, '/v1/reports', { type: 'phone', value: n, category: 'spam' }, ip)).status,
      ).toBe(201);
    const limited = await post(
      t.app,
      '/v1/reports',
      { type: 'phone', value: '0912000003', category: 'spam' },
      ip,
    );
    expect(limited.status).toBe(429);
    expect(JSON.stringify(await limited.json())).toContain('báo cáo');
  });

  it('public stats aggregate categories without exposing reported values', async () => {
    const stats = await json<{
      topCategories: { category: string; label: { vi: string }; count: number }[];
      totalReports: number;
      totalChecks: number;
    }>(await t.app.request('/v1/reports/stats?days=7'));
    expect(stats.totalReports).toBeGreaterThan(0);
    expect(stats.totalChecks).toBeGreaterThan(0);
    expect(stats.topCategories[0]!.label.vi.length).toBeGreaterThan(2);
    expect(JSON.stringify(stats)).not.toContain('0901234567');
    expect(JSON.stringify(stats)).not.toContain('19034567890123');
  });
});

describe('free tier limits', () => {
  it('limits anonymous checks per IP per day (separate media quota), honouring X-Forwarded-For only behind a trusted proxy', async () => {
    const t = await setupSafe({ env: { SAFE_ANON_DAILY_CHECKS: '3', SAFE_ANON_DAILY_MEDIA: '1' } });
    try {
      const ip = { 'x-forwarded-for': '203.0.113.77' };
      for (let i = 0; i < 3; i++) {
        const res = await post(t.app, '/v1/check/phone', { phone: '0912345678' }, ip);
        expect(res.status).toBe(200);
        expect(res.headers.get('x-ratelimit-remaining')).toBe(String(2 - i));
      }
      const blocked = await post(t.app, '/v1/check/phone', { phone: '0912345678' }, ip);
      expect(blocked.status).toBe(429);
      const body = await json<{ error: { code: string; details: { vi: string; resetAt: string } } }>(blocked);
      expect(body.error.code).toBe('rate_limited');
      expect(body.error.details.vi).toContain('3 lượt');
      expect(
        (await post(t.app, '/v1/check/phone', { phone: '0912345678' }, { 'x-forwarded-for': '203.0.113.78' }))
          .status,
      ).toBe(200);
      // the leftmost XFF entry is client-controlled; we trust the one our proxy appended (rightmost)
      expect(
        (
          await post(
            t.app,
            '/v1/check/phone',
            { phone: '0912345678' },
            { 'x-forwarded-for': '1.2.3.4, 203.0.113.77' },
          )
        ).status,
      ).toBe(429);

      const media = () => {
        const form = new FormData();
        form.append('file', new Blob([buildPng() as Uint8Array<ArrayBuffer>]), 'a.png');
        return t.app.request('/v1/check/image', {
          method: 'POST',
          body: form,
          headers: { 'x-forwarded-for': '203.0.113.90' },
        });
      };
      expect((await media()).status).toBe(200);
      expect((await media()).status).toBe(429);
      expect(
        (await post(t.app, '/v1/check/phone', { phone: '0912345678' }, { 'x-forwarded-for': '203.0.113.90' }))
          .status,
      ).toBe(200);
    } finally {
      await t.close();
    }
  });

  it('ignores X-Forwarded-For when TRUST_PROXY=false', async () => {
    const t = await setupSafe({ env: { SAFE_ANON_DAILY_CHECKS: '2', TRUST_PROXY: 'false' } });
    try {
      expect(
        (await post(t.app, '/v1/check/phone', { phone: '0912345678' }, { 'x-forwarded-for': '10.0.0.1' }))
          .status,
      ).toBe(200);
      expect(
        (await post(t.app, '/v1/check/phone', { phone: '0912345678' }, { 'x-forwarded-for': '10.0.0.2' }))
          .status,
      ).toBe(200);
      expect(
        (await post(t.app, '/v1/check/phone', { phone: '0912345678' }, { 'x-forwarded-for': '10.0.0.3' }))
          .status,
      ).toBe(429);
    } finally {
      await t.close();
    }
  });
});

describe('per-check billing for API keys', () => {
  let t: TestSafe;
  const llm = new MockLlm(() => scamReply({ prob: 0.2, conf: 0.5, type: 'none', goal: '' }));
  beforeAll(async () => {
    t = await setupSafe({ llm, env: { SAFE_PRICES: '{"url":1500}' } });
  });
  afterAll(() => t.close());

  it('debits the price table via core.debit and bills LLM usage to the caller org', async () => {
    const org = await t.core.createOrg('Fintech Co', 50_000);
    const { key, record } = await t.core.createApiKey(org.id, { name: 'prod', scopes: ['safe'] });
    const auth = { authorization: `Bearer ${key}` };

    const url = await post(t.app, '/v1/check/url', { url: 'https://example.org' }, auth);
    expect(url.status).toBe(200);
    expect(url.headers.get('x-safe-charged-micros')).toBe('1500');
    const v = await json<Verdict>(url);
    expect(await t.core.getBalance(org.id)).toBe(48_500);

    const text = await post(t.app, '/v1/check/text', { text: 'Anh ơi mai họp lúc 9h nhé' }, auth);
    expect(text.headers.get('x-safe-charged-micros')).toBe('1000');
    expect(t.llmOrgs.at(-1)).toBe(org.id);

    const form = new FormData();
    form.append('file', new Blob([buildPng() as Uint8Array<ArrayBuffer>]), 'a.png');
    const img = await t.app.request('/v1/check/image', { method: 'POST', body: form, headers: auth });
    expect(img.headers.get('x-safe-charged-micros')).toBe('10000');
    expect(await t.core.getBalance(org.id)).toBe(37_500);

    const entries = await t.core.listWalletEntries(org.id, { product: 'safe' });
    expect(entries).toHaveLength(3);
    expect(entries.find((e) => e.ref === v.id)).toMatchObject({
      amountMicros: -1500,
      product: 'safe',
      apiKeyId: record.id,
    });
  });

  it('refunds failed checks and refuses when the wallet is empty', async () => {
    const org = await t.core.createOrg('Small Co', 1_000);
    const { key } = await t.core.createApiKey(org.id, { name: 'k' });
    const auth = { authorization: `Bearer ${key}` };
    const bad = await post(t.app, '/v1/check/phone', { phone: '0112345678' }, auth);
    expect(bad.status).toBe(400);
    expect(await t.core.getBalance(org.id)).toBe(1_000);
    expect((await post(t.app, '/v1/check/phone', { phone: '0912345678' }, auth)).status).toBe(200);
    const broke = await post(t.app, '/v1/check/phone', { phone: '0912345678' }, auth);
    expect(broke.status).toBe(402);
    expect(await t.core.getBalance(org.id)).toBe(0);
  });

  it('rejects keys scoped to other products', async () => {
    const org = await t.core.createOrg('Other', 10_000);
    const { key } = await t.core.createApiKey(org.id, { name: 'gw', scopes: ['gateway'] });
    expect(
      (await post(t.app, '/v1/check/phone', { phone: '0912345678' }, { authorization: `Bearer ${key}` }))
        .status,
    ).toBe(403);
  });
});

describe('history for signed-in users (privacy)', () => {
  let t: TestSafe;
  beforeAll(async () => {
    t = await setupSafe();
  });
  afterAll(() => t.close());

  it('stores hashes and redacted verdicts by default; raw text only with opt-in', async () => {
    const h = internal('org_family', 'usr_mom');
    const secret = 'Mẹ ơi con đổi số rồi, chuyển giúp con 5 triệu vào tài khoản này nhé';
    await post(t.app, '/v1/check/text', { text: secret }, h);
    await post(t.app, '/v1/check/text', { text: 'Tin nhắn tôi muốn lưu lại', storeInput: true }, h);
    await post(t.app, '/v1/check/url', { url: 'https://vietcombank-xacthuc.com/a?token=123' }, h);
    await post(t.app, '/v1/check/phone', { phone: '0912345678' }, internal('org_other'));

    const list = await json<{ data: { id: string; kind: string; inputPreview: string | null }[] }>(
      await t.app.request('/v1/checks', { headers: h }),
    );
    expect(list.data.map((d) => d.kind)).toEqual(['url', 'text', 'text']);
    expect(list.data[0]!.inputPreview).toBe('vietcombank-xacthuc.com');

    const redacted = await json<Verdict>(
      await t.app.request(`/v1/checks/${list.data[2]!.id}`, { headers: h }),
    );
    expect(redacted.input).toBe('[redacted]');
    expect(JSON.stringify(redacted)).not.toContain('5 triệu');
    expect(redacted.entities).toBeUndefined();

    const kept = await json<Verdict>(await t.app.request(`/v1/checks/${list.data[1]!.id}`, { headers: h }));
    expect(kept.input).toBe('Tin nhắn tôi muốn lưu lại');

    const rows = await t.handle.query<{ input_raw: string | null; input_hash: string }>(
      'SELECT input_raw, input_hash FROM safe.checks WHERE kind = $1 ORDER BY created_at',
      ['text'],
    );
    expect(rows[0]!.input_raw).toBeNull();
    expect(rows[0]!.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[1]!.input_raw).toBe('Tin nhắn tôi muốn lưu lại');

    expect((await t.app.request('/v1/checks')).status).toBe(401);
    expect(
      (await t.app.request(`/v1/checks/${list.data[0]!.id}`, { headers: internal('org_other') })).status,
    ).toBe(404);
  });

  it('admin routes require the internal token', async () => {
    expect((await t.app.request('/admin/reports')).status).toBe(401);
    expect(
      (await t.app.request('/admin/reports', { headers: { authorization: 'Bearer wrong-token-0000000000' } }))
        .status,
    ).toBe(401);
    expect((await t.app.request('/admin/reports', { headers: admin })).status).toBe(200);
  });

  it('admin can add an official domain at runtime', async () => {
    const res = await t.app.request('/admin/brands/vietcombank', {
      method: 'PUT',
      headers: { ...admin, 'content-type': 'application/json' },
      body: JSON.stringify({ officialDomains: ['vcb-moi.vn'] }),
    });
    expect(res.status).toBe(200);
    const v = await json<Verdict>(await post(t.app, '/v1/check/url', { url: 'https://www.vcb-moi.vn' }));
    expect(v.level).toBe('safe');
  });
});

describe('Telegram bot webhook', () => {
  let t: TestSafe;
  const secret = 'tg-secret-123';
  const update = (text: string, chatType: 'private' | 'group' = 'private', id = 42) => ({
    update_id: 1,
    message: { message_id: 7, chat: { id, type: chatType }, from: { id: 1 }, text },
  });
  const send = (body: unknown, s = secret) =>
    t.app.request('/channels/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': s },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    t = await setupSafe({
      env: { TELEGRAM_WEBHOOK_SECRET: secret, SAFE_TELEGRAM_DAILY_CHECKS: '3' },
      resolver: fakeResolver({}),
      transport: fakeTransport({}),
    });
  });
  afterAll(() => t.close());

  it('rejects requests without the secret token; 404 when not configured', async () => {
    expect((await send(update('hi'), 'wrong')).status).toBe(401);
    const t2 = await setupSafe();
    try {
      expect((await t2.app.request('/channels/telegram', { method: 'POST', body: '{}' })).status).toBe(404);
    } finally {
      await t2.close();
    }
  });

  it('answers /start with a Vietnamese welcome', async () => {
    const r = await json<{ method: string; chat_id: number; text: string; parse_mode: string }>(
      await send(update('/start')),
    );
    expect(r).toMatchObject({ method: 'sendMessage', chat_id: 42, parse_mode: 'HTML' });
    expect(r.text).toContain('Chào bạn');
  });

  it('replies to a forwarded scam message with emoji level, reasons and advice; links defanged', async () => {
    const r = await json<{
      text: string;
      reply_parameters: { message_id: number };
      link_preview_options: { is_disabled: boolean };
    }>(
      await send(
        update(
          'Vietcombank: Tai khoan cua quy khach da bi tam khoa. Xac thuc ngay tai https://vietcombank-xacthuc.com trong 24h.',
        ),
      ),
    );
    expect(r.text).toMatch(/^(🔴|🟠) <b>(RẤT NGUY HIỂM|NGUY HIỂM)<\/b> \(\d+\/100\)/);
    expect(r.text).toContain('<b>Dấu hiệu chính:</b>');
    expect(r.text).toContain('<b>Bạn nên:</b>');
    expect(r.text).not.toMatch(/https?:\/\/vietcombank-xacthuc\.com/);
    expect(r.reply_parameters.message_id).toBe(7);
    expect(r.link_preview_options.is_disabled).toBe(true);
  });

  it('routes a bare phone number to the phone check and a link to the URL check', async () => {
    const phone = await json<{ text: string }>(await send(update('0912345678')));
    expect(phone.text).toContain('CHƯA PHÁT HIỆN DẤU HIỆU LỪA ĐẢO');
    const link = await json<{ text: string }>(await send(update('vcb-digibank.top')));
    expect(link.text).toMatch(/NGUY HIỂM/);
    expect(link.text).not.toContain('vcb-digibank.top');
    expect(link.text).toContain('vcb-digibank[.]top');
  });

  it('ignores group chatter unless /check is used; screenshot without caption gets guidance', async () => {
    expect(await json(await send(update('chào cả nhà', 'group', -100)))).toEqual({ ok: true });
    const r = await json<{ text: string }>(
      await send(
        update('/check Chúc mừng bạn đã trúng thưởng iPhone, nộp phí 500k để nhận quà', 'group', -100),
      ),
    );
    expect(r.text).toContain('Dấu hiệu chính');
    const photo = await json<{ text: string }>(
      await send({
        update_id: 2,
        message: { message_id: 8, chat: { id: 42, type: 'private' }, photo: [{}] },
      }),
    );
    expect(photo.text).toContain('chưa đọc được chữ trong ảnh');
  });

  it('answers politely when the chat hits its daily limit', async () => {
    const r = await json<{ text: string }>(await send(update('Chào bạn')));
    expect(r.text).toContain('hết 3 lượt');
  });

  it('formats replies within Telegram limits', () => {
    const v: Verdict = {
      id: 'chk_x',
      kind: 'text',
      input: 'x',
      score: 92,
      level: 'critical',
      summary: { vi: 's', en: 's' },
      signals: [
        {
          id: 'a',
          label: { vi: 'Giả mạo <b>ngân hàng</b> tại evil.top', en: 'x' },
          weight: 70,
          source: 'rules',
        },
      ],
      recommendations: { vi: ['Đừng chuyển tiền'], en: ['x'] },
      shareText: { vi: 's', en: 's' },
      sources: [],
      details: { scammerGoal: { vi: 'Lấy mã OTP', en: 'x' } },
      checkedAt: new Date().toISOString(),
      cached: false,
    };
    const text = formatTelegramReply(v);
    expect(text).toContain('&lt;b&gt;ngân hàng&lt;/b&gt;');
    expect(text).toContain('evil[.]top');
    expect(text).toContain('<b>Kẻ gian muốn:</b> Lấy mã OTP');
    expect(text.length).toBeLessThanOrEqual(4000);
  });
});
