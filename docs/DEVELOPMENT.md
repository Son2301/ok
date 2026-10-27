# Local development

Everything runs on your machine with hot reload: four services, the web console and one Postgres.

## Requirements

- **Node 22+** (`nvm use` reads `.nvmrc`) and **pnpm 10** (`corepack enable`)
- **Docker** for the dev Postgres, *or* any Postgres 16 you already run

## First run

```bash
git clone https://github.com/Son2301/ok.git minh && cd minh
pnpm install
pnpm dev:setup     # .env with generated secrets, Postgres, migrations, demo data
pnpm dev           # all apps with hot reload
```

`pnpm dev:setup` is safe to rerun: it only adds missing settings to `.env` and never overwrites yours.
`pnpm dev` also runs the setup steps itself on a fresh checkout, so `pnpm install && pnpm dev` works too.

When everything is up you'll see:

```
Minh AI is running (Ctrl-C to stop)

  ✔ up   gateway  http://localhost:4000
  ✔ up   agents   http://localhost:4100
  ✔ up   safe     http://localhost:4200
  ✔ up   review   http://localhost:4300
  ✔ up   web      http://localhost:3000

  Console login   demo@minh.local / minh-demo-2026
  Demo API key    sk-minh-…
```

The demo shop has about 572.000đ in its wallet. The API key is also saved in `.dev/credentials.json` (git-ignored).

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Run all five apps with hot reload; pretty, colour-coded logs |
| `pnpm dev --only gateway,web` | Run a subset |
| `pnpm dev --raw` | Show the services' raw JSON log lines |
| `pnpm dev:setup` | Create/complete `.env`, start Postgres, migrate, seed demo data |
| `pnpm dev:pay` | Simulate the bank transfer for the latest pending VietQR top-up |
| `pnpm dev:pay MINHXXXXXXXX 150000` | Pay a specific code, or a different amount (over/under-payment) |
| `pnpm dev:check` | 18 cross-service end-to-end checks against the running stack |
| `pnpm dev:reset --yes` | Drop all local data and reseed (refuses non-local databases) |
| `pnpm db:up` / `pnpm db:down` | Start/stop the dev Postgres container |
| `pnpm test` / `pnpm typecheck` / `pnpm lint` | The same checks CI should run (all offline) |

## Ports

| App | Port | Notes |
|---|---|---|
| web (console) | 3000 | Next.js dev server |
| gateway | 4000 | Public API, wallet routes, SePay webhook |
| agents | 4100 | Inline driver (agents run in-process) unless Docker is available |
| safe | 4200 | Trusts `X-Forwarded-For` from the console in dev |
| review | 4300 | GitHub webhooks answer 503 until a GitHub App is configured |
| Postgres | 5433 | `docker-compose.dev.yml` (5433 avoids clashing with a local 5432) |

## Using your own Postgres instead of Docker

```bash
createuser -s minh && createdb -O minh minh
# in .env:
DATABASE_URL=postgres://minh@localhost:5432/minh
pnpm dev:setup
```

PGlite (`memory://`) works for running a *single* service or the tests, but not for the full stack: five
processes must share one database.

## Real AI models

With no provider keys, the gateway serves an offline mock model, so everything works without internet or cost.
Add any key to `.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`,
`DASHSCOPE_API_KEY`, `OPENROUTER_API_KEY`, …) and restart `pnpm dev`; matching models switch from mock to real.
See `apps/gateway/README.md` for the full list.

## Testing a VietQR top-up locally

1. Console → **Ví & thanh toán** → pick an amount → a QR and a transfer code like `MINH7F3K2QXA` appear.
2. `pnpm dev:pay` sends the same webhook SePay would send for that transfer.
3. Within a few seconds the console shows **Đã nhận 200.000đ** and the new balance.

## Testing the GitHub reviewer

Create a GitHub App (see `apps/review/README.md`), put `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`,
`GITHUB_WEBHOOK_SECRET` and `GITHUB_APP_SLUG` in `.env`, and forward webhooks to your machine, for example:

```bash
npx smee-client --url https://smee.io/<your-channel> --target http://localhost:4300/github/webhook
```

Or skip GitHub entirely and review a local diff: `pnpm --filter @minh/review cli -- --base main --mock`.

## Hot reload

Services run under `tsx watch` and the console under `next dev`. Editing a service restarts it; editing a
shared package (`packages/*`) restarts every service that imports it. Each service migrates its own schema on
start, so new migrations apply on the next reload.

## Troubleshooting

- **"Port already in use"**: another process holds the port (often an old `pnpm dev`). Stop it, or run a subset
  with `--only`.
- **"Cannot reach Postgres … and Docker is not running"**: start Docker, or point `DATABASE_URL` at your own
  Postgres (above).
- **Gateway exits on start with an env error**: a value in `.env` is malformed; the message names the variable.
  Empty values (`KEY=`) are treated as unset.
- **Start from scratch**: stop `pnpm dev`, then `pnpm dev:reset --yes` (or delete `.env` and `.dev/` and rerun setup).
