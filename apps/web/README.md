# Web console + landing (`@minh/web`, port 3000)

Next.js 16 (App Router, React 19, server components and server actions), Tailwind CSS v4,
TypeScript strict. Vietnamese first with an English toggle; money in đồng first, USD second.

- **Public**: landing, model catalog with prices, free scam checker, sign-in/sign-up, GitHub link page.
- **Console** (signed in): overview, wallet & VietQR top-ups, API keys, Gateway (usage, request log
  with receipts, provider health, playground), Agents (employees, chat, integrations & per-tool
  trust, approvals, tasks, reports, usage), Safe (history, business API), Review (installations,
  reviews with Critic-rejected findings, per-repo settings), settings.

## Run

```bash
pnpm install
pnpm --filter @minh/web dev                       # http://localhost:3000, DATABASE_URL defaults to memory://
pnpm --filter @minh/web build && pnpm --filter @minh/web start
pnpm --filter @minh/web typecheck
pnpm --filter @minh/web test                      # vitest: formatting, i18n, input detection, service client, SSE…
```

`memory://` works for a single process (the browser session lives in the web's own in-memory
database). **For the console to show real wallets, keys and usage, the web and every service must
share one Postgres**:

```bash
export DATABASE_URL=postgres://minh:minh@localhost:5432/minh INTERNAL_TOKEN=<same secret as the services>
(cd apps/gateway && pnpm dev) & (cd apps/agents && pnpm dev) & (cd apps/safe && pnpm dev) & (cd apps/review && pnpm dev) &
WELCOME_CREDIT_MICROS=1000000 pnpm --filter @minh/web dev
```

Docker (standalone output, build from the repo root): `docker build -f apps/web/Dockerfile -t minh-web .`
then run with the env below; `node apps/web/server.js` listens on `PORT` (3000).

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `memory://` | Same Postgres as the services (sessions, orgs, keys and the wallet ledger are read directly through `@minh/core`). |
| `INTERNAL_TOKEN` | dev value | Sent to services as `Authorization: Bearer …` with `X-Org-Id`. Server-side only; never reaches the browser. A warning is logged when the dev value is used in production. |
| `GATEWAY_URL` | `http://localhost:4000` | Gateway + wallet routes (`/v1/wallet*`). A trailing `/v1` is accepted and stripped. |
| `AGENTS_URL` | `http://localhost:4100` | Agents control plane. |
| `SAFE_URL` | `http://localhost:4200` | Scam checker. |
| `REVIEW_URL` | `http://localhost:4300` | Review service. |
| `PUBLIC_API_URL` | `GATEWAY_URL` | Base URL shown to customers in curl / SDK snippets. |
| `PUBLIC_SAFE_URL` | `SAFE_URL` | Base URL shown in the Safe business-API snippet. |
| `VND_PER_USD` | `26000` | Display rate for public pages and the fallback when the gateway is down. Keep equal to the gateway's (the gateway's `/v1/wallet` rate wins in the console). |
| `WELCOME_CREDIT_MICROS` | `0` | Credit granted to each new org at sign-up (micro-USD). |
| `COOKIE_SECURE` | `true` in production | Set `false` only to test a production build over plain http on a non-localhost host. |
| `SERVICE_TIMEOUT_MS` | `15000` | Default timeout for service calls (streams and lifecycle calls use longer ones). |
| `BRAND_NAME` | `Minh AI` | Brand shown in the UI. |
| `FOUNDER_NAME`, `CONTACT_EMAIL`, `CONTACT_ZALO`, `COMPANY_TAX_CODE` | – | Trust details on the landing page / footer and the "top-ups coming soon" state. Unset founder shows a visible placeholder. |
| `NEXT_OUTPUT` | – | `standalone` for the Docker build. |

## Architecture

```
browser ──▶ Next.js (server components, server actions, app/api/* route handlers)
              │  sessions: @minh/core (signUp/login/getSession/logout) on DATABASE_URL, httpOnly cookie `minh_session`
              │  wallet reads (ledger, spend by product): @minh/core directly; e-invoice profile: @minh/core Billing
              └─ lib/services.ts (server-only) ──▶ gateway / agents / safe / review
                     Authorization: Bearer $INTERNAL_TOKEN + X-Org-Id (+ X-User-Id for Safe)
```

- **Auth**: `proxy.ts` bounces signed-out visitors of `/console`, `/billing`, `/review*` to
  `/login?next=…` (path-only, validated) and passes the path to layouts; `requireSession()`
  validates the session against the database on every console render. Cookie: httpOnly,
  `SameSite=Lax`, `Secure` in production, 30 days (= core session TTL). Core migrations run once,
  lazily, on first use (one shared handle on `globalThis`).
- **Service calls** (`lib/service-client.ts`, pure and unit-tested; bound to env in
  `lib/services.ts`): every call has a timeout; `attempt()` returns `{ ok, data } | { ok: false, error }`
  with `kind: down | timeout | http`, so pages render a calm "service not responding" state
  (`components/console.tsx → ServiceProblem`) instead of crashing. The console header computes the
  balance from the shared ledger, so it shows even when the gateway is down.
- **Browser → services** only through server actions and route handlers:
  `app/api/gateway/chat` (playground SSE proxy), `app/api/agents/[id]/chat` (agent turn SSE proxy),
  `app/api/safe/check` (public checker; signed-in users check as their org, anonymous visitors'
  IP is forwarded as `X-Forwarded-For` for Safe's per-IP free tier), `app/api/wallet/topups/[id]`
  (top-up polling). Mutating route handlers check `Origin`/`Sec-Fetch-Site`.
- **i18n** (`lib/i18n`): typed dictionaries (`vi.ts` is the source of truth; `en.ts` must match its
  shape, enforced by the type and a test), `{placeholder}` interpolation, `lang` cookie, server
  helper `getI18n()`, client hook `useI18n()`.
- **Theme**: CSS-variable tokens in `app/globals.css`; `data-theme` = `system | light | dark`
  from a cookie (no flash), toggle in the header.
- **One receipt pattern** (`components/console.tsx → Receipt`): what ran, model/provider, đồng
  cost (+USD), when, reference — used for gateway requests, ledger entries, review runs; Safe's
  "how we decided" panel and agent turn lines follow the same idea.
- **Formatting** (`lib/format.ts`): `200.000đ` / `₫200,000`, fractional đồng for per-request costs
  (`0,16đ` instead of a misleading `0đ`), Vietnam time zone for every date, `parseVndInput` accepts
  `200k`, `1,5tr`, `200.000`.

## Page map

| Path | What |
|---|---|
| `/` | Landing: promise, four products, commitments (credits never expire, VietQR, e-invoice, caps on by default, receipts, founder + shutdown pledge draft) |
| `/models` | Public model catalog from `GET /v1/models` (search, capability filters, VND+USD per 1M tokens, providers, "Chưa kiểm chứng" badges) |
| `/safe` | Public scam checker: smart input (link / phone / account / email / message, overridable), image/video/audio upload, verdict card in the API's own wording, red flags, what to do, "Đã lỡ chuyển tiền?" steps for high/critical, share (copy, Zalo), "how we decided", report form, weekly stats |
| `/login`, `/signup` | Accounts (`?next=` supported) |
| `/review/link?installation_id=…[&state=…]` | Link a GitHub installation to the signed-in org (target of the review bot's PR comment) |
| `/review?linked=…`, `/billing` | Aliases → `/console/review`, `/console/billing` |
| `/console` | Overview: balance + "đủ dùng khoảng N ngày", spend by product and by day (30 days, from the ledger), quick actions, first-call curl, recent activity |
| `/console/billing` | VietQR top-up (presets 100k–5tr or custom, QR + bank/account/amount/code with copy, locked rate, polling → "Đã nhận 200.000đ"), top-up history, ledger with product filter and per-entry receipt, e-invoice profile, wallet policy |
| `/console/keys` | Create (name, product scopes, spending cap on by default at 500.000đ), show once with a ready curl, list (prefix, scopes, last used, spent/cap), change/remove cap, revoke with confirmation |
| `/console/gateway` | Usage (totals, cost per day chart, by model/provider/product/key) |
| `/console/gateway/requests[/:id]` | Request log; receipt with requested vs answering model, provider, tokens, đồng cost, latency/TTFT, routing reason, every fallback attempt |
| `/console/gateway/playground` | Streaming chat (model picker incl. `auto`), per-message model · provider · cost · tokens · routing reason, link to the receipt |
| `/console/gateway/providers` | Live endpoint health (circuit, success rate, p50/p95, TTFT, tokens/s), mock-provider notice |
| `/console/agents` | Employees, plans |
| `/console/agents/new` | Create from Vietnamese JD templates (customer service, order lookup, payment reminders, blank), model, plan, monthly budget (on by default), reports-to |
| `/console/agents/:id` | Status + lifecycle (start/stop/restart/delete), usage vs included tokens and budget; tabs: test chat (streaming, tool calls with outcome, AI disclosure, per-turn receipt), integrations with per-tool trust levels (off/draft/approve/auto) and credentials, knowledge upload, settings (JD, model, budget, inbound open/allowlist, AI disclosure), activity |
| `/console/agents/approvals` | Approvals inbox: exact tool + arguments, approve/reject with a note, recent decisions |
| `/console/agents/tasks`, `/reports`, `/usage` | Task board, daily summaries/reports, per-agent usage and budgets |
| `/console/safe[/checks/:id]` | Check history (hashes only), business-API price list, spend, curl |
| `/console/review[/:id]` | Install button, linked installations & repos, reviews (status, findings by severity, đồng cost, duration); detail with posted findings **and** Critic-rejected ones with reasons, receipt, re-run |
| `/console/review/repos/:owner/:repo` | Per-repo settings override |
| `/console/settings` | Org name, members (read-only), language |

## Known gaps

- Key spending caps in `@minh/core` are **lifetime** (`spentMicros ≥ spendLimitMicros`), not
  monthly; the UI says so. Changing a cap and renaming an org write the `core` tables directly
  (`lib/keys.ts`, `lib/org.ts`) until `Core.updateApiKey()` / `Core.renameOrg()` exist.
- Whether VietQR top-ups are configured is only known when creating one (503 `unavailable` →
  "coming soon" state). The bank account shown next to the QR is parsed from the VietQR image URL.
- E-invoices: the profile is stored; issuing invoices is not implemented anywhere yet.
- The public pages use `VND_PER_USD` from the web's env (no public rate endpoint).
- Members are read-only (no invitations); one user per org today.
- No rate limiting of sign-in attempts in the web itself.
- Agents' tool approvals from the console only (no Zalo approval cards yet).
- English plurals are simplified in a few places.
