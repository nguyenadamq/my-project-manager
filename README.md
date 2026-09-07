# Project Manager

A private, mobile-first command center for local Git repositories. Register projects from approved folders, keep AI-assisted feature summaries synchronized at commit checkpoints, and move requested work through a supervised Plan → Implement → Review pipeline on isolated branches.

## What is included

- Fastify REST and WebSocket server with bearer-token authentication and rate limiting.
- SQLite persistence for projects, summaries, features, prompt jobs, usage events, and settings.
- Allow-listed repository registration with idempotent `post-commit` trigger hooks, added by browsing your folders in the app rather than typing an absolute path: the picker walks only what `PM_ALLOWED_ROOTS` permits and labels which folders are Git repositories and which are already registered.
- Debounced, SHA-aware summary refreshes. Anthropic synthesis is used when `ANTHROPIC_API_KEY` is present; a deterministic local summary keeps the app useful offline.
- Two ways to start any prompt, chosen per prompt: **instant**, which begins the moment you add it, or **queued**, which waits for you to press Start or for auto-dispatch to choose it. Both run the identical pipeline in the identical isolated worktree. For `full`-mode prompts the plan stage -- read-only, and always followed by a separate approval checkpoint before anything is implemented -- starts immediately either way; `queued` only holds back `implement_only` prompts, which have no such checkpoint.
- FIFO prompt queue with a mandatory approval checkpoint between planning and implementation.
- Claude creates the plan, Codex implements the approved plan in `.pm/worktrees/<jobId>` on a `pm/<jobId>` branch, and Claude independently reviews the result. The same plan-stage call also drafts bespoke review instructions for that specific change -- what to check, likely failure modes, what counts as scope creep here -- so the review stage works from concrete, plan-specific criteria instead of generic ones re-derived from scratch; both are editable before you approve.
- Up to two automatic fix rounds after a `NEEDS-FIXES` verdict, followed by a human-attention state and an explicit option to request another round.
- A `failed` item can be retried in place: resumes from its existing worktree if implement/review is what failed, or starts over cleanly if planning never got that far.
- Two pipeline modes, chosen per prompt: the supervised `full` Plan → Implement → Review loop above, or `implement_only`, which skips the plan draft/approval checkpoint and the independent review — Codex acts on your prompt directly, still isolated in its own worktree/branch.
- Per-stage model and reasoning settings with global defaults, project overrides, and optional run overrides. Every run stores its resolved configuration.
- Persistent pipeline event history, live status updates, attention badges, editable plans, and a three-stage timeline in the PWA.
- The plan stage drafts a checkpoint list alongside the plan itself -- concrete, sequential implementation milestones. During the initial implement pass (not fix rounds), Codex reports finishing each one, which renders as a live progress bar. Self-reported by the same agent doing the work, so treat it as a best-effort indicator, not a verified one.
- A live terminal view, nested behind its own collapsed toggle on each queue item so it never floods the queue list: streams each stage's raw CLI output as it's produced, in a bounded-height scrolling window, with per-stage tabs and auto-scroll.
- Jobs never merge or push automatically, and failed worktrees are retained for inspection.
- Claude and Codex are invoked through their own subscription CLI login, the same way whether Project Manager or you runs them: `claude`/`codex` are resolved from `PATH` (overridable), and any `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` in the server's own environment is stripped from their subprocess env so they never fall back to pay-per-token API billing. Prompts and plan text are piped through stdin rather than passed as CLI arguments, so large repository context never hits Windows' command-line length limit.
- Live usage tracking: real percentages and reset times read directly from `claude`'s and `codex`'s own CLIs (Claude Code's `/usage`, Codex's `/status`) -- no browser, no separate sign-in, no extra process to keep running. A fresh read is triggered opportunistically after every pipeline CLI turn, plus a periodic fallback for an idle app. Falls back to a local-transcript estimate, then a manual tally, then "unknown" -- never a fabricated number.
- Auto-dispatch (off by default): when enabled, automatically starts the next waiting item -- across every project -- whenever every usage pool that item would draw on has headroom, so work keeps flowing out as soon as the agents are ready instead of waiting for you to be at the keyboard. Covers both `implement_only` items and, since there's already a human-authored prompt behind every queued item, auto-approving `full`-mode plans too.
- Auto-dispatch picks *which* item on three rules, in order: highest project priority; then anything already planned before anything new (a drafted plan has already been paid for and goes stale if it waits); then, when one agent's windows are under more pressure than the other's, the work that doesn't need the constrained one -- an `implement_only` item spends Codex alone, a `full` item spends both Claude and Codex. Queue position breaks any remaining tie.
- Per-project priority ranking, used by both the dashboard's ordering and auto-dispatch's tie-breaking.
- Responsive React PWA designed for phone and desktop use.
- Integration tests and GitHub Actions verification.

## Setup

Requirements:

- **Node.js 22+** and **pnpm 11+**
- **Git**
- **[Claude Code](https://claude.com/claude-code)** and the **[Codex CLI](https://developers.openai.com/codex/cli)**, both installed and signed in -- Project Manager drives them through your own subscription logins, never a metered API key. It only needs them when you actually run a pipeline; the rest of the app works without them.

```bash
git clone https://github.com/nguyenadamq/my-project-manager.git
cd my-project-manager
pnpm install
pnpm bootstrap
```

`pnpm bootstrap` writes a `.env` for you with a freshly generated `PM_AUTH_TOKEN` and
`PM_ALLOWED_ROOTS` pointed at the folder containing this checkout. It never overwrites an
existing `.env`. Open the file and adjust `PM_ALLOWED_ROOTS` if your repositories live
elsewhere -- it is the allow-list for everything the app can see, register, or even list in
the folder picker. Then:

```bash
pnpm start
```

That builds everything and starts the server in one step -- `.env` is loaded automatically
(Node's built-in `--env-file`; no separate export step, no dotenv dependency). Open
<http://127.0.0.1:4174> and paste the `PM_AUTH_TOKEN` from your `.env`. Re-run `pnpm start`
any time; it always rebuilds first, so it doubles as your "pick up code changes" command.

For active development instead, `pnpm dev` runs the web UI and API together with hot reload
(`.env` is loaded the same way); the web UI is at <http://127.0.0.1:4173>, proxying API calls
to port 4174.

Everything above works the same on Windows, macOS, and Linux.

### Running unattended (production)

`pnpm start` is fine for a foreground session, but the whole point of auto-dispatch is a backlog
that keeps moving while you're not watching it -- which means the server itself needs to survive
being closed, a reboot, or a crash. `ecosystem.config.cjs` runs it under
[pm2](https://pm2.keymetrics.io/) with `autorestart: true`:

```bash
pnpm build
npx pm2 start ecosystem.config.cjs
npx pm2 save          # re-applies this process list on the next `pm2 resurrect` / startup hook
npx pm2 startup       # prints the OS-specific command to launch pm2 itself on boot
```

If the process does die mid-run (a crash, `pm2` restarting it, the machine rebooting), any queue
item pm2 catches mid-`planning`/`implementing`/`reviewing`/`fixing` is recovered as a `failed`
item needing attention the moment the new process boots, rather than sitting stuck forever
looking like it's still going -- see `queue.ts`'s `recoverInterruptedJobs`. Retry it the same way
you would any other failure: implement/review failures resume from the worktree already on disk,
planning failures start over from `queued`.

`npx pm2 logs project-manager` tails output; `pnpm build && npx pm2 restart project-manager`
picks up new code the same way `pnpm start` does in the foreground case.

## Using it

1. **Add a project.** "+ Add project" opens a folder picker that walks your allowed roots. Open
   the folder holding the repository and add it. Nothing outside `PM_ALLOWED_ROOTS` is listed.
2. **Queue a prompt.** In a project, describe the change and pick two things:
   - *Pipeline mode* -- **Plan → Implement → Review** (Claude drafts a plan you approve, Codex
     implements it, Claude reviews the diff independently) or **Implement only** (Codex acts on
     your prompt directly; no plan checkpoint, no review).
   - *When to run* -- **Run instantly** starts it immediately, or **Queue it** leaves it waiting
     for you to press Start or for auto-dispatch to pick it up. For **Plan → Implement → Review**
     prompts, "Queue it" still drafts the plan right away -- only implementation waits, behind
     your approval.
3. **Let it run unattended (optional).** Turn on auto-dispatch in Pipeline settings and give
   each project a priority on the dashboard. It then starts the next eligible item on its own
   whenever the agents have usage headroom, so a backlog spread across several projects keeps
   moving without you.
4. **Inspect the result.** Every run lands on its own `pm/<jobId>` branch in its own worktree.
   Project Manager never merges and never pushes -- reviewing and landing the branch is yours.

### Why not Docker

This app is a single Node process with an embedded SQLite file -- there's no second service (database, cache, etc.) for Docker to usefully separate out, unlike a multi-service stack. More importantly, two things it depends on both live on your host machine specifically, not something a container should own: the `claude`/`codex` CLIs' own OAuth logins (`~/.claude`, `~/.codex`), and the Git repositories it registers and creates worktrees in (arbitrary host paths under `PM_ALLOWED_ROOTS`). Containerizing would mean bind-mounting both across the Docker Desktop boundary for no real benefit over just running the one process directly -- `pnpm start` is the simpler and more reliable path here.

## Live usage tracking

Optional, and on by default (`PM_USAGE_SCRAPE_ENABLED=true`). It reads the real percentages and reset times straight from the two CLIs' own account-usage answers: `claude -p "/usage"` and, in a headless pseudo-terminal, Codex's interactive `/status` panel (Codex has no scriptable equivalent). Both are local, free -- no tokens spent, no browser, nothing to sign into separately.

A fresh read is triggered opportunistically right after every plan/implement/review CLI turn a pipeline runs, so gauges usually reflect reality within moments of the last thing that actually spent usage. `PM_USAGE_SCRAPE_INTERVAL_MS` (10 minutes by default) is only the fallback heartbeat for an otherwise-idle app, and the dashboard's "Check usage now" button forces an immediate read at any time.

If a read fails (the CLI isn't on `PATH`, isn't signed in, or its output format changed), gauges fall back to a local-transcript estimate for Claude's session window (a crude proxy -- raw local token count against an arbitrary configured limit, not Anthropic's real rate-limit formula, so treat a high reading here as "check the real number," not gospel), "unknown" for anything with no such fallback -- never a fabricated number.

## API

All `/api/*` routes except `/api/health` require `Authorization: Bearer <PM_AUTH_TOKEN>`.

| Method | Route | Purpose |
|---|---|---|
| GET/POST | `/api/projects` | List or register projects |
| GET | `/api/browse?path=` | List folders inside `PM_ALLOWED_ROOTS` (backs the folder picker); omit `path` for the roots |
| GET/DELETE | `/api/projects/:id` | Inspect or unregister a project |
| POST | `/api/projects/:id/refresh` | Force a summary refresh |
| GET/POST | `/api/projects/:id/queue` | List or append prompts (`mode: "full" \| "implement_only"`, default `"full"`; `dispatch: "instant" \| "queued"`, default `"queued"`) |
| PATCH | `/api/queue/:promptId` | Edit, reorder, or cancel a prompt |
| POST | `/api/queue/:promptId/push` | Start the planning stage |
| PATCH | `/api/queue/:promptId/plan` | Edit a completed plan before approval |
| PATCH | `/api/queue/:promptId/review-prompt` | Edit the plan stage's drafted review instructions before approval |
| POST | `/api/queue/:promptId/approve-plan` | Approve the plan and start implementation |
| POST | `/api/queue/:promptId/request-fixes` | Request one additional fix/review round |
| POST | `/api/queue/:promptId/retry` | Retry a `failed` item -- resumes from its worktree if one exists (implement/review failed), otherwise starts over from `queued` (plan failed) |
| GET | `/api/queue/:promptId/events` | Read the pipeline event history |
| GET/PUT | `/api/settings/pipeline` | Read or replace global stage settings |
| GET/PUT | `/api/settings/auto-dispatch` | Read or replace `{enabled, maxPercentUsed}` |
| PATCH | `/api/projects/:id` | Set project-level stage overrides and/or `priority` |
| GET | `/api/usage` | Read all four usage gauges (Claude session/weekly, Codex 5h/weekly) |
| POST | `/api/usage/scrape-now` | Force an immediate live usage read |
| POST | `/api/usage/chatgpt/log` | Record a manual ChatGPT/Codex use (fallback estimate only) |
| WS | `/ws?token=...` | Receive live job, queue, sync, and usage events |

## Safety and operations

Projects may live anywhere beneath a path listed in `PM_ALLOWED_ROOTS`; they do not need to be inside the Project Manager source directory. Register a repository by picking it in the app's folder browser (or by POSTing its absolute path); either way the same allow-list applies. Implementation runs in a dedicated Git worktree and branch. The app never merges, deletes the source repository, or pushes agent-created branches. Failed job worktrees are retained for inspection.

Back up the database while the service is stopped by copying the configured `PM_DATABASE_PATH`. Restore it to the same path before restarting. For remote access, bind to the host's Tailscale interface and keep bearer authentication enabled; do not expose this execution service directly to the public internet.

Auto-dispatch (Pipeline settings in the PWA) is off by default. When turned on, it will approve `full`-mode plans and start `implement_only` items without further confirmation, on its own schedule, whenever usage headroom allows -- the only checkpoint left is the prompt you originally queued. It never bypasses anything else: worktree isolation, the never-merge/never-push guarantee, and per-item mode all still apply exactly as they do to a manually pushed item.

## Verification

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` (GitHub Actions runs all four on every push). Tests use disposable Git repositories and fake stage runners, so they never invoke the real Claude or Codex CLIs.

## License

MIT -- see [LICENSE](LICENSE).
