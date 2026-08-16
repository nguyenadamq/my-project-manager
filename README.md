# Project Manager

A private, mobile-first command center for local Git repositories. Register projects, keep AI-assisted feature summaries synchronized at commit checkpoints, queue Claude Code work on isolated branches, and monitor approximate Claude/ChatGPT usage.

## What is included

- Fastify REST and WebSocket server with bearer-token authentication and rate limiting.
- SQLite persistence for projects, summaries, features, prompt jobs, usage events, and settings.
- Allow-listed repository registration with idempotent `post-commit` trigger hooks.
- Debounced, SHA-aware summary refreshes. Anthropic synthesis is used when `ANTHROPIC_API_KEY` is present; a deterministic local summary keeps the app useful offline.
- FIFO prompt queue and isolated `.pm/worktrees/<jobId>` execution on `pm/<jobId>` branches. Jobs never merge or push automatically.
- Estimated Claude transcript usage and explicit, self-reported ChatGPT usage.
- Responsive React PWA designed for phone and desktop use.
- Integration tests and GitHub Actions verification.

## Setup

Requirements: Node.js 22+, pnpm 11+, Git, and Claude Code for prompt execution.

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
| POST | `/api/queue/:promptId/push` | Execute a queued prompt |
| GET | `/api/usage` | Read both usage gauges |
| POST | `/api/usage/chatgpt/log` | Record a manual ChatGPT use |
| WS | `/ws?token=...` | Receive live job, queue, sync, and usage events |

## Safety and operations

Project paths are resolved through the filesystem and must fall inside `PM_ALLOWED_ROOTS`. Claude Code runs in a dedicated Git worktree and branch. The app never merges, deletes the source repository, or pushes agent-created branches. Failed job worktrees are retained for inspection.

Back up the database while the service is stopped by copying the configured `PM_DATABASE_PATH`. Restore it to the same path before restarting. For remote access, bind to the host's Tailscale interface and keep bearer authentication enabled; do not expose this execution service directly to the public internet.

## Verification

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Tests use disposable Git repositories and never invoke the real Claude CLI.

