import { createDb, type DbHandle } from '@minh/db';
import { createLogger, errorHandler } from '@minh/shared';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Billing } from './billing';
import { walletRoutes } from './billing-routes';
import { Core } from './core';

let handle: DbHandle;
let core: Core;
let billing: Billing;
const onTopupPaid = vi.fn();
const internalToken = 'internal-token-for-tests-123';
const sepayApiKey = 'sepay-secret';

beforeAll(async () => {
  handle = await createDb('memory://');
  core = new Core(handle);
  await core.migrate();
  billing = new Billing(core, {
    vndPerUsd: 25_000,
    bank: { bankId: '970436', accountNo: '0123456789', accountName: 'CONG TY MINH AI' },
    onTopupPaid,
  });
});
afterAll(() => handle.close());

function app() {
  const a = new Hono();
  a.onError(errorHandler(createLogger('test')));
  a.route('/', walletRoutes(core, billing, { internalToken, sepayApiKey }));
  return a;
}
const asOrg = (orgId: string) => ({
  authorization: `Bearer ${internalToken}`,
  'x-org-id': orgId,
  'content-type': 'application/json',
});
const sepay = (body: unknown, key = sepayApiKey) =>
  app().request('/webhooks/sepay', {
    method: 'POST',
    headers: { authorization: `Apikey ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('VietQR top-ups', () => {
  it('creates a QR, credits on the bank webhook exactly once, and reports the balance in VND', async () => {
    const org = await core.createOrg('Shop An');
    const res = await app().request('/v1/wallet/topups', {
      method: 'POST',
      headers: asOrg(org.id),
      body: JSON.stringify({ amountVnd: 200_000 }),
    });
    expect(res.status).toBe(201);
    const topup = (await res.json()) as {
      id: string;
      code: string;
      qrImageUrl: string;
      creditMicros: number;
    };
    expect(topup.code).toMatch(/^MINH[A-Z2-9]{8}$/);
    expect(topup.creditMicros).toBe(8_000_000); // 200k VND at 25k/USD = $8
    expect(topup.qrImageUrl).toContain('img.vietqr.io/image/970436-0123456789-compact2.png');
    expect(topup.qrImageUrl).toContain(`addInfo=${topup.code}`);

    // Banks often mangle the description: lowercase, extra words, no spaces.
    const transfer = {
      id: 92704,
      transferType: 'in',
      transferAmount: 200_000,
      content: `MBVCB.123 ${topup.code.toLowerCase()} chuyen tien`,
      gateway: 'Vietcombank',
    };
    expect((await sepay(transfer)).status).toBe(200);
    expect((await sepay(transfer)).status).toBe(200); // SePay retry
    expect(await core.getBalance(org.id)).toBe(8_000_000);
    expect(onTopupPaid).toHaveBeenCalledTimes(1);

    const status = (await (
      await app().request(`/v1/wallet/topups/${topup.id}`, { headers: asOrg(org.id) })
    ).json()) as {
      status: string;
    };
    expect(status.status).toBe('paid');

    const wallet = (await (await app().request('/v1/wallet', { headers: asOrg(org.id) })).json()) as {
      balanceVnd: number;
      creditsExpire: boolean;
    };
    expect(wallet.balanceVnd).toBe(200_000);
    expect(wallet.creditsExpire).toBe(false);
  });

  it('credits what actually arrived at the locked rate, and records unmatched transfers', async () => {
    const org = await core.createOrg('Shop Binh');
    const topup = await billing.createTopup(org.id, 100_000);
    await sepay({ id: 'a1', transferType: 'in', transferAmount: 150_000, content: topup.code });
    expect(await core.getBalance(org.id)).toBe(6_000_000);

    const unmatched = (await (
      await sepay({ id: 'a2', transferType: 'in', transferAmount: 50_000, content: 'no code' })
    ).json()) as {
      outcome: { status: string };
    };
    expect(unmatched.outcome.status).toBe('unmatched');
    const ignored = (await (
      await sepay({ id: 'a3', transferType: 'out', transferAmount: 50_000, content: topup.code })
    ).json()) as {
      outcome: { status: string };
    };
    expect(ignored.outcome.status).toBe('ignored');
  });

  it('rejects bad webhook keys and out-of-range amounts', async () => {
    const org = await core.createOrg('Shop Chi');
    expect((await sepay({ id: 1, transferType: 'in', transferAmount: 1 }, 'wrong')).status).toBe(401);
    const res = await app().request('/v1/wallet/topups', {
      method: 'POST',
      headers: asOrg(org.id),
      body: JSON.stringify({ amountVnd: 5_000 }),
    });
    expect(res.status).toBe(400);
  });

  it('forecasts days of balance left from recent spend', async () => {
    const org = await core.createOrg('Shop Dung', 7_000_000);
    await core.debit(org.id, 700_000, { product: 'gateway' }); // 7 days avg = 100k µUSD/day
    const summary = await billing.walletSummary(org.id);
    expect(summary.avgDailySpendMicros).toBe(100_000);
    expect(summary.forecastDaysLeft).toBe(63);
  });

  it('validates and stores the e-invoice profile', async () => {
    const org = await core.createOrg('Cong ty E');
    const bad = await app().request('/v1/billing/profile', {
      method: 'PUT',
      headers: asOrg(org.id),
      body: JSON.stringify({ taxCode: '12ab' }),
    });
    expect(bad.status).toBe(400);
    const ok = await app().request('/v1/billing/profile', {
      method: 'PUT',
      headers: asOrg(org.id),
      body: JSON.stringify({
        taxCode: '0312345678',
        companyName: 'Công ty TNHH E',
        invoiceEmail: 'ketoan@e.vn',
      }),
    });
    expect(((await ok.json()) as { taxCode: string }).taxCode).toBe('0312345678');
  });
});

describe('wallet config and filters', () => {
  it('exposes public config without auth, bank details on top-ups, and filters entries by product', async () => {
    const cfg = (await (await app().request('/v1/wallet/config')).json()) as {
      topupsEnabled: boolean;
      vndPerUsd: number;
    };
    expect(cfg).toMatchObject({ topupsEnabled: true, vndPerUsd: 25_000, creditsExpire: false });

    const org = await core.createOrg('Shop Filter', 1_000_000);
    await core.debit(org.id, 100, { product: 'safe' });
    await core.debit(org.id, 200, { product: 'gateway' });
    const res = await app().request('/v1/wallet/entries?product=safe', { headers: asOrg(org.id) });
    const { data } = (await res.json()) as { data: { product: string }[] };
    expect(data.map((e) => e.product)).toEqual(['safe']);
    expect((await app().request('/v1/wallet/entries?product=nope', { headers: asOrg(org.id) })).status).toBe(
      400,
    );

    const created = await app().request('/v1/wallet/topups', {
      method: 'POST',
      headers: asOrg(org.id),
      body: JSON.stringify({ amountVnd: 100_000 }),
    });
    expect(((await created.json()) as { bank: { accountNo: string } }).bank.accountNo).toBe('0123456789');
  });
});
