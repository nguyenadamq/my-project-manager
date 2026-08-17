# Project Manager

A private, mobile-first command center for local Git repositories. Register projects from approved folders, keep AI-assisted feature summaries synchronized at commit checkpoints, and move requested work through a supervised Plan → Implement → Review pipeline on isolated branches.

## What is included

- Fastify REST and WebSocket server with bearer-token authentication and rate limiting.
- SQLite persistence for projects, summaries, features, prompt jobs, usage events, and settings.
- Allow-listed repository registration with idempotent `post-commit` trigger hooks.
- Debounced, SHA-aware summary refreshes. Anthropic synthesis is used when `ANTHROPIC_API_KEY` is present; a deterministic local summary keeps the app useful offline.
- FIFO prompt queue with a mandatory approval checkpoint between planning and implementation.
- Claude creates the plan, Codex implements the approved plan in `.pm/worktrees/<jobId>` on a `pm/<jobId>` branch, and Claude independently reviews the result.
- Up to two automatic fix rounds after a `NEEDS-FIXES` verdict, followed by a human-attention state and an explicit option to request another round.
- Per-stage model and reasoning settings with global defaults, project overrides, and optional run overrides. Every run stores its resolved configuration.
- Persistent pipeline event history, live status updates, attention badges, editable plans, and a three-stage timeline in the PWA.
- Jobs never merge or push automatically, and failed worktrees are retained for inspection.
- Estimated Claude transcript usage and explicit, self-reported ChatGPT usage.
- Responsive React PWA designed for phone and desktop use.
- Integration tests and GitHub Actions verification.

## Setup

Requirements: Node.js 22+, pnpm 11+, Git, Claude Code, and the Codex CLI for pipeline execution.

```powershell
pnpm install
Copy-Item .env.example .env
```

Set a long random `PM_AUTH_TOKEN` and restrict `PM_ALLOWED_ROOTS` to the folders containing repositories you intend to manage. Environment variables may be loaded by your process supervisor or shell. Then run:

```powershell
pnpm build
pnpm --filter @pm/server start
```

During development, export the variables in your shell and run `pnpm dev`. The web UI is at `http://127.0.0.1:4173`; its development proxy connects to the API at port 4174. A production server serves the built PWA when started from `apps/server`.

## API

All `/api/*` routes except `/api/health` require `Authorization: Bearer <PM_AUTH_TOKEN>`.

| Method | Route | Purpose |
|---|---|---|
| GET/POST | `/api/projects` | List or register projects |
| GET/DELETE | `/api/projects/:id` | Inspect or unregister a project |
| POST | `/api/projects/:id/refresh` | Force a summary refresh |
| GET/POST | `/api/projects/:id/queue` | List or append prompts |
| PATCH | `/api/queue/:promptId` | Edit, reorder, or cancel a prompt |
| POST | `/api/queue/:promptId/push` | Start the planning stage |
| PATCH | `/api/queue/:promptId/plan` | Edit a completed plan before approval |
| POST | `/api/queue/:promptId/approve-plan` | Approve the plan and start implementation |
| POST | `/api/queue/:promptId/request-fixes` | Request one additional fix/review round |
| GET | `/api/queue/:promptId/events` | Read the pipeline event history |
| GET/PUT | `/api/settings/pipeline` | Read or replace global stage settings |
| PATCH | `/api/projects/:id` | Set project-level stage overrides |
| GET | `/api/usage` | Read both usage gauges |
| POST | `/api/usage/chatgpt/log` | Record a manual ChatGPT use |
| WS | `/ws?token=...` | Receive live job, queue, sync, and usage events |

## Safety and operations

Projects may live anywhere beneath a path listed in `PM_ALLOWED_ROOTS`; they do not need to be inside the Project Manager source directory. Register a repository by entering its absolute local path in the app. Implementation runs in a dedicated Git worktree and branch. The app never merges, deletes the source repository, or pushes agent-created branches. Failed job worktrees are retained for inspection.

Back up the database while the service is stopped by copying the configured `PM_DATABASE_PATH`. Restore it to the same path before restarting. For remote access, bind to the host's Tailscale interface and keep bearer authentication enabled; do not expose this execution service directly to the public internet.

## Verification

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Tests use disposable Git repositories and fake stage runners, so they never invoke the real Claude or Codex CLIs.

