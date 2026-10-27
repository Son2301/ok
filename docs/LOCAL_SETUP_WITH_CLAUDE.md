# Local setup runbook (for a Claude Code session)

> **How to use:** start Claude Code on your computer and say
> *"Follow docs/LOCAL_SETUP_WITH_CLAUDE.md and set up Minh AI locally."*
> If you haven't cloned the repo yet, start Claude in an empty folder, paste this whole file, and say
> *"Follow this runbook."*

---

**Claude, this runbook is for you.** Your job: get the Minh AI platform running on this machine with hot reload,
prove it works end to end, and hand the user a short report. Work through the steps in order, run the checks
yourself, and fix problems as you go.

## Ground rules

1. **Ask before installing or changing anything system-wide** (Node, Docker, Postgres, Homebrew/apt/winget
   packages, anything with `sudo`, shell profile edits). Say what you'll run and why, then wait for a yes.
   Project-local actions (`pnpm install`, `pnpm dev:setup`, writing `.env`) don't need approval.
2. **Don't change application code** to get setup working. If something in the repo looks broken, stop and
   explain it with the exact error. Editing `.env` is fine.
3. **Never commit or print secrets.** `.env` and `.dev/` are git-ignored; keep them that way. When showing `.env`
   values, mask anything that looks like a key or password. If the user pastes a provider API key, write it into
   `.env` and don't echo it back.
4. **Long-running processes** (`pnpm dev`) go in the background so you can keep working, and you stop them
   when the user asks or at the end if they prefer.
5. Be brief with the user: a one-line status per step, details only when something fails.

## Success criteria

- `pnpm dev` shows all five apps as `✔ up`: web :3000, gateway :4000, agents :4100, safe :4200, review :4300.
- `pnpm dev:check` ends with `All cross-service checks passed` (18 ✔).
- The user can log in at http://localhost:3000 as `demo@minh.local` / `minh-demo-2026`.

---

## Step 0: Where am I?

- Detect the OS: macOS (Intel or Apple Silicon), Linux (distro), WSL2, or native Windows.
- **Native Windows:** recommend running everything inside WSL2 (Ubuntu). The dev tooling is developed and tested
  on Linux/macOS; native Windows is untested. If the user insists on native Windows, continue but expect to
  troubleshoot, and use PowerShell equivalents.
- Check whether the current directory is the repo: `package.json` exists with `"name": "minh"`.
  - Yes → continue to Step 2.
  - No → Step 1.

## Step 1: Get the code (only if not already in the repo)

```bash
git clone https://github.com/Son2301/ok.git minh
cd minh
```

The repo's only branch is the working branch, so no checkout is needed. If the clone asks for credentials, the
user needs GitHub access to `Son2301/ok` (if the repo is private: `gh auth login`, or a credential helper). From here on,
run everything inside `minh/`.

## Step 2: Prerequisites

Check each and report a short table (tool, found version, OK/missing):

| Tool | Check | Needed |
|---|---|---|
| Git | `git --version` | any recent |
| Node | `node -v` | **22 or newer** (`.nvmrc` says 22) |
| pnpm | `pnpm -v` | 10.x (the repo pins `pnpm@10.28.0`) |
| Docker | `docker info` (daemon running, not just installed) | preferred, for the dev Postgres |
| Postgres | `psql --version`, `pg_isready` | only if no Docker |

Fixes (ask first, per ground rule 1):

- **Node < 22 or missing:** prefer a version manager. If `nvm` exists: `nvm install 22 && nvm use 22`.
  If `fnm` exists: `fnm install 22 && fnm use 22`. Otherwise macOS: `brew install node@22`; Ubuntu/WSL: NodeSource
  or `nvm`; Windows: `winget install OpenJS.NodeJS.LTS`.
- **pnpm missing:** `corepack enable` (ships with Node 22), then `pnpm -v`. Corepack picks the pinned version
  automatically. If `corepack enable` fails with a permissions error, try `npm install -g corepack` first, or
  `npm install -g pnpm@10.28.0` as a fallback.
- **Docker installed but not running:** ask the user to start Docker Desktop (or `sudo systemctl start docker` on
  Linux), then re-check `docker info`.
- **No Docker and the user doesn't want it:** use a local Postgres 16 instead (Step 4b).

## Step 3: Install dependencies

```bash
pnpm install
```

Expect it to finish in under a minute. If it fails:
- `ERR_PNPM_UNSUPPORTED_ENGINE` → Node is older than 22 (back to Step 2).
- Network/registry errors → retry once; behind a corporate proxy, check `npm config get registry` / proxy env vars.

## Step 4: Database and configuration

### 4a. With Docker (default)

```bash
pnpm dev:setup
```

This writes `.env` with generated secrets (never overwrites existing values), starts Postgres from
`docker-compose.dev.yml` on **port 5433**, runs migrations, and seeds the demo shop. Success looks like:

```
✔ Wrote 24 settings to …/.env
✔ Postgres is up at postgres://minh:***@localhost:5433/minh
✔ Demo shop ready: demo@minh.local / minh-demo-2026  (balance 572.000 ₫)
✔ Demo API key: sk-minh-…  (saved in .dev/credentials.json)
```

### 4b. Without Docker (own Postgres 16)

1. Make sure Postgres 16 is installed and running (ask before installing: macOS `brew install postgresql@16 &&
   brew services start postgresql@16`, or Postgres.app; Ubuntu/WSL `sudo apt install postgresql-16` or the distro's
   `postgresql` package, then `sudo service postgresql start`).
2. Create the role and database (use `sudo -u postgres` on Linux if needed):
   ```bash
   createuser -s minh          # or: psql -c "CREATE ROLE minh LOGIN SUPERUSER PASSWORD 'minh';"
   createdb -O minh minh
   ```
3. Run `pnpm dev:setup` once (it creates `.env`; the database step will fail, which is expected), then set in `.env`:
   ```
   DATABASE_URL=postgres://minh:minh@localhost:5432/minh
   ```
   (drop `:minh` before `@` if the role has no password and local auth is `trust`/peer).
4. Run `pnpm dev:setup` again; it should end with the demo shop and API key lines.

If you see `password authentication failed`, either set the password (`ALTER ROLE minh PASSWORD 'minh';`) or fix
the URL. If you see `role "minh" does not exist`, redo step 2.

## Step 5: Ports

Before starting, make sure these ports are free: **3000, 4000, 4100, 4200, 4300** (and **5433** if using Docker).
macOS/Linux: `lsof -nP -iTCP:<port> -sTCP:LISTEN`; Windows: `netstat -ano | findstr :<port>`.
If something holds a port, tell the user what it is and ask before stopping it. (`pnpm dev` also refuses to start
and names the busy port.)

## Step 6: Start the platform

Run in the background:

```bash
pnpm dev
```

Wait until the output contains `Minh AI is running`, then confirm all five lines read `✔ up`. The first start of
the web console can take ~30 s while Next.js compiles. If an app shows `✘ down`, read the log lines prefixed with
its name (e.g. `gateway`) and fix the cause. Code changes hot-reload on their own, but changes to `.env` need a
restart of `pnpm dev`.

## Step 7: Prove it works

With `pnpm dev` still running:

```bash
pnpm dev:check
```

Expect 18 ✔ lines and `All cross-service checks passed`. Then a direct API call using the demo key from
`.dev/credentials.json` (read the key from the file; don't paste it into chat):

```bash
KEY=$(node -e "console.log(require('./.dev/credentials.json').apiKey)")
curl -s localhost:4000/v1/chat/completions -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Xin chào"}]}'
```

The answer comes from the offline mock model (`"provider":"mock"`) unless real provider keys are configured.

Optional, quick and satisfying: tell the user to open http://localhost:3000, log in with the demo account,
go to **Ví & thanh toán**, create a top-up, then run `pnpm dev:pay`. Within a few seconds the page shows
**Đã nhận 200.000đ**. (The QR image itself needs internet to load from img.vietqr.io.)

## Step 8: Full test suite

```bash
pnpm typecheck && pnpm lint && pnpm test
```

`pnpm test` runs packages one at a time and takes about 2 minutes; expect ~827 passing tests. It doesn't need
`pnpm dev` running.

## Step 9 (optional): Real AI models

Ask the user whether they want to connect real models now. If yes, have them provide keys for any of
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`,
`OPENROUTER_API_KEY` (and see `apps/gateway/README.md` for others). Write them into `.env`, restart `pnpm dev`,
and confirm with `curl localhost:4000/health` that `providers_enabled` lists them. Remind the user that model
prices in the catalog are placeholders and real calls cost money.

## Step 10: Report

Finish with a short report:

- What's running and where (the five URLs), and whether `pnpm dev` is still running in the background.
- Demo login and where the API key lives (`.dev/credentials.json`), not the key itself.
- Results: `dev:check` (x/18), tests (passed/failed), typecheck, lint.
- Anything you installed or changed outside the repo, and anything skipped or still failing, with the exact error.
- Daily workflow from now on: `pnpm dev` to start, Ctrl-C to stop, `pnpm dev:reset --yes` to start fresh.
  Point to `docs/DEVELOPMENT.md` and `CLAUDE.md`.

## Troubleshooting quick reference

| Symptom | Likely cause → fix |
|---|---|
| `Cannot reach Postgres … and Docker is not running` | Start Docker, or follow Step 4b |
| `Port already in use: gateway (:4000)` | An old `pnpm dev` or another app; stop it, or `pnpm dev --only …` |
| `password authentication failed for user "minh"` | Wrong `DATABASE_URL` credentials; fix `.env` or the role password |
| Gateway exits with `Invalid environment configuration` | A malformed `.env` value; the message names the variable |
| `ERR_PNPM_UNSUPPORTED_ENGINE` / syntax errors on start | Node < 22 |
| `dev:check` fails on `wallet: SePay webhook` | `SEPAY_API_KEY` changed after `pnpm dev` started; restart `pnpm dev` |
| Web shows "đang không phản hồi" for a product | That service is down; check its log prefix in the `pnpm dev` output |
| Everything is weird | Stop `pnpm dev`, then `pnpm dev:reset --yes`, then `pnpm dev` |
