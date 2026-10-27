# Handoff

- Task ID / checkpoint: adopt-master-guidance / 1
- Updated at (ISO 8601 with timezone): 2026-10-27T17:35+11:00
- Status: complete (not committed)
- Active writer / outgoing tool / intended next tool: Claude Code / none / none
- Repository or worktree path / branch / HEAD (or no Git): ~/Minh / docs/adopt-master-guidance / 749f011

## Goal and agreement
- User outcome, stage, scope and definition of done: bring four guidance masterfiles into the repo and
  point CLAUDE.md at them. Done when the files are in `docs/guidance/`, CLAUDE.md says when to read
  each one, Codex has a root loader and lint still passes.
- Explicitly out of scope: MASTER-CLAUDE "One-time setup" files (ADRs, PRIVACY.md, CHANGELOG.md,
  docs/legal/, CI workflow, Makefile); any code change.
- User decisions and authorisation: user asked in chat to "apply these 4 files"; user chose the new
  branch `docs/adopt-master-guidance`. Pending: prototype or real product (MASTER-CLAUDE "Stages").
- Canonical guidance and relevant ADRs: CLAUDE.md, docs/CONVENTIONS.md, docs/guidance/*. No ADRs yet.

## Actual working state
- Completed changes and files: docs/guidance/{MASTER-CLAUDE,ENGINEERING-CRAFT-MASTER,UI-DESIGN-MASTER,
  UI-DESIGN-START-HERE}.md (byte-identical copies from the master library); CLAUDE.md gained a
  "Guidance masterfiles" section; new AGENTS.md and HANDOFF.md.
- Partial work and files; staged / unstaged / untracked / needed ignored files: all of the above are
  unstaged/untracked; nothing committed. `.env` and `.dev/` are local only (git-ignored).
- Pre-existing or user changes to preserve; unknown ownership: none.
- Running processes or external actions: `pnpm dev` from the local setup may still be running in the
  background of the earlier Claude Code session; stop it with Ctrl-C or by ending that session.
- Environment/tool versions, required capabilities; secret locations only, no values: Node 24.22.1,
  pnpm 10.28.0, Postgres 16 (Homebrew service, port 5432). Secrets in `.env` and `.dev/credentials.json`.

## Verification
- `pnpm lint` / 2026-10-27T17:36+11:00 / local macOS / HEAD 749f011 plus this task's working changes /
  passed (409 files, no fixes). Every path named in CLAUDE.md's guidance section exists.
- Observed working for real: local stack up, dev:check 18/18 and 827 tests passing at HEAD 749f011
  before this docs-only change.
- Failed, not run, blocked or stale checks: typecheck/tests not rerun (docs-only change).

## Risks and blockers
- Technical risks, known debt and unsuccessful approaches with reasons: MASTER-CLAUDE assumes a fresh
  project in places (stack pitch, one-time setup, "no third-party dependencies until an ADR"); existing
  dependencies predate it, so those rules apply going forward.
- Legal/compliance items: no compliance register yet (MASTER-CLAUDE asks for one before real personal
  data or payments; the product has a wallet and VietQR top-ups).
- Awaiting user input or external access: is Minh AI a prototype or a real product?

## Next actions
1. Owner answers prototype vs real product; that decides how much of MASTER-CLAUDE's process applies.
2. Commit this branch when asked (`docs: adopt guidance masterfiles`).
