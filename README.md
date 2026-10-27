# Minh AI

**Minh** is two Vietnamese words at once: *thông **minh*** (smart) and ***minh** bạch* (transparent). It is
also 明, written with the sun 日 and the moon 月, which is the logo. The promise: smart AI, with every đồng
accounted for.

Four AI products on **one account and one VND wallet**, built for Vietnam:

| Product | What it does | Service | Docs |
|---|---|---|---|
| **Gateway** | One OpenAI-compatible API for ~40 models across OpenAI, Anthropic, Gemini, DeepSeek, Qwen (DashScope), BytePlus, Azure and more. `model: "auto"` routing, provider preferences (price / latency / uptime), fallback across providers and models, streaming, per-request receipts. | `apps/gateway` :4000 | [README](apps/gateway/README.md) |
| **Agents** | Hosted "AI employees": job description, knowledge base, Vietnamese integrations (Zalo OA, KiotViet, Haravan, Telegram, Shopify, Google Calendar, Gmail…), one isolated container per agent, MCP for OpenClaw/Hermes, task board + org chart + reports, per-tool trust levels and approvals, budget caps. | `apps/agents` :4100 | [README](apps/agents/README.md) |
| **Safe** | Free scam checker: links, messages, phone numbers, bank accounts, emails, images/video/audio. Vietnamese scam-script rules, brand-impersonation detection, community reports, AI-media forensics. Honest wording ("never says *an toàn*"), share-with-family card, first-hour guide. Paid API for businesses. | `apps/safe` :4200 | [README](apps/safe/README.md) |
| **Review** | GitHub App that reviews pull requests in two passes: a Reviewer finds issues, an adversarial Critic tries to refute each one against the code. Only verified findings are posted, on the right line, with a failure scenario and a fix. Silent when there is nothing real. Also a CLI. | `apps/review` :4300 | [README](apps/review/README.md) |
| **Console** | Next.js landing + console for all four, Vietnamese first. | `apps/web` :3000 | [README](apps/web/README.md) |

Product strategy and the research behind it: [`reports/Micro differentiation for four AI products.md`](reports/Micro%20differentiation%20for%20four%20AI%20products.md).

## The shared platform

- **One wallet, in đồng.** Top up by VietQR bank transfer; a SePay bank-feed webhook confirms it within seconds and credits the wallet at the exchange rate shown on the QR. Credits never expire. Every product debits the same ledger, so one balance pays for gateway tokens, agent plans, Safe API checks and reviews. E-invoice profile (mã số thuế) is stored for invoicing. (`packages/core/src/billing.ts`)
- **One account.** Orgs, users, sessions and API keys with per-product scopes, spend caps and rate limits. (`packages/core`)
- **Products call models through the gateway**, so every AI call is routed, metered and attributed to the product that made it. Free tiers are funded by a platform org.

```
                 ┌──────────── apps/web (console) ────────────┐
                 │  sessions via @minh/core, services via        │
                 │  INTERNAL_TOKEN + X-Org-Id (server-side)    │
                 └──────┬──────────┬───────────┬──────────┬───┘
                        ▼          ▼           ▼          ▼
   customers ──▶  gateway :4000  agents :4100  safe :4200  review :4300 ◀── GitHub webhooks
   (API keys)     + /v1/wallet      │            │            │
                  + SePay webhook   └── LLM calls via gateway ┘
                        │
                        ▼
                 Postgres (schemas: core, gateway, agents, safe, review)
```

## Quick start

```bash
git clone https://github.com/Son2301/ok.git minh && cd minh
pnpm install
pnpm dev:setup   # .env with generated secrets, Postgres (Docker or your own), demo data
pnpm dev         # all five apps with hot reload → http://localhost:3000
```

Log in as `demo@minh.local` / `minh-demo-2026`. No AI provider keys are needed: the gateway serves an offline
mock model until you add one to `.env`. Full guide, commands and troubleshooting:
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). Setting up with Claude Code? Tell it to follow
[`docs/LOCAL_SETUP_WITH_CLAUDE.md`](docs/LOCAL_SETUP_WITH_CLAUDE.md).

```bash
pnpm test && pnpm typecheck && pnpm lint   # ~825 tests, all offline
pnpm dev:check                             # 18 end-to-end checks against the running stack
```

Production-style, all in containers: `cp .env.example .env && docker compose up --build`.

## What is and isn't verified

Everything runs and is tested offline against mocks, fixtures and local mock servers, and the four services were run together on one Postgres (`scripts/e2e.ts`). **Nothing has been exercised against live third-party APIs yet.** Before launch, verify against the real services:

- **Gateway:** every provider adapter, model id, context length and price in `apps/gateway/src/catalog/default.ts` (prices are placeholders).
- **Wallet:** SePay webhook payload and VietQR quick-link format against a real bank account; tax treatment of resold AI usage on e-invoices needs a tax adviser.
- **Agents:** Zalo OA, KiotViet, Haravan, Shopify, Google, Telegram adapters; the OpenClaw/Hermes runtime images; the Docker driver on a real daemon. MISA, Shopee and TikTok Shop are stubs (Shopee signing is implemented).
- **Safe:** Google Safe Browsing, VirusTotal, URLhaus, PhishTank/OpenPhish, RDAP, Hive, Sightengine, Reality Defender adapters.
- **Review:** the GitHub App flow against real GitHub (JWT, installation tokens, review posting).

Each service README has a detailed verified/unverified table.

## Repository layout

```
packages/shared  env, AppError, ids, logger, money (micro-USD ↔ VND), Hono helpers
packages/db      createDb (Postgres or PGlite) + per-schema SQL migrator
packages/core    accounts, API keys, wallet, VietQR top-ups, auth middleware
packages/llm     OpenAI-compatible client, zod-validated JSON calls, MockLlm
apps/*           the four services + web console
scripts/         local dev tooling (scripts/dev), platform seed, cross-service e2e
docs/            engineering conventions and local development guide
reports/         strategy report; research_notes/ holds the sources behind it
```

The display name lives in `BRAND` (`packages/shared/src/brand.ts`) and can be overridden with `BRAND_NAME`.
