# Implementation Plan — Project Manager

**Status:** Draft v1 · **Date:** 2026-08-14

## 1. Goals & Non-Goals

### Goals
- Register/unregister local project folders ("working projects") — typically git repos you're actively developing.
- For each project, maintain an AI-generated **feature summary** (overall feature list) and a **latest feature** highlight, kept fresh without burning tokens on a polling schedule.
- Maintain a per-project **prompt queue**: append prompts to the end, reorder, and "push through" (execute) one against the project via Claude Code.
- Full remote usability from an iPhone: add/remove projects, review status, queue/push prompts — all from a mobile browser/PWA.
- Track **Claude Code usage** against its rolling 5-hour window and **ChatGPT usage** against its weekly limit, and surface a recommendation for which tool has headroom.

### Non-goals (v1)
- Not a general CI/CD system — it doesn't run tests/deploys, only invokes an AI coding agent and reports the diff.
- Not multi-user / team software — single-owner tool, auth is a shared secret, not a full identity system.
- Not an automatic ChatGPT usage scraper — no official usage API exists for ChatGPT consumer plans, so that side is self-reported (see §8).
- Not a general git host / PR review tool — it produces branches and diffs for you to review, not a hosted review UI.

---

## 2. System Architecture

```
┌─────────────────────────┐        ┌───────────────────────────────────────┐
│   iPhone / any browser   │  HTTPS  │        Host machine (your dev box)     │
│   PWA (React + Vite)     │◄───────►│   ┌─────────────────────────────────┐ │
│   installed to homescreen│  via   │   │  API Server (Node/TS, Fastify)   │ │
└─────────────────────────┘Tailscale│   │  - REST + WebSocket               │ │
                                     │   │  - Auth (shared token/passkey)    │ │
                                     │   └───────────┬───────────┬─────────┘ │
                                     │               │           │           │
                                     │   ┌───────────▼──┐   ┌────▼────────┐  │
                                     │   │ SQLite (data) │   │ Job Worker  │  │
                                     │   │ projects,      │   │ (in-proc,   │  │
                                     │   │ queue, usage   │   │  1 at a time│  │
                                     │   └────────────────┘   │  per proj.) │  │
                                     │                         └────┬────────┘ │
                                     │   ┌─────────────────────────▼────────┐ │
                                     │   │  File Watcher (chokidar)          │ │
                                     │   │  watches .pm/trigger per project  │ │
                                     │   └─────────────────────────┬────────┘ │
                                     │                              │          │
                                     │   ┌──────────────────────────▼───────┐ │
                                     │   │  Registered project folders       │ │
                                     │   │  ~/code/repo-a, ~/code/repo-b, …  │ │
                                     │   │  each with .git/hooks/post-commit │ │
                                     │   │  + .pm/trigger + .pm/summary.json │ │
                                     │   └───────────────────────────────────┘ │
                                     └─────────────────────────────────────────┘
                     Claude API (synthesis) ◄────────┘        Claude Code CLI (headless, per-job) ◄──┘
```

The server, worker, watcher, and database all run as **one local Node process** on the machine where the repos live (or a machine with filesystem/SSH access to them). Remote access is via Tailscale, not by exposing the server to the public internet.

---

## 3. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One language across server/worker/frontend; shared types package. |
| API server | Node.js + Fastify | Lightweight, fast, good WebSocket support, small footprint for a single-user tool. |
| Database | SQLite (`better-sqlite3` + Drizzle ORM) | Zero ops, single file, trivial backup (`cp pm.db pm.db.bak`), plenty for this scale. |
| Queue/worker | In-process async queue, persisted to SQLite | BullMQ+Redis is overkill for one user; durability just needs the queue table to survive restarts. |
| File watching | `chokidar` | Mature, cross-platform, cheap to point at a handful of small marker files instead of whole repo trees. |
| AI synthesis | Anthropic Messages API (`@anthropic-ai/sdk`) | Direct API calls for summarization, model-routed (Haiku for incremental, Sonnet for baseline). |
| Prompt execution | Claude Code CLI, headless (`claude -p ... --output-format json`) via `@anthropic-ai/claude-code` | Reuses the actual coding agent you already use; runs against a git worktree per job. |
| Frontend | React + Vite + Tailwind, `vite-plugin-pwa` | Installable PWA on iOS home screen; mobile-first responsive layout. |
| Auth | Shared bearer token + optional WebAuthn passkey | Lightweight but not trivially guessable; passkey works well from iPhone Face ID. |
| Remote access | Tailscale (MagicDNS) | No open ports, end-to-end encrypted, works great from iOS Tailscale app + Safari. |
| Process supervision | `pm2` (or Windows Task Scheduler on this box) | Keeps the server alive across reboots/crashes. |
| Testing | Vitest (unit/integration), Supertest (API), Playwright (E2E, mobile viewport) | Standard TS-friendly stack, fast feedback loop. |

---

## 4. Data Model

```
Project
  id            text PK
  name          text
  path          text          -- absolute path to repo root, validated on add
  repoRemote    text null      -- origin URL if present, display only
  status        enum(active, archived)
  addedAt       datetime
  lastSyncedSha text null      -- git commit the current summary reflects
  lastSyncedAt  datetime null

FeatureSummary                 -- one row per project, overwritten on each sync
  projectId       text FK -> Project.id
  commitSha       text
  generatedAt     datetime
  overallSummaryMd text        -- full feature-set summary (markdown)
  latestFeatureMd  text        -- highlighted "what's new" section
  model           text         -- which model produced this pass (haiku|sonnet)

Feature                        -- individual entries backing overallSummaryMd
  id          text PK
  projectId   text FK
  title       text
  description text
  addedAtSha  text             -- commit where it was first detected
  status      enum(shipped, in_progress)

QueuedPrompt
  id          text PK
  projectId   text FK
  text        text
  position    integer          -- FIFO order, append = max(position)+1
  status      enum(queued, running, done, failed, cancelled)
  createdAt   datetime
  startedAt   datetime null
  finishedAt  datetime null
  resultBranch text null       -- git branch the job committed to
  resultDiffSummary text null
  errorMessage text null

UsageEvent
  id         text PK
  tool       enum(claude_code, chatgpt)
  kind       enum(message, job, manual_log)
  timestamp  datetime
  tokensIn   integer null
  tokensOut  integer null
  note       text null

Settings
  key   text PK
  value text
  -- e.g. chatgpt_weekly_reset_day, claude_window_hours, auth_token_hash
```

---

## 5. Status Sync — the Trigger-File Mechanism

The explicit design goal: **never poll on a timer and never re-summarize on every keystroke.** Refresh only happens on a real checkpoint. Three triggers feed the same debounced sync pipeline:

1. **Git commit hook (primary trigger).** When a project is registered, the server installs a `post-commit` hook into `.git/hooks/` that writes the new HEAD sha into `.pm/trigger` (a single-line file). This covers you committing manually, outside the PM entirely.
2. **Job completion (PM-driven trigger).** When the PM itself runs a queued prompt via Claude Code and the job commits, the worker writes the same `.pm/trigger` file directly — no need to round-trip through git hooks for jobs it already controls.
3. **Manual "Refresh now"** button in the UI, for a forced resync regardless of trigger state.

The chokidar watcher is scoped to exactly one small file per project (`.pm/trigger`), not the repo tree — so watch overhead stays flat regardless of repo size or how many files you touch while coding. On a trigger-file change:

```
trigger file changes
   → debounce 30s (batches rapid successive commits / amend / rebase)
   → read new HEAD sha, compare to Project.lastSyncedSha
   → if unchanged, no-op (protects against redundant fires, e.g. git gc touching things)
   → enqueue a "sync" job (separate from the prompt queue) for that project
   → sync job runs `git log lastSyncedSha..HEAD --stat` (bounded, e.g. last 50 commits)
   → calls AI synthesis (see §6) with just that delta, not the whole repo
   → writes FeatureSummary, updates Project.lastSyncedSha/lastSyncedAt
```

This means the only recurring cost is: one Claude call per meaningful commit checkpoint, sized to the diff — not a fixed cadence, and not a full-repo re-read.

---

## 6. AI Synthesis Pipeline (token-efficient by design)

- **Baseline scan** (first time a project is added, or manual "deep re-scan"): full `git log --oneline` + directory listing + README + package manifest sent once to **Sonnet**, producing the initial `overallSummaryMd` and seed `Feature` rows. Expensive but rare.
- **Incremental sync** (every trigger after that): send the **previous `overallSummaryMd` + the bounded commit delta** (`git log --stat` + truncated diff, capped at ~8k tokens, largest files elided) to **Haiku**, with an instruction to (a) update `latestFeatureMd`, (b) append/modify `Feature` rows implied by the delta, (c) leave everything else untouched. This is a merge operation, not a rewrite — cheap and fast.
- **Escalation rule**: if the delta exceeds the token cap (huge rebase/squash/vendor bump) or the model's diff-confidence is low, escalate that one sync to Sonnet instead of guessing on Haiku.
- Prompts and response schema (strict JSON: `{latestFeatureMd, featureDeltas: [...]}`) live in a versioned prompt template file so they can be tuned without touching pipeline code.

---

## 7. Prompt Queue & Execution Engine

- **Queue semantics**: strict FIFO per project. "Add to queue" always appends (`position = max(position)+1`). "Push through" runs the *front* of the queue (or a specific prompt if you tap one directly — jumps the line for that one run, doesn't reorder the rest).
- **Execution flow** for a pushed prompt:
  1. Create/reuse a dedicated git worktree at `<repo>/.pm/worktrees/<jobId>` on a fresh branch `pm/<jobId>`.
  2. Invoke Claude Code headless (`claude -p "<prompt>" --output-format json`) scoped to that worktree, with a permission profile that allows edits/commits within the worktree only.
  3. On completion, commit is left on `pm/<jobId>`; job status → `done`, `resultBranch` + `resultDiffSummary` (short AI-generated summary of the diff, cheap Haiku call) recorded.
  4. Worker writes `.pm/trigger` so the sync pipeline (§5) picks up the new branch's summary next time it's merged, OR (simpler, recommended default) the sync only tracks `main`/default branch — feature branches update the queue item's diff preview but don't affect the project's canonical summary until you merge.
  5. You review the diff from the UI (or your normal git tooling) and merge manually — the tool never pushes to `main` on its own.
- **Concurrency**: one running job per project at a time (avoids two agents editing the same worktree); across projects, a global concurrency cap (configurable, default 1) tied to the usage budget in §8 so a queue burst can't blow through your 5-hour window unattended.
- **Failure handling**: non-zero exit or malformed output → status `failed`, `errorMessage` stored, prompt stays out of the way (not auto-retried); you can requeue it manually (adds a fresh copy to the end).

---

## 8. Usage Monitoring

### Claude Code (5-hour rolling window)
Claude Code's Pro/Max plans rate-limit by elapsed-time session windows, not a metered token API, so there's no billing endpoint to query. The practical approach: **parse local transcripts**. Claude Code writes session JSONL under `~/.claude/projects/**/*.jsonl` with per-message timestamps and token counts. A small parser tails these files, sums activity with `timestamp > now - 5h`, and renders a gauge with an estimated reset time (first message in the current window + 5h). This is a heuristic, not the authoritative number Anthropic uses — the plan should say so in the UI, not overstate precision.

### ChatGPT (weekly limit)
There is no public API exposing a ChatGPT consumer plan's usage/limit — it's not something this tool can read automatically without scraping ChatGPT's own UI, which is fragile and against the spirit of a stable personal tool. v1 ships a **manual log**: one tap ("Log ChatGPT message") in the UI records a `UsageEvent(tool=chatgpt, kind=manual_log)`; the dashboard sums these against a rolling 7-day window anchored to a configurable reset day. This is explicitly self-reported and flagged as such — accurate only as far as you remember to tap it, which is an acceptable trade for a personal tool. (A browser-scraping integration is listed as a stretch idea in §14, not built now, because it's brittle and ToS-adjacent.)

### Recommendation heuristic
Dashboard shows both gauges plus a plain-language banner: if Claude Code window usage crosses 80%, suggest routing the next non-urgent task to ChatGPT (if it has headroom), and vice versa. This is advisory only — you still manually choose which tool to run a prompt through.

---

## 9. API Design

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/projects` | List registered projects with status summary |
| `POST` | `/api/projects` | Add a project (validates path exists, is a git repo, installs hook) |
| `DELETE` | `/api/projects/:id` | Remove (un-registers; does not delete the folder) |
| `GET` | `/api/projects/:id` | Full detail: features, latest feature, queue, recent syncs |
| `POST` | `/api/projects/:id/refresh` | Manual resync (bypasses debounce) |
| `GET` | `/api/projects/:id/queue` | List queued prompts (ordered) |
| `POST` | `/api/projects/:id/queue` | Append a prompt to the end |
| `PATCH` | `/api/queue/:promptId` | Edit text / reorder / cancel |
| `POST` | `/api/queue/:promptId/push` | Execute now (front-of-queue or this one directly) |
| `GET` | `/api/usage` | Combined Claude + ChatGPT usage snapshot |
| `POST` | `/api/usage/chatgpt/log` | Manual ChatGPT usage tap |
| `WS` | `/ws` | Push events: `sync.updated`, `queue.updated`, `job.progress`, `usage.updated` |

Auth: `Authorization: Bearer <token>` on every REST call; WS authenticates on connect. All mutating routes require the token even on the Tailscale-only network, as defense in depth.

---

## 10. Frontend & Remote Access

### Screens
- **Project list** — cards with name, status pill (`up to date` / `syncing…` / `queue: N pending`), add/remove.
- **Project detail** — latest feature banner at top, full feature list below (grouped shipped vs. in-progress), commit-linked.
- **Queue view** — ordered list, drag-to-reorder, "Push next" button, per-item "Push this now", status chips (queued/running/done/failed), diff summary + branch link on completed items.
- **Usage dashboard** — two gauges (Claude 5h, ChatGPT weekly) with time-to-reset, recommendation banner, manual ChatGPT log button.

### Mobile/remote
- Ship as an installable PWA (manifest + service worker via `vite-plugin-pwa`); add-to-home-screen on iPhone gives an app-like icon and standalone window.
- Access via **Tailscale**: install Tailscale on the host machine and the iPhone Tailscale app; the PWA is reached at the host's MagicDNS name (e.g. `https://devbox.tailXXXX.ts.net:PORT`) — no port forwarding, no public exposure.
- Optional: Web Push (via the same PWA) for "job finished" / "sync updated" notifications, so you don't have to poll the app from your phone either.

---

## 11. Security Model

- Execution is filesystem-scoped: the server only ever touches paths under registered `Project.path` entries (validated allow-list, resolved/realpath-checked to block `../` escapes).
- Prompt execution runs in an isolated git worktree/branch, never directly on your working tree, and never auto-pushes/merges to `main`.
- All API access requires the bearer token; consider adding WebAuthn passkey login for the web UI on top of it.
- Audit log: every executed prompt, its resulting branch, and diff summary are retained (the `QueuedPrompt` row itself *is* the audit record — never hard-deleted, only marked `cancelled`).
- Rate limiting on the API (per-IP/token) to blunt any credential leak from turning into runaway Claude Code executions.
- Because this is reachable from your phone over Tailscale, treat the bearer token like a password: stored in iOS Keychain/PWA local storage, never logged.

---

## 12. Testing Strategy

| Layer | Tooling | Representative cases |
|---|---|---|
| Queue logic | Vitest (unit) | append always lands at max(position)+1; push-this-now doesn't reorder others; cancel doesn't renumber; concurrent push attempts don't double-run. |
| Usage windows | Vitest (unit) | 5h rolling sum excludes events just outside the boundary; weekly reset day rollover at exact midnight boundary; empty-history renders 0%, not NaN/crash. |
| Trigger/debounce | Vitest + tmp dir + chokidar | rapid successive writes to `.pm/trigger` within debounce window fire exactly one sync; unchanged sha after debounce is a no-op; watcher survives file recreation (e.g. after `git gc`). |
| Summary merge | Vitest, mocked Claude responses | incremental merge preserves untouched `Feature` rows; malformed JSON response from the model fails the sync cleanly (job marked failed, prior summary untouched, not corrupted). |
| Git hook install | Vitest + real git repo fixture | `post-commit` installs idempotently (doesn't duplicate on re-add); a repo with an existing custom hook gets the PM line appended, not clobbered. |
| API | Supertest | full CRUD on projects incl. path-traversal rejection; queue endpoints enforce auth; malformed project path (not a git repo) is rejected with a clear error, not a 500. |
| Execution pipeline | Vitest + stub Claude Code CLI | worktree created/cleaned up per job; failed job leaves worktree for inspection but doesn't corrupt main working tree; concurrency cap of 1/project enforced under parallel push attempts. |
| E2E | Playwright, mobile (iPhone) viewport | add project → see it appear; queue a prompt → appears at end; push → status transitions queued→running→done reflected live via WS; usage gauges render from seeded data. |
| CI | GitHub Actions | lint + typecheck + unit + integration + API tests on every push; Playwright E2E on a nightly/manual trigger (slower, needs a fixture repo). |

Every phase in §13 ships with its own tests in the same PR — testing is not a separate later phase.

---

## 13. Phased Roadmap

**Phase 0 — Foundations.** pnpm workspace (`apps/server`, `apps/web`, `packages/shared`), TypeScript project references, ESLint/Prettier, SQLite + Drizzle schema/migrations, CI skeleton (lint/typecheck/test on push). *Test gate:* CI green on an empty scaffold with one smoke test per package.

**Phase 1 — Project registry.** Add/remove/list projects end to end (API + minimal UI), path validation (must exist, must be a git repo, must not already be registered), realpath allow-listing. *Test gate:* API + unit tests from §12 "Queue logic"-adjacent CRUD cases; reject non-repo paths and path traversal.

**Phase 2 — Trigger & sync scaffolding.** Git hook installer, `.pm/trigger` watcher, debounce logic, manual refresh endpoint — wired to a stub synthesis function (echoes the delta, no real AI call yet) so the pipeline is provably correct before spending tokens on it. *Test gate:* all "Trigger/debounce" and "Git hook install" cases in §12.

**Phase 3 — AI synthesis.** Real Claude API integration: baseline scan + incremental merge (§6), prompt templates, model routing (Haiku/Sonnet), escalation rule. *Test gate:* "Summary merge" cases with mocked responses; one manual smoke test against a real small repo to sanity-check output quality.

**Phase 4 — Prompt queue.** Data model + FIFO endpoints, queue UI (list/add/reorder), no execution yet (prompts just sit `queued`). *Test gate:* full "Queue logic" suite.

**Phase 5 — Execution pipeline.** Worktree isolation, headless Claude Code invocation, job lifecycle (`queued→running→done/failed`), diff summary generation, concurrency cap. *Test gate:* "Execution pipeline" suite with a stubbed CLI, plus one real end-to-end run against a disposable scratch repo.

**Phase 6 — Usage monitoring.** Claude transcript parser + rolling 5h calc, ChatGPT manual log + weekly calc, dashboard UI, recommendation banner. *Test gate:* "Usage windows" suite, including boundary/rollover cases.

**Phase 7 — Mobile & remote access.** PWA packaging (manifest, service worker, icons), responsive layout pass on all screens, Tailscale setup documented and verified from an actual iPhone, bearer-token auth (+ optional passkey), rate limiting. *Test gate:* Playwright E2E suite run at iPhone viewport widths; manual verification over Tailscale from a phone.

**Phase 8 — Hardening & polish.** Audit log surfaced in UI, error-state polish (failed syncs/jobs are visible, not silent), backup/restore doc for the SQLite file, `pm2`/service-file for boot persistence, README + this plan kept in sync. *Test gate:* full suite green in CI; a documented disaster-recovery drill (kill the process, restart, confirm queue/usage state intact).

---

## 14. Assumptions & Open Decisions

- **Host machine**: assumed this runs on the same machine (or one with filesystem access) as your repos — confirm whether that's this Windows box, a always-on mini PC, or something else, since it affects the service-supervision choice in Phase 8.
- **Default branch policy**: assumed pushed prompts land on a feature branch for review, never auto-merged — confirm this matches how hands-off you want it.
- **ChatGPT tracking accuracy**: manual/self-reported only in v1, called out explicitly in the UI rather than presented as precise.
- **Claude Code usage numbers**: derived from local transcript parsing, a heuristic — not Anthropic's authoritative counter — labeled as an estimate in the UI.

## 15. Future / Stretch Ideas (not in v1)
- Web-push notifications for job completion / sync updates.
- Optional browser-extension-based ChatGPT usage capture (explicitly deferred — fragile, ToS-sensitive).
- Multi-branch summary tracking (not just default branch).
- Slack/iMessage bridge for queueing prompts without opening the app.
