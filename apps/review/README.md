# Review — two-pass AI pull-request reviewer

`@ok/review` (port **4300**) is a GitHub App that reviews pull requests with two LLM passes:
a **Reviewer** that proposes candidate issues and an adversarial **Critic** that tries to refute
each one against the actual code. Only findings that survive are posted, as one GitHub review
with inline comments and a summary. It also ships a CLI (`okreview`) for local/CI use.

It focuses on what costs teams money — logic bugs, security, concurrency, performance, API
correctness, error handling, data loss — and deliberately ignores style nits.

---

## How the two-pass method works

```
 PR diff ─▶ parse ─▶ filter ─▶ prioritise ─▶ chunk + context ─▶ Reviewer (per batch)
                                                                   │ candidates
                                                                   ▼
            GitHub review ◀─ format ◀─ post-filters ◀─ verdicts ◀─ Critic (batched)
```

1. **Diff engine** (`src/diff/*`, pure and heavily tested)
   - Parses unified diffs (git, GitHub's diff media type, `diff -u`) into files → hunks →
     lines with old/new line numbers. Handles renames/copies, deletions, binary patches,
     mode-only changes, quoted/space/UTF-8 paths, CRLF and `\ No newline at end of file`.
     Hunk bodies are consumed by the `@@` counts, so a deleted SQL comment `--- x` is never
     mistaken for a file header.
   - Knows the **commentable** RIGHT-side lines (added + context lines inside hunks) — the only
     lines GitHub accepts for `side: RIGHT` review comments.
   - **Filters** lockfiles, generated code (paths and `@generated`/`DO NOT EDIT` banners),
     minified files, vendored/third-party code, snapshots, binaries, rename-only files and very
     large files; `.okreview.yml` adds `include`/`exclude`/`force` overrides.
   - **Risk-based prioritisation** when a PR exceeds the budget (`limits.maxFiles`,
     `limits.maxChangedLines`): security-sensitive source (auth, crypto, sessions, payments,
     webhooks, SQL, migrations…) first, then other source, config/infra, tests, docs; within a
     tier, larger logic changes first. Deferred files are listed in the summary.
   - **Chunking**: files are rendered with RIGHT-side line numbers and ±`contextLines` lines of
     surrounding code from the full new file (fetched at the head commit), merged when windows
     overlap, then packed into LLM-sized batches (~48k chars). Oversized files are split by hunk.
     A compact repository file map (paths near the changed files first) is included.
2. **Reviewer** (`src/prompts/reviewer.ts`) — explicit categories, a severity rubric
   (critical/high/medium/low), "report only issues tied to a changed line", required
   `failureScenario` (inputs/state → wrong result), calibrated `confidence`, optional exact
   `replacement` code, prompt-injection guard (code, PR text and team instructions are data).
   Output is validated with a strict zod schema through `chatJson`; malformed findings are dropped
   individually, and an entirely malformed reply is fed back for one retry.
3. **Critic** (`src/prompts/critic.ts`) — for each finding (batched, 6 per call) it gets the exact
   numbered code around the cited lines from the new file, the hunk, and the claim, and must try to
   disprove it: `confirmed` | `plausible` | `rejected`, a reason, and optionally a corrected line
   or severity. Default model `auto` (cheaper than the Reviewer's `auto:best`).
4. **Deterministic post-filters** (`src/pipeline/run.ts`)
   - drop `rejected`; keep `plausible` only if `keepPlausible` (and confidence ≥ 0.5);
   - accept a line correction **only onto a commentable line** of the same file;
   - anchor: a non-commentable line moves to the nearest commentable line of the closest hunk
     (≤ 5 lines away), multi-line ranges are clamped to one hunk, anything else becomes a
     **general** finding listed in the summary;
   - `severityThreshold`; dedupe near-duplicates (same path + overlapping lines + similar title,
     or same code + category); skip fingerprints already posted on the PR or dismissed by the
     team; cap inline comments by `maxComments` and per severity (high 10, medium 6).
   - Low-severity findings never go inline: when enabled (`severityThreshold: low`) they are
     collected in one collapsed **Minor notes** digest in the summary.

Every candidate — including rejected ones and the Critic's reasons — is stored and visible in the
console API, for transparency.

### What gets posted

One **PR review** (`event: COMMENT`, never "request changes"):

- **Inline comments** (`path`, `line`, `side: RIGHT`; multi-line via `start_line`): a severity
  emoji with the title, the explanation, **Failure scenario**, **Suggested fix** (a GitHub
  `suggestion` block only when the Reviewer's replacement exactly targets the final commented
  lines, is small, and is not a no-op — otherwise a plain code block), a collapsed
  `<details><summary>Why this was flagged</summary>` with the Critic's verification reason and
  confidence, and a footer.
- **Summary**: severity table, scope (full / incremental `a..b`), what was checked, Reviewer →
  Critic stats, findings that could not be anchored, minor-notes digest, findings resolved since
  the last review, files skipped and why, warnings, **duration and cost**. When nothing survives it
  says so plainly: _"No verified issues (N candidate findings rejected by the Critic)."_

The PR title/description are never edited. A `Review` check run is created (needs Checks: write)
with conclusion `success` (no findings) or `neutral` — it never blocks merges unless the repo sets
`failOn` (then `failure` at/above that severity).

### Incremental reviews

On `synchronize`, the service compares the last reviewed head with the new head
(`compare/{last}...{head}`). If it is a fast-forward (`ahead`), only **hunks of the PR diff touched
by the new commits** are reviewed (merges from the base branch are therefore not re-reviewed). Each
finding has a **fingerprint** = sha256(path + normalised title + whitespace-insensitive hash of the
commented code); findings matching an open fingerprint (or the same code + a similar title) are not
reposted. Open findings are tracked through the delta: if their lines were modified/deleted they are
listed as **Resolved**; otherwise their position is shifted. Positions are only persisted after the
review is posted, so retries never shift twice. Diverged/force-pushed or truncated comparisons fall
back to a full review (no duplicates thanks to fingerprints; open findings are re-located by their
snippet hash and resolved if the code is gone). A push that changes **no reviewable lines** (e.g.
only a lockfile) is skipped entirely: no LLM call, no comment, no quota.

**Team dismissals**: if a maintainer (OWNER/MEMBER/COLLABORATOR) or the PR author replies to an
inline comment with something like "won't fix", "false positive", "not a bug", "by design",
"intended", `/dismiss` (Vietnamese equivalents too), or the comment gets a 👎, the finding is closed
and its fingerprint is stored as **suppressed** for the repository — it is never raised again.

---

## GitHub App setup

Create a GitHub App (Settings → Developer settings → GitHub Apps):

| Setting                                                | Value                                                                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Webhook URL                                            | `https://<review-host>/github/webhook`                                                                                     |
| Webhook secret                                         | random string → `GITHUB_WEBHOOK_SECRET`                                                                                    |
| Setup URL (post-installation)                          | `https://<review-host>/github/setup` — tick "Redirect on update"                                                           |
| Request user authorization (OAuth) during installation | recommended (enables strong ownership checks; set `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, callback URL = the setup URL) |

**Repository permissions**: Pull requests **Read & write**, Contents **Read**, Checks **Read &
write**, Issues **Read & write**, Metadata **Read**.

**Subscribe to events**: Pull request, Issue comment, Installation (always sent), Installation
repositories. (Pull request review comment events are not needed — dismissals are read on the next
review.)

Generate a private key (PEM) → `GITHUB_PRIVATE_KEY` (PKCS#1 or PKCS#8; `\n`-escaped or base64 is
fine). The app authenticates with a short-lived RS256 JWT and exchanges it for installation tokens,
which are cached until shortly before expiry.

Triggers: PR `opened`, `reopened`, `synchronize`, `ready_for_review` (drafts are skipped unless
`reviewDrafts: true`); comments `/review`, `/review full`, `@<app-slug> review [full]` on their own
line from repo members or the PR author (bots and drive-by commenters are ignored); `closed`
cancels queued work. Deliveries are verified (`X-Hub-Signature-256`, constant-time), deduplicated by
`X-GitHub-Delivery`, answered with **202** and processed by an in-process queue (concurrency limit,
per-PR coalescing — rapid pushes collapse into one run plus at most one follow-up for the latest
head — and retries with exponential backoff on transient errors). Queue state is mirrored to
`review.jobs` and unfinished jobs are re-enqueued on boot.

Without GitHub credentials the service still boots: `/health` works and webhook endpoints answer
`503 {"error":{"code":"not_configured",…}}`.

### Linking an installation to an account

Installations map to platform orgs in `review.installations`; the linked org pays (its wallet is
debited by the gateway for LLM tokens) and sees the reviews in the console.

1. The console calls `GET /v1/installations/install-url` → a signed, 1-hour **state token** bound
   to the org and the GitHub install URL with `?state=…`.
2. After installing, GitHub redirects to `GET /github/setup?installation_id=…&state=…[&code=…]`;
   the installation is linked and the browser is redirected to `$CONSOLE_URL/review?linked=<id>`.
3. Alternatively the console calls `POST /v1/installations/link` with the installation id and a
   state token issued to the same org.

Ownership: with OAuth configured, the `code` is exchanged and the user must have access to the
installation. Without OAuth, an installation can only be linked within
`REVIEW_LINK_WINDOW_MINUTES` of its last owner-triggered installation webhook (install or
repository-selection change), and never away from an org it is already linked to.

### Billing

- **Linked** installation: needs a balance ≥ `REVIEW_MIN_BALANCE_MICROS`; LLM calls go through the
  gateway with `x-org-id: <org>` and `x-ok-product: review`. Out of balance (before or during the
  run, i.e. a gateway 402) → one polite PR comment per day, review recorded as
  `insufficient_balance`, no crash.
- **Unlinked** installation: `REVIEW_FREE_REVIEWS_PER_MONTH` free reviews per calendar month
  (atomic counter in `review.quota_usage`), billed to `REVIEW_PLATFORM_ORG_ID`. When exhausted (or
  when no platform org is configured) the PR gets one comment asking to link an account
  (`$CONSOLE_URL/review/link?installation_id=…`). Free reviews are refunded if a run fails.

---

## Configuration

### Environment

| Variable                                    | Default                       | Purpose                                                   |
| ------------------------------------------- | ----------------------------- | --------------------------------------------------------- |
| `PORT`                                      | `4300`                        | HTTP port                                                 |
| `DATABASE_URL`                              | `memory://`                   | Postgres URL, `memory://` (PGlite) or `pglite:///dir`     |
| `INTERNAL_TOKEN`                            | dev value                     | Console → service auth, and gateway auth for LLM calls    |
| `GATEWAY_URL`                               | `http://localhost:4000/v1`    | Platform gateway (OpenAI-compatible)                      |
| `CONSOLE_URL`                               | `http://localhost:3000`       | Links posted on PRs, setup redirect                       |
| `GITHUB_APP_ID`                             | –                             | GitHub App id                                             |
| `GITHUB_PRIVATE_KEY`                        | –                             | App private key (PEM, `\n`-escaped or base64)             |
| `GITHUB_WEBHOOK_SECRET`                     | –                             | Webhook HMAC secret                                       |
| `GITHUB_APP_SLUG`                           | –                             | For `@slug review` and the install URL                    |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | –                             | Optional OAuth ownership verification at setup            |
| `GITHUB_API_URL`                            | api.github.com                | GitHub Enterprise Server API base                         |
| `REVIEW_PLATFORM_ORG_ID`                    | –                             | Org billed for free-quota reviews (unset = no free quota) |
| `REVIEW_FREE_REVIEWS_PER_MONTH`             | `20`                          | Free reviews per unlinked installation per month          |
| `REVIEW_MIN_BALANCE_MICROS`                 | `10000`                       | Minimum wallet balance to start a review ($0.01)          |
| `REVIEW_CONCURRENCY`                        | `2`                           | Parallel review jobs                                      |
| `REVIEW_MAX_ATTEMPTS`                       | `3`                           | Attempts per job (transient errors only)                  |
| `REVIEW_CHECK_RUNS`                         | `true`                        | Create the `Review` check run                             |
| `REVIEW_STATE_SECRET`                       | derived from `INTERNAL_TOKEN` | HMAC key for setup state tokens                           |
| `REVIEW_LINK_WINDOW_MINUTES`                | `60`                          | No-OAuth link window (see above)                          |

### `.okreview.yml`

Read from the PR head commit (for **fork PRs from the base commit**, so outside contributors cannot
change models/instructions billed to the org). Invalid files produce one short PR comment explaining
the error and the review runs with defaults. Unknown keys are errors (typos are reported). The
console can store a per-repo override (merged on top of the file).

```yaml
language: en # en | vi — findings and summary language
severityThreshold: medium # low | medium | high | critical (low enables the collapsed minor-notes digest)
maxComments: 15 # max inline comments per review (0-50)
reviewDrafts: false # review draft PRs automatically
failOn: none # none | low | medium | high | critical → check run "failure"
keepPlausible: true # also post findings the Critic rated "plausible"
incremental: true # on new pushes, review only the new commits
models:
  reviewer: auto:best
  critic: auto
paths:
  include: ["src/**"] # only review matching files (when non-empty)
  exclude: ["src/legacy/**", "*.sql.gz"]
  force: ["src/generated/api.ts"] # review even if a built-in filter would skip it
limits:
  maxFiles: 50 # files per review; riskiest first beyond this
  maxChangedLines: 4000
  maxFileChangedLines: 1500 # bigger files are skipped as "large"
  contextLines: 10 # surrounding lines shown around each hunk
instructions: |
  Money is always integer cents. All DB access goes through repositories/.
```

Globs are gitignore-flavoured: `*` within a segment, `**` across segments, `{a,b}`, `[abc]`, a
pattern without `/` matches the basename anywhere, trailing `/` = directory, leading `/` = repo root.

---

## CLI

```bash
# review your branch against main (OpenAI-compatible endpoint)
export OKREVIEW_BASE_URL=https://api.openai.com/v1 OKREVIEW_API_KEY=sk-… OKREVIEW_MODEL=gpt-4.1
pnpm --filter @ok/review cli -- --base main
pnpm --filter @ok/review cli -- --base main --json --fail-on high   # CI / pre-push
git diff origin/main...HEAD | pnpm --filter @ok/review cli -- --diff - --mock   # offline demo
node apps/review/dist/cli.js --help                                  # after `pnpm build`
```

Options: `--base`, `--head`, `--diff <file|->`, `--json`, `--fail-on <severity|none>`, `--model`,
`--critic-model`, `--lang en|vi`, `--config`, `--mock` (offline heuristic Reviewer/Critic, no
network — demonstrates the pipeline, it is not a real reviewer), `--no-color`. Defaults come from
`.okreview.yml` at the repo root; `OKREVIEW_MODEL`/`OKREVIEW_CRITIC_MODEL` override the models
(needed for non-gateway endpoints, where `auto:best` means nothing). Exit codes: 0 ok, 1 `--fail-on`
threshold met, 2 usage/config error. Pre-push hook: `pnpm --filter @ok/review cli -- --base
origin/main --fail-on high`.

---

## HTTP API

Public:

| Method | Path              |                                                        |
| ------ | ----------------- | ------------------------------------------------------ |
| GET    | `/health`         | Liveness, GitHub configuration, queue stats            |
| POST   | `/github/webhook` | GitHub webhook receiver (signature required)           |
| GET    | `/github/setup`   | GitHub App setup URL callback (links the installation) |

Console API — `Authorization: Bearer sk-ok-…` (API key with scope `review`) or
`Authorization: Bearer $INTERNAL_TOKEN` + `X-Org-Id: org_…`:

| Method    | Path                                           |                                                                         |
| --------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| GET       | `/v1/installations`                            | Installations linked to the org, with repos                             |
| GET       | `/v1/installations/install-url`                | Signed state token + GitHub install URL                                 |
| POST      | `/v1/installations/link`                       | `{ installationId, state, code? }`                                      |
| DELETE    | `/v1/installations/:id`                        | Unlink                                                                  |
| GET       | `/v1/repos`                                    | Repos of linked installations (+ settings override)                     |
| GET / PUT | `/v1/repos/:owner/:repo/settings`              | Per-repo override (partial `.okreview.yml`, validated)                  |
| GET       | `/v1/reviews?repo=&pr=&status=&limit=&before=` | Reviews: repo, PR, status, counts by severity, cost, duration           |
| GET       | `/v1/reviews/:id`                              | Review detail + **all** findings incl. rejected ones and Critic reasons |
| POST      | `/v1/reviews/run`                              | `{ target: "owner/repo#12", full?: true }` or `{ repo, number }` → 202  |
| GET       | `/v1/usage`                                    | This month's completed reviews and LLM cost                             |

```bash
curl -s localhost:4300/health
curl -s localhost:4300/v1/installations/install-url -H "Authorization: Bearer $INTERNAL_TOKEN" -H "X-Org-Id: org_123"
curl -s -X POST localhost:4300/v1/installations/link -H "Authorization: Bearer $INTERNAL_TOKEN" -H "X-Org-Id: org_123" \
  -H 'content-type: application/json' -d '{"installationId":12345678,"state":"v1.…"}'
curl -s "localhost:4300/v1/reviews?repo=acme/api&limit=20" -H "Authorization: Bearer sk-ok-…"
curl -s localhost:4300/v1/reviews/rev_abc -H "Authorization: Bearer sk-ok-…"
curl -s -X PUT localhost:4300/v1/repos/acme/api/settings -H "Authorization: Bearer sk-ok-…" \
  -H 'content-type: application/json' -d '{"severityThreshold":"high","paths":{"exclude":["docs/**"]}}'
curl -s -X POST localhost:4300/v1/reviews/run -H "Authorization: Bearer sk-ok-…" \
  -H 'content-type: application/json' -d '{"target":"acme/api#42","full":true}'
```

Errors use the platform envelope `{ "error": { "code", "message", "details"? } }`.

---

## Data model (`pgSchema('review')`, migrations in `src/db/migrations.ts`)

`installations` (GitHub installation ↔ org, status, last owner event), `repos`, `repo_settings`,
`reviews` (status, mode, trigger, head/base/from SHAs, counts, stats, cost, tokens, duration, GitHub
review/check ids, billed org), `findings` (every candidate: verdict, Critic reason, line
corrections, status, fingerprint + snippet hash, posted comment id, open/resolved/dismissed and
tracked position), `suppressions` (team-dismissed fingerprints), `quota_usage`, `pr_notices`
(one-off comments posted once), `jobs` (durable queue mirror).

## Development

```bash
pnpm --filter @ok/review typecheck
pnpm --filter @ok/review test        # offline: MockLlm, PGlite, fake GitHub
pnpm --filter @ok/review build       # dist/index.js + dist/cli.js (tsup, @ok/* bundled)
cd apps/review && DATABASE_URL=memory:// PORT=4996 node dist/index.js
pnpm --filter @ok/review exec tsx src/test/print-sample.ts   # print a sample posted review
```

## Status and limitations

- **verified: false** — the GitHub adapter (`src/github/octokit.ts`, @octokit/rest +
  @octokit/auth-app) is implemented against GitHub's REST docs and unit-tested with fixture
  responses (JWT signing, token caching, request shapes, 404/406 handling), but has not yet been
  exercised against the real api.github.com. Same for the OAuth ownership check.
- The in-process queue is single-replica; multiple replicas would need a shared queue/lock (the
  `jobs` table is a mirror for crash recovery, not a distributed lock). Webhook delivery dedupe is
  in-memory.
- If the process dies between posting a review and recording it, a recovered job can post that
  review again (narrow window).
- Without OAuth credentials, installation ownership at link time is inferred from webhook
  recency; configure OAuth for strong verification.
- Comment dismissal detection uses keyword heuristics; 👎 reactions are counted regardless of who
  reacted.
- Very large PRs: GitHub's diff media type is replaced by the paginated file list (≤ 3000 files);
  comparisons with ≥ 300 files fall back to full reviews. Only the riskiest files within the budget
  are reviewed.
- Deleted files are not reviewed (comments are RIGHT-side only); a problem caused by removed code
  must be cited on a neighbouring line of a modified file. Findings on lines outside every hunk
  appear in the summary as general findings.
- The `--mock` mode is a deterministic demo of the pipeline, not a reviewer.
