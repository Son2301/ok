import { createDb, type DbHandle } from '@ok/db';
import { createLogger, errorHandler } from '@ok/shared';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Core } from './core';
import { type AuthEnv, authMiddleware, getAuth } from './middleware';

let handle: DbHandle;
let core: Core;

beforeAll(async () => {
  handle = await createDb('memory://');
  core = new Core(handle, { welcomeCreditMicros: 1_000_000 });
  await core.migrate();
});
afterAll(() => handle.close());

describe('accounts', () => {
  it('signs up, logs in and resolves sessions', async () => {
    const { user, org } = await core.signUp({
      email: 'An@Example.com',
      password: 'hunter2hunter2',
      name: 'An',
    });
    expect(user.email).toBe('an@example.com');
    expect(await core.getBalance(org.id)).toBe(1_000_000);
    await expect(core.signUp({ email: 'an@example.com', password: 'xxxxxxxxxx' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(core.login('an@example.com', 'wrong-password')).rejects.toMatchObject({
      code: 'unauthorized',
    });
    const { token } = await core.login('an@example.com', 'hunter2hunter2');
    const session = await core.getSession(token);
    expect(session?.org.id).toBe(org.id);
    expect(session?.role).toBe('owner');
    await core.logout(token);
    expect(await core.getSession(token)).toBeNull();
  });
});

describe('wallet', () => {
  it('credits, debits atomically and refuses overdraft unless forced', async () => {
    const org = await core.createOrg('Wallet Co', 500);
    await expect(core.debit(org.id, 600, { product: 'gateway' })).rejects.toMatchObject({
      code: 'payment_required',
    });
    expect(await core.debit(org.id, 200, { product: 'gateway', ref: 'req_1' })).toBe(300);
    expect(await core.debit(org.id, 400, { product: 'gateway', force: true })).toBe(-100);
    expect(await core.credit(org.id, 1000)).toBe(900);
    const entries = await core.listWalletEntries(org.id);
    expect(entries.map((e) => e.amountMicros)).toEqual(expect.arrayContaining([500, -200, -400, 1000]));
  });

  it('handles concurrent debits without losing updates', async () => {
    const org = await core.createOrg('Race Co', 1000);
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, () => core.debit(org.id, 100, { product: 'safe' })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    expect(await core.getBalance(org.id)).toBe(0);
  });
});

describe('api keys + middleware', () => {
  const internalToken = 'internal-token-for-tests-123';
  const makeApp = () => {
    const app = new Hono<AuthEnv>();
    app.onError(errorHandler(createLogger('test')));
    app.use('*', authMiddleware(core, { product: 'gateway', internalToken }));
    app.get('/whoami', (c) => c.json(getAuth(c)));
    return app;
  };

  it('authenticates keys, enforces scopes, revocation, spend limits and internal tokens', async () => {
    const org = await core.createOrg('Keys Co', 10_000);
    const { key, record } = await core.createApiKey(org.id, { name: 'default' });
    const { key: safeOnly } = await core.createApiKey(org.id, { name: 'safe', scopes: ['safe'] });
    const { key: capped, record: cappedRec } = await core.createApiKey(org.id, {
      name: 'capped',
      spendLimitMicros: 100,
    });
    const app = makeApp();

    const ok = await app.request('/whoami', { headers: { authorization: `Bearer ${key}` } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { orgId: string }).orgId).toBe(org.id);

    expect((await app.request('/whoami')).status).toBe(401);
    expect((await app.request('/whoami', { headers: { authorization: `Bearer ${safeOnly}` } })).status).toBe(
      403,
    );

    await core.debit(org.id, 100, { product: 'gateway', apiKeyId: cappedRec.id });
    expect((await app.request('/whoami', { headers: { authorization: `Bearer ${capped}` } })).status).toBe(
      402,
    );

    await core.revokeApiKey(org.id, record.id);
    expect((await app.request('/whoami', { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);

    const internal = await app.request('/whoami', {
      headers: { authorization: `Bearer ${internalToken}`, 'x-org-id': org.id },
    });
    expect(await internal.json()).toEqual({ orgId: org.id, via: 'internal' });
  });
});

describe('idempotent debits', () => {
  it('charges once per idempotency key, even under concurrent retries', async () => {
    const org = await core.createOrg('Idem Co', 1000);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        core.debit(org.id, 300, { product: 'gateway', idempotencyKey: 'req_abc' }),
      ),
    );
    expect(new Set(results)).toEqual(new Set([700]));
    expect(await core.getBalance(org.id)).toBe(700);
    expect(await core.debit(org.id, 300, { product: 'gateway', idempotencyKey: 'req_def' })).toBe(400);
  });
});

describe('ensureOrg', () => {
  it('creates an org with a fixed id once', async () => {
    const a = await core.ensureOrg('org_platform_test', 'Platform', 5_000);
    const b = await core.ensureOrg('org_platform_test', 'Platform', 9_999);
    expect(a.id).toBe('org_platform_test');
    expect(b.id).toBe('org_platform_test');
    expect(await core.getBalance('org_platform_test')).toBe(5_000);
  });
});

describe('org and key management', () => {
  it('renames orgs, lists members and updates key limits', async () => {
    const { org, user } = await core.signUp({
      email: 'owner@shop.vn',
      password: 'long-enough-pw',
      name: 'Chủ shop',
    });
    expect((await core.renameOrg(org.id, '  Shop Hoa  ')).name).toBe('Shop Hoa');
    const members = await core.listMembers(org.id);
    expect(members).toEqual([
      expect.objectContaining({ userId: user.id, role: 'owner', email: 'owner@shop.vn' }),
    ]);

    const { record } = await core.createApiKey(org.id, { name: 'k', spendLimitMicros: 100 });
    const updated = await core.updateApiKey(org.id, record.id, { spendLimitMicros: null, scopes: ['safe'] });
    expect(updated.spendLimitMicros).toBeNull();
    expect(updated.scopes).toEqual(['safe']);
    await expect(core.updateApiKey('org_other', record.id, { name: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
