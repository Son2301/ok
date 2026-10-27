# Engineering conventions

This is a pnpm monorepo of four products that share one account system and one wallet.

| Path | What | Port |
|---|---|---|
| `packages/shared` | env loading, `AppError`, ids, logger, money (micro-USD), Hono helpers | – |
| `packages/db` | `createDb(url)` (Postgres or in-process PGlite) + per-schema SQL migrator | – |
| `packages/core` | orgs, users, sessions, API keys, shared wallet, `authMiddleware` | – |
| `packages/llm` | OpenAI-compatible client, `chatJson` (zod-validated JSON), `MockLlm` | – |
| `apps/gateway` | AI Gateway (OpenAI-compatible, multi-provider routing) | 4000 |
| `apps/agents` | Hosted AI agents control plane | 4100 |
| `apps/safe` | Scam / deepfake / risk checker | 4200 |
| `apps/review` | Two-pass (Reviewer + Critic) GitHub code review | 4300 |
| `apps/web` | Next.js console + landing for all products | 3000 |

## Stack
TypeScript (strict), Node 22, Hono + `@hono/node-server` for services, Next.js for the web,
Drizzle ORM on Postgres, zod for validation, vitest for tests, biome for lint/format.
Module resolution is `Bundler`: extensionless relative imports, no build step in dev (`tsx`),
`tsup` bundles each service for production (workspace packages bundled in, npm deps external).

## Service layout
```
apps/<svc>/
  package.json        name "@minh/<svc>"; scripts: dev, build, start, typecheck, test
  tsconfig.json       extends ../../tsconfig.base.json
  tsup.config.ts      copy from an existing app
  src/index.ts        boot only: loadEnv → createDb → core.migrate() → svc migrate → serve
  src/app.ts          createApp(deps): Hono  ← pure & testable, all deps injected
  src/env.ts          zod env schema extending baseEnvSchema
  src/db/schema.ts    Drizzle tables in pgSchema('<svc>')
  src/db/migrations.ts  Migration[] (hand-written SQL; keep in sync with schema.ts)
  src/**/*.test.ts    vitest; use createDb('memory://') (PGlite) — never a real DB/network
  README.md           purpose, env vars, full API reference with curl examples
```

## Rules
- **Database**: each service owns exactly one Postgres schema named after it and never reads another
  service's tables. Cross-service data goes over HTTP. `core` is the only shared library schema.
- **Money**: integers in micro-USD (`@minh/shared` money helpers). Charge customers only through
  `core.debit(orgId, micros, { product, ref, … })`.
- **Auth**: every customer-facing route uses `authMiddleware(core, { product, internalToken })`.
  The web console calls services with `Authorization: Bearer $INTERNAL_TOKEN` + `X-Org-Id`.
- **LLM calls from products** go through the gateway with `createLlmClient({ baseUrl: GATEWAY_URL,
  apiKey: INTERNAL_TOKEN, headers: { 'x-org-id': orgId, 'x-minh-product': '<svc>' } })`, so usage is
  billed to the customer's wallet and attributed to the product. Inject `LlmClient` so tests use `MockLlm`.
- **Errors**: throw `AppError(code, message)`; use `errorHandler` + `notFound` from `@minh/shared`.
  Error envelope: `{ "error": { "code", "message", "details"? } }`.
- **IDs**: `newId('<prefix>')`, e.g. `agt_…`, `chk_…`, `rev_…`.
- **Validation**: zod on every request body (`parseJson(c, schema)`).
- **No secrets in code**. Every external credential is an env var; features whose credentials are
  missing degrade gracefully (and say so in responses), never crash.
- **External APIs we cannot test against** (third-party providers, marketplaces): implement against
  their public docs, keep the adapter thin, unit-test request building/response parsing with fixtures,
  and mark them `verified: false` in code comments/README until tested against the real service.
- Tests must pass offline: `pnpm -r typecheck && pnpm -r test`.
