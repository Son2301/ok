/**
 * Simulate the bank transfer for a VietQR top-up (local only):
 *   pnpm dev:pay                 # pays the most recent pending top-up in full
 *   pnpm dev:pay MINHA7F3K2QX     # a specific transfer code
 *   pnpm dev:pay MINHA7F3K2QX 150000   # a different amount (over/under-payment)
 * It sends the same webhook SePay would send to the gateway.
 */
import { coreSchema } from '@minh/core';
import { createDb } from '@minh/db';
import { desc, eq } from 'drizzle-orm';
import { c, isLocalDatabase, loadEnv, log, PORTS } from './lib';

const env = loadEnv();
const [codeArg, amountArg] = process.argv.slice(2).filter((a) => a !== '--');
if (!env.DATABASE_URL || !isLocalDatabase(env.DATABASE_URL)) {
  log.fail('dev:pay only runs against a local database.');
  process.exit(1);
}
if (!env.SEPAY_API_KEY) {
  log.fail('SEPAY_API_KEY is not set in .env (run `pnpm dev:setup`).');
  process.exit(1);
}

const handle = await createDb(env.DATABASE_URL);
const t = coreSchema.topups;
const [topup] = codeArg
  ? await handle.db.select().from(t).where(eq(t.code, codeArg.toUpperCase()))
  : await handle.db.select().from(t).where(eq(t.status, 'pending')).orderBy(desc(t.createdAt)).limit(1);
await handle.close();

if (!topup) {
  log.fail(
    codeArg
      ? `No top-up with code ${codeArg}.`
      : 'No pending top-up. Create one in the console (Ví & thanh toán → Nạp tiền) first.',
  );
  process.exit(1);
}
const amount = amountArg ? Number(amountArg) : topup.amountVnd;
const res = await fetch(`http://localhost:${PORTS.gateway}/webhooks/sepay`, {
  method: 'POST',
  headers: { authorization: `Apikey ${env.SEPAY_API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    id: `dev-${Date.now()}`,
    gateway: 'Vietcombank',
    transactionDate: new Date().toISOString(),
    accountNumber: env.TOPUP_BANK_ACCOUNT_NO,
    transferType: 'in',
    transferAmount: amount,
    content: `MBVCB.${Date.now()} ${topup.code} chuyen tien nap vi`,
  }),
}).catch((err: Error) => {
  log.fail(`Gateway not reachable on :${PORTS.gateway} (${err.message}). Is \`pnpm dev\` running?`);
  process.exit(1);
});
const body = (await res.json()) as { outcome?: { status: string } };
if (res.ok && body.outcome?.status === 'credited') {
  log.ok(
    `Paid ${c.bold(`${amount.toLocaleString('vi-VN')}đ`)} for ${c.bold(topup.code)}. The console updates within a few seconds.`,
  );
} else {
  log.fail(`Webhook answered ${res.status}: ${JSON.stringify(body)}`);
  process.exit(1);
}
