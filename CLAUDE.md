# Minh AI

Four AI products for Vietnam on one account and one VND wallet: **Gateway** (OpenAI-compatible multi-provider
API), **Agents** (hosted AI employees), **Safe** (scam/deepfake checker), **Review** (two-pass GitHub PR
reviewer), plus a Next.js **console**. pnpm monorepo, TypeScript strict, Node 22.

Read `README.md` for the product overview, `docs/CONVENTIONS.md` for engineering rules, `docs/DEVELOPMENT.md`
for local dev, and `docs/LOCAL_SETUP_WITH_CLAUDE.md` is a step-by-step setup runbook. Each `apps/*/README.md` has that service's API, env vars and a verified/unverified table.
`reports/` holds the product strategy; it explains *why* many small UX details exist.

## Guidance masterfiles

Shared guidance lives in `docs/guidance/`, copied unchanged from the master library. Read the files by
path (they are not `@`-imported, so they don't load into every session):

- **Every session, before planning or editing:** read `docs/guidance/MASTER-CLAUDE.md` in full. It sets
  how we work: the product owner owns the product and you own the build, pitch before building, the
  standing rules, the git workflow, honest reporting, security (SEC-01–13) and legal checks. Keep
  `HANDOFF.md` current as it describes.
- **For engineering judgement, quality standards, ethics and review:** read
  `docs/guidance/ENGINEERING-CRAFT-MASTER.md` in full and apply it within the current task's scope.
- **For UI/product design, critique or implementation of approved designs:** read
  `docs/guidance/UI-DESIGN-MASTER.md` in full and apply it within the current task's scope.
  `docs/guidance/UI-DESIGN-START-HERE.md` has ready-made prompts for direction, audit and build tasks.

These files add to the project rules on this page; they don't replace them. Where this file or
`docs/CONVENTIONS.md` is more specific (Vietnamese-first copy, micro-USD money, one schema per service,
`verified: false` adapters, the agreed stack), the project rule wins. Don't use the masterfiles to
reopen settled decisions or rewrite working architecture. Record gaps as findings instead.
MASTER-CLAUDE's "One-time setup" (ADRs, `PRIVACY.md`, `docs/legal/`, CI, Makefile) hasn't been done
here. Pitch it before creating any of it.

## Layout

| Path | What | Port |
|---|---|---|
| `packages/shared` | `loadEnv`, `AppError`, ids, logger, money (micro-USD), Hono helpers, `BRAND` | – |
| `packages/db` | `createDb(url)` (Postgres, or PGlite for `memory://`) + per-schema SQL migrator | – |
| `packages/core` | orgs, users, sessions, API keys, shared wallet, VietQR top-ups, `authMiddleware` | – |
| `packages/llm` | OpenAI-compatible client, `chatJson` (zod-validated), `MockLlm` | – |
| `apps/gateway` | public API host: `/v1/chat/completions`, routing, fallback, wallet routes, SePay webhook | 4000 |
| `apps/agents` | agents control plane, runtimes (inline/docker), integrations, tasks, approvals | 4100 |
| `apps/safe` | URL/text/phone/bank/media checks, scam rules, reports | 4200 |
| `apps/review` | GitHub App webhooks, Reviewer → Critic pipeline, CLI | 4300 |
| `apps/web` | Next.js 16 console + landing (Vietnamese first) | 3000 |
| `scripts/dev/` | `pnpm dev`, `dev:setup`, `dev:pay`, `dev:reset` | – |
| `scripts/e2e.ts` | 18 cross-service checks (`pnpm dev:check`) | – |

## Commands

```bash
pnpm dev:setup                 # .env (generated secrets), Postgres, migrations, demo data — idempotent
pnpm dev                       # all apps, hot reload; --only gateway,web for a subset
pnpm dev:check                 # e2e checks against the running stack (needs `pnpm dev`)
pnpm dev:pay                   # simulate the bank transfer for the latest pending top-up
pnpm dev:reset --yes           # wipe local data and reseed (local DBs only)
pnpm test                      # all packages, one at a time (~2 min, offline)
pnpm typecheck && pnpm lint    # tsc per package; biome
pnpm --filter @minh/<pkg> test # one package; add `-- src/foo.test.ts` for one file
pnpm lint --write              # (biome check --write .) autofix formatting/imports
```

Demo login after setup: `demo@minh.local` / `minh-demo-2026`; demo API key in `.dev/credentials.json`.

## Rules that matter

- **Before finishing a change**: `pnpm typecheck`, `pnpm test` (or the touched packages), `pnpm lint` must pass.
  Tests run offline: PGlite (`createDb('memory://')`), `MockLlm`, local mock HTTP servers. Never hit real APIs in tests.
- **One schema per service** (`core`, `gateway`, `agents`, `safe`, `review`). A service never reads another
  service's tables; cross-service data goes over HTTP. `core` is the shared library schema.
- **Migrations** are hand-written SQL in `src/db/migrations.ts`, kept in sync with the Drizzle `schema.ts`.
  Never edit a shipped migration; append a new one with the next id. Services migrate themselves on boot.
- **Money** is integer micro-USD everywhere; convert to VND only for display. Charge only via
  `core.debit(orgId, micros, { product, ref, idempotencyKey? })`. Credits never expire.
- **Auth**: customer routes use `authMiddleware(core, { product, internalToken })`. The console calls services
  server-side with `Authorization: Bearer $INTERNAL_TOKEN` + `X-Org-Id`; the internal token must never reach the browser.
- **LLM calls from products go through the gateway** (`createLlmClient` with `x-org-id` + `x-minh-product`),
  so usage is billed and attributed. Inject `LlmClient` so tests use `MockLlm`.
- **Errors**: throw `AppError(code, message)`; envelope `{ error: { code, message, details? } }`. Validate every
  request body with zod (`parseJson`).
- **Copy**: Vietnamese first, addressing the user as "bạn", natural (not machine-translated). Money in VND.
  Safe must never tell users something is "an toàn"/"safe" — use "Chưa phát hiện dấu hiệu lừa đảo" /
  "Chưa đủ dữ liệu"; media results are "warning signs found/not found", never real/fake.
- **Honesty**: third-party adapters (AI providers, SePay/VietQR, Zalo, KiotViet, Haravan, Shopify, Safe Browsing,
  VirusTotal, Hive, GitHub…) are written from docs and marked `verified: false` until tested live. Don't claim
  otherwise. Catalog prices in `apps/gateway/src/catalog/default.ts` are placeholders.
- **Brand**: display name comes from `BRAND` / `BRAND_NAME`; don't hard-code "Minh AI" elsewhere.

## Gotchas

- PGlite is single-process: fine for tests and a single service, not for the full stack (use Postgres).
- `pnpm test` runs packages sequentially on purpose; parallel runs oversubscribe the CPU and DB-heavy tests time out.
- Empty values in `.env` (`KEY=`) mean "unset" (`loadEnv` drops them).
- Agents fall back to the inline driver (in-process, no isolation) when Docker isn't available.
- Review webhooks answer 503 until a GitHub App is configured; use the CLI (`pnpm --filter @minh/review cli -- --mock`).
- `next dev` regenerates `apps/web/AGENTS.md`; it's committed on purpose. Next.js 16 differs from older
  versions: check `node_modules/next/dist/docs/` before using unfamiliar APIs.
- Never commit `.env` or `.dev/` (both git-ignored).
