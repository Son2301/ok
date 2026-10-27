import { Billing } from '@minh/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, get, type Harness, post } from './test/helpers';

let h: Harness;

beforeAll(async () => {
  h = await createHarness({
    models: [],
    providers: [],
    wallet: (core) => ({
      billing: new Billing(core, {
        vndPerUsd: 26_000,
        bank: { bankId: 'vietcombank', accountNo: '0071000123456', accountName: 'MINH AI' },
      }),
      sepayApiKey: 'sepay-test-key',
    }),
  });
});
afterAll(() => h.close());

describe('platform wallet on the gateway host', () => {
  it('lets any product key read the shared wallet, while gateway routes stay scoped', async () => {
    const { key } = await h.account(2_600_000, ['safe']);
    const wallet = await get(h.app, '/v1/wallet', key);
    expect(wallet.status).toBe(200);
    expect(((await wallet.json()) as { balanceVnd: number }).balanceVnd).toBe(67_600);
    expect((await get(h.app, '/v1/requests', key)).status).toBe(403);
  });

  it('creates a top-up and credits it from the bank webhook end to end', async () => {
    const { key, orgId } = await h.account(0, ['gateway']);
    const created = await post(h.app, '/v1/wallet/topups', key, { amountVnd: 260_000 });
    expect(created.status).toBe(201);
    const topup = (await created.json()) as { id: string; code: string };
    const hook = await h.app.request('/webhooks/sepay', {
      method: 'POST',
      headers: { authorization: 'Apikey sepay-test-key', 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 1,
        transferType: 'in',
        transferAmount: 260_000,
        content: `NAP ${topup.code}`,
      }),
    });
    expect(hook.status).toBe(200);
    expect(await h.core.getBalance(orgId)).toBe(10_000_000);
  });
});
