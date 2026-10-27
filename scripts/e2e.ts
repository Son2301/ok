/**
 * Cross-service smoke test against the running stack (`pnpm dev` in another terminal):
 *   pnpm dev:check
 * Reads DATABASE_URL, INTERNAL_TOKEN, SEPAY_API_KEY and PLATFORM_ORG_ID from .env / the environment.
 * Expects: gateway :4000, agents :4100, safe :4200, review :4300, all on the same Postgres.
 */
import { Core } from '@minh/core';
import { createDb } from '@minh/db';
import { loadEnv } from './dev/lib';

const env = loadEnv();

const GW = 'http://localhost:4000';
const AGENTS = 'http://localhost:4100';
const SAFE = 'http://localhost:4200';
const REVIEW = 'http://localhost:4300';
const internal = env.INTERNAL_TOKEN!;
const platformOrg = env.PLATFORM_ORG_ID ?? env.PLATFORM_ORG ?? 'org_platform';
const sepayKey = env.SEPAY_API_KEY ?? 'sepay-e2e';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (!ok) failures++;
  console.log(
    `${ok ? '✔' : '✘'} ${name}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 400)}` : ''}`,
  );
}
async function j(res: Response) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const handle = await createDb(env.DATABASE_URL);
const core = new Core(handle);
const email = `e2e+${Date.now()}@example.com`;
const { org } = await core.signUp({ email, password: 'correct horse battery', name: 'E2E Shop' });
const { key } = await core.createApiKey(org.id, { name: 'e2e', spendLimitMicros: 5_000_000 });
const asOrg = { authorization: `Bearer ${internal}`, 'x-org-id': org.id, 'content-type': 'application/json' };
const asKey = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

// 1. Wallet: VietQR top-up credited by the bank webhook, visible from any product.
{
  const topup = await j(
    await fetch(`${GW}/v1/wallet/topups`, {
      method: 'POST',
      headers: asKey,
      body: JSON.stringify({ amountVnd: 260_000 }),
    }),
  );
  check('wallet: top-up QR created', typeof topup.qrImageUrl === 'string' && /^MINH/.test(topup.code), topup);
  const hook = await fetch(`${GW}/webhooks/sepay`, {
    method: 'POST',
    headers: { authorization: `Apikey ${sepayKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: Date.now(),
      transferType: 'in',
      transferAmount: 260_000,
      content: `CK ${topup.code}`,
    }),
  });
  check('wallet: SePay webhook accepted', hook.status === 200, await j(hook));
  const wallet = await j(await fetch(`${GW}/v1/wallet`, { headers: asOrg }));
  check('wallet: balance reflects top-up in VND', wallet.balanceVnd === 260_000, wallet);
}

// 2. Gateway: chat via API key (mock provider), billed to the wallet with a receipt.
{
  const res = await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: asKey,
    body: JSON.stringify({
      model: 'auto',
      messages: [{ role: 'user', content: 'Xin chào, tóm tắt giúp mình đơn hàng hôm nay' }],
    }),
  });
  const body = await j(res);
  check('gateway: auto-routed chat completion', res.status === 200 && !!body.choices?.[0]?.message, body);
  check('gateway: response names provider + routing reason', !!body.provider && !!body.routing?.reason, {
    provider: body.provider,
    routing: body.routing,
  });
  const gen = await j(await fetch(`${GW}/v1/generation/${body.id}`, { headers: asKey }));
  check('gateway: generation receipt available', gen.id === body.id || gen.data?.id === body.id, gen);

  const stream = await fetch(`${GW}/v1/chat/completions`, {
    method: 'POST',
    headers: asKey,
    body: JSON.stringify({
      model: 'auto',
      stream: true,
      messages: [{ role: 'user', content: 'stream please' }],
    }),
  });
  const sse = await stream.text();
  check(
    'gateway: streaming ends with [DONE]',
    stream.status === 200 && sse.trim().endsWith('data: [DONE]'),
    sse.slice(-200),
  );
}

// 3. Agents: create an AI employee and chat; its LLM calls go through the gateway.
{
  const created = await j(
    await fetch(`${AGENTS}/v1/agents`, {
      method: 'POST',
      headers: asOrg,
      body: JSON.stringify({
        name: 'Lan',
        role: 'CSKH',
        jobDescription: 'Trả lời khách hàng của shop một cách lịch sự.',
      }),
    }),
  );
  const agentId = created.id ?? created.data?.id;
  check('agents: agent created', typeof agentId === 'string', created);
  const deploy = await fetch(`${AGENTS}/v1/agents/${agentId}/deploy`, { method: 'POST', headers: asOrg });
  check('agents: deployed (inline driver)', deploy.ok, await j(deploy));
  const reply = await j(
    await fetch(`${AGENTS}/v1/agents/${agentId}/messages`, {
      method: 'POST',
      headers: asOrg,
      body: JSON.stringify({ message: 'Shop ơi đơn của mình tới đâu rồi?', userId: 'khach-1' }),
    }),
  );
  check(
    'agents: agent replied via gateway',
    typeof (reply.reply ?? reply.message?.content ?? reply.text) === 'string',
    reply,
  );
}

// 4. Safe: anonymous scam check with Vietnamese wording and a forwardable share card.
{
  const res = await fetch(`${SAFE}/v1/check/text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'Công an phường thông báo: tài khoản định danh VNeID của bạn bị khóa, truy cập vneid-capnhat.top và cung cấp mã OTP để mở lại trong 24h.',
    }),
  });
  const v = await j(res);
  check(
    'safe: scam message scored high/critical',
    res.status === 200 && ['high', 'critical'].includes(v.level),
    { level: v.level, score: v.score },
  );
  check(
    'safe: Vietnamese summary + shareText + first-hour guide',
    !!v.summary?.vi && !!v.shareText?.vi && !!v.ifAlreadyPaid,
    Object.keys(v),
  );
  const benign = await j(
    await fetch(`${SAFE}/v1/check/text`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Tối nay cả nhà ăn cơm lúc 7h nhé, mẹ nấu canh chua.' }),
    }),
  );
  check(
    'safe: benign message stays low and never says "an toàn"',
    ['safe', 'low', 'unknown'].includes(benign.level) && !/an toàn/i.test(benign.summary?.vi ?? ''),
    benign.summary,
  );
  const paid = await fetch(`${SAFE}/v1/check/url`, {
    method: 'POST',
    headers: asKey,
    body: JSON.stringify({ url: 'https://vietcombank-xacthuc.com/login' }),
  });
  const pv = await j(paid);
  check('safe: API-key URL check flags brand impersonation', paid.status === 200 && pv.score >= 50, {
    level: pv.level,
    score: pv.score,
  });
}

// 5. Review: console API reachable with internal auth; webhook says not configured.
{
  const res = await fetch(`${REVIEW}/v1/reviews`, { headers: asOrg });
  check('review: console API authorised', res.status === 200, await j(res));
  const hook = await fetch(`${REVIEW}/github/webhook`, { method: 'POST', body: '{}' });
  check('review: webhook reports not configured (503)', hook.status === 503);
}

// 6. One ledger across products.
{
  const entries = await core.listWalletEntries(org.id, { limit: 100 });
  const products = new Set(entries.map((e) => e.product).filter(Boolean));
  check('ledger: gateway + safe usage on one wallet', products.has('gateway') && products.has('safe'), [
    ...products,
  ]);
  const balance = await core.getBalance(org.id);
  check('ledger: balance decreased from top-up after usage', balance < 10_000_000, balance);
  const platformSpend = await core.listWalletEntries(platformOrg, { limit: 50 });
  console.log(
    `  platform org entries: ${platformSpend.length}, customer entries: ${entries.length}, products: ${[...products].join(', ')}`,
  );
}

await handle.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll cross-service checks passed');
process.exit(failures ? 1 : 0);
