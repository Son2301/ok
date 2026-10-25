import { AppError, parseJson } from '@ok/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Billing, Topup } from './billing';
import type { Core } from './core';
import { safeEqual } from './crypto';
import { type AuthEnv, authMiddleware, getAuth } from './middleware';

export interface WalletRoutesOptions {
  internalToken: string;
  /** SePay webhook API key (SePay sends `Authorization: Apikey <key>`). Webhook is disabled when unset. */
  sepayApiKey?: string;
}

const topupSchema = z.object({ amountVnd: z.number().int().positive() });
const profileSchema = z.object({
  taxCode: z.string().trim().max(20).nullish(),
  companyName: z.string().trim().max(300).nullish(),
  address: z.string().trim().max(500).nullish(),
  invoiceEmail: z.string().trim().email().nullish(),
});
const sepaySchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    transferType: z.enum(['in', 'out']),
    transferAmount: z.coerce.number(),
    content: z.string().nullish(),
    code: z.string().nullish(),
    referenceCode: z.string().nullish(),
    accountNumber: z.string().nullish(),
    transactionDate: z.string().nullish(),
    gateway: z.string().nullish(),
  })
  .passthrough();

/**
 * Platform wallet API, mounted by the gateway (the public API host):
 *   GET  /v1/wallet                 balance in µUSD and VND + run-out forecast
 *   GET  /v1/wallet/entries         ledger
 *   POST /v1/wallet/topups          create a VietQR top-up
 *   GET  /v1/wallet/topups[/:id]    top-up status (poll until `paid`)
 *   GET|PUT /v1/billing/profile     e-invoice details (mã số thuế, company)
 *   POST /webhooks/sepay            bank-feed webhook (no customer auth)
 */
export function walletRoutes(core: Core, billing: Billing, opts: WalletRoutesOptions) {
  const app = new Hono<AuthEnv>();

  app.post('/webhooks/sepay', async (c) => {
    if (!opts.sepayApiKey) throw new AppError('unavailable', 'Bank webhook is not configured');
    const header = c.req.header('authorization') ?? '';
    const key = header.replace(/^Apikey\s+/i, '').trim();
    if (!key || !safeEqual(key, opts.sepayApiKey)) throw new AppError('unauthorized', 'Invalid webhook key');
    const transfer = await parseJson(c, sepaySchema);
    const outcome = await billing.handleSepayTransfer(transfer);
    return c.json({ success: true, outcome }, 200);
  });

  const auth = authMiddleware(core, { internalToken: opts.internalToken });
  app.use('/v1/wallet', auth);
  app.use('/v1/wallet/*', auth);
  app.use('/v1/billing/*', auth);

  const view = (t: Topup) => ({
    id: t.id,
    status: t.status,
    amountVnd: t.amountVnd,
    code: t.code,
    vndPerUsd: t.vndPerUsd,
    creditMicros: billing.vndToMicros(t.amountVnd, t.vndPerUsd),
    receivedVnd: t.receivedVnd,
    creditedMicros: t.creditedMicros,
    qrImageUrl: billing.qrImageUrl(t),
    expiresAt: t.expiresAt,
    paidAt: t.paidAt,
    createdAt: t.createdAt,
  });

  app.get('/v1/wallet', async (c) => c.json(await billing.walletSummary(getAuth(c).orgId)));

  app.get('/v1/wallet/entries', async (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    const before = c.req.query('before');
    const entries = await core.listWalletEntries(getAuth(c).orgId, {
      limit: Number.isFinite(limit) ? limit : 50,
      before: before ? new Date(before) : undefined,
    });
    return c.json({ data: entries });
  });

  app.post('/v1/wallet/topups', async (c) => {
    const { amountVnd } = await parseJson(c, topupSchema);
    const topup = await billing.createTopup(getAuth(c).orgId, amountVnd);
    return c.json(view(topup), 201);
  });

  app.get('/v1/wallet/topups', async (c) =>
    c.json({ data: (await billing.listTopups(getAuth(c).orgId)).map(view) }),
  );
  app.get('/v1/wallet/topups/:id', async (c) =>
    c.json(view(await billing.getTopup(getAuth(c).orgId, c.req.param('id')))),
  );

  app.get('/v1/billing/profile', async (c) => c.json((await billing.getProfile(getAuth(c).orgId)) ?? {}));
  app.put('/v1/billing/profile', async (c) => {
    const body = await parseJson(c, profileSchema);
    return c.json(await billing.setProfile(getAuth(c).orgId, body));
  });

  return app;
}
