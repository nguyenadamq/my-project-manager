# Implementation status

The v1 implementation covers the roadmap's foundations, project registry, trigger/sync pipeline, AI synthesis, usage gauges, authenticated responsive PWA, and baseline hardening.

The prompt queue now implements the full supervised Plan → Implement → Review workflow. Claude produces a persisted, editable plan; implementation cannot begin until a user approves it. Approval creates an isolated Git worktree and `pm/<jobId>` branch, where Codex implements the approved plan. Claude then reviews the branch independently. A `NEEDS-FIXES` result can trigger at most two automatic Codex fix rounds; unresolved findings move the item to `review_exhausted`, mark it as needing attention, and require an explicit user request for each further round.

Each queued prompt also picks a pipeline `mode`, set at add-time and immutable afterward: `full` is the workflow above; `implement_only` skips both the plan draft/approval checkpoint and the independent review, moving straight from `queued` to `implementing` (still in an isolated worktree/branch) to `done` or `failed`. There is no fix-round loop in `implement_only` mode since there is no review verdict to trigger one.

Claude and Codex are both invoked through their own subscription CLI login: `cli.ts` strips any `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` from the subprocess environment before every spawn (so the server's own summary-synthesis key never leaks into the coding-agent subprocesses) and pipes the prompt/plan/feedback text through stdin instead of a CLI argument, avoiding Windows' command-line length limit on large repository context.

Usage tracking has a live source: `cli-usage-scraper.ts` asks the two CLIs their own account-usage answers directly -- `claude -p "/usage" --output-format json`, and, since Codex has no scriptable equivalent, its interactive `/status` panel driven headlessly through a real pseudo-terminal (`cli-usage.ts`, via `node-pty`). No browser, no separate sign-in: both reads are local and free. A fresh read is triggered opportunistically after every real plan/implement/review CLI turn (`queue.ts`'s `onCliTurnFinished`), with `usageScrapeIntervalMs` only as a fallback heartbeat for an idle app. `UsageService.snapshot()` prefers a fresh live reading per pool, falling back to a local-transcript estimate (Claude session only), a manual-log estimate (Codex weekly only), or `"unknown"` -- never a fabricated number. (An earlier version of this feature attached over CDP to a dedicated, manually-signed-in Chrome profile; that approach worked but required a browser window kept running at all times purely for this, which the CLI-based reads make unnecessary.)

Auto-dispatch (`auto-dispatch.ts`, off by default via `/api/settings/auto-dispatch`) periodically finds the highest-priority, oldest-waiting queued or plan-ready item across every project whose required usage pools -- Codex only for `implement_only`, both Claude and Codex for `full` -- are under a configurable threshold, and starts it: pushing a queued item, or approving and implementing a plan already sitting in `plan_ready`. Projects carry a `priority` integer (dashboard-orderable) used to break ties.

Pipeline configuration is resolved in global → project → run order and the final model/effort choices are snapshotted on the queue item before planning starts. Pipeline transitions and outputs are persisted as events and broadcast live to the PWA. Existing databases are upgraded through tracked, idempotent SQL migrations; a row still in a subprocess-driven status (`planning`/`implementing`/`reviewing`/`fixing`) when the server boots -- which can only mean the previous process died mid-run -- is recovered as a `failed` item needing attention (`queue.ts`'s `recoverInterruptedJobs`, called once at startup), rather than sitting stuck forever with nothing actually driving it.

The PWA includes stage timelines, attention badges, plan editing and approval, review findings, explicit extra-fix controls, event logs, run overrides, and a global pipeline settings dialog. The source repository remains untouched throughout implementation and review: Project Manager never merges or pushes the generated branch. A `failed` item can be retried in place (`POST /api/queue/:promptId/retry`) rather than only cancelled: it resumes the existing worktree if implement/review is what failed, or starts over from `queued` if planning never got that far.

Production operators must still supply deployment-specific configuration: a bearer token, repository allow-list, installed and authenticated Claude/Codex CLIs, optional Anthropic key for summary synthesis, Tailscale/HTTPS setup, and a process supervisor. WebAuthn and web-push notifications remain optional stretch features rather than v1 requirements.

## Two significant bugs found during a live end-to-end review (2026-08-28)

Both were pre-existing (not introduced by any feature work above) and had gone undetected because verification up to that point relied on curl and fake test runners, never an actual browser click or a real path containing a space:

1. **Every no-body API call from the web UI failed.** `apps/web/src/api.ts`'s `request()` unconditionally set `Content-Type: application/json`, including on requests with no body (push, approve-plan, refresh, scrape-now) -- Fastify's default JSON parser rejects that combination outright ("Body cannot be empty..."). This broke "Start planning," "Approve & implement," "Refresh," and "Check usage now" from the real UI, though none of it showed up in curl-based testing (curl doesn't send that header without `-d`). Fixed by only setting the header when `init.body` is actually present.
2. **Every Codex/Claude call broke when the repository path contained a space.** `cli.ts` spawns `claude`/`codex` via `child_process.spawn(command, args, { shell: true })` on Windows (needed because they resolve to `.cmd`/`.ps1` shims, not raw `.exe`). Confirmed live that Node does not reliably quote array-form arguments before handing them to `cmd.exe` in that mode: an argument like a worktree path under this project's own real `...\Coding Practice\...` folder arrived at the child process split into two separate argv entries at the space, corrupting `-C <path>`/`-o <path>` and causing Codex to fail with a confusing "unexpected argument" error. Fixed by implementing proper Windows command-line argument quoting (the same algorithm as Python's `subprocess.list2cmdline()`) and building the full command line as a single pre-quoted string before spawning, rather than handing Node an args array it won't quote correctly on its own.

A related but smaller fix: `git.ts`'s `git()` helper previously surfaced only `"Command failed: git <args>"` on any failure, dropping the actual `stderr` explanation git always provides -- this is what made bug 2 briefly look unexplainable before its real cause was found. It now includes `stderr` in the thrown error.

## Folder picker, instant dispatch, and usage-aware ordering (2026-08-30)

Three gaps closed, plus the setup path made portable:

1. **Projects are registered by browsing, not by typing a path.** `browse.ts` backs a new
   `GET /api/browse` that lists directories under `PM_ALLOWED_ROOTS` only -- resolving through
   `realpath` first, so a symlink cannot step outside the allow-list that already gates
   registration -- and labels each folder with whether it is a Git repository and whether it is
   already registered. `FolderPicker.tsx` walks that in the PWA, so "Add project" is a few
   clicks instead of an absolute path typed exactly right with no feedback until the server
   rejects it.
2. **Every prompt now chooses when it runs, not just how.** A `dispatch` column
   (`005_dispatch_mode.sql`, defaulting to `queued` so existing rows behave exactly as before)
   carries `instant` or `queued`. An `instant` item is started by the add route itself, through
   the same `runPlanStage` call the push route makes -- same worktree isolation, same
   concurrency slot, same cancellability while it waits; the only thing skipped is the wait to
   be chosen. Because an instant item's row still reads `queued` while it waits for a slot --
   exactly what auto-dispatch scans for -- `QueueService` now tracks kicked-off-but-unclaimed
   ids so a tick can't start a second run of the same item.
3. **Auto-dispatch orders candidates by where the tokens should go.** On top of the existing
   project-priority/FIFO base order, `orderCandidates` applies two rules: finish already-planned
   work before starting anything new (a drafted plan is already paid for and goes stale), and,
   when one agent's windows are under more pressure than the other's, prefer the work that does
   not need the constrained one (`implement_only` spends Codex alone; `full` spends both). Pools
   reading `unknown` contribute no pressure -- "not measured yet" is not evidence of an empty
   budget. Ties keep their SQL order, so priority and queue position still decide everything
   these rules don't.

Setup is now one command on any platform: `pnpm bootstrap` generates a `.env` with a random
`PM_AUTH_TOKEN` and a real `PM_ALLOWED_ROOTS` for the machine it runs on (refusing to overwrite
an existing one), and the Chrome debug launcher was rewritten from PowerShell to a
cross-platform Node script, so Windows, macOS, and Linux all follow the same README.

The five test files that each hardcoded the same list of migration filenames now read the
migrations directory instead -- adding `005_dispatch_mode.sql` would otherwise have broken all
five with failures that say nothing about the code under test.

## Production-readiness pass (2026-09-07)

1. **Registering a project could wrongly fail on macOS.** `projects.ts`/`browse.ts` compared a
   `fs.realpath`'d requested path against `PM_ALLOWED_ROOTS` roots that were *not* themselves
   realpath'd -- on macOS, where `/tmp` and `/var` are themselves symlinks into `/private`, a
   root pointed at either (or any other symlinked folder) never matched, rejecting every real
   project underneath it as "outside PM_ALLOWED_ROOTS". Both call sites now resolve each
   configured root through the same realpath at comparison time; `config.ts`'s `loadConfig` does
   the same once at startup as a first line of defense.
2. **A scrape in flight during shutdown could crash the process.** `cli-usage-scraper.ts`'s
   `stop()` only cleared its timers; a scrape already running when `onClose` closed the database
   would still try to write into it moments later, throwing "database is not open" as an
   unhandled rejection. `stop()` now flips a guard immediately (no new scrape can start) and a
   separate `settle()` lets whatever was already running finish before the database goes away;
   `app.ts`'s shutdown hook calls both in the right order relative to draining other background
   work.
3. **A job interrupted by a crash stayed stuck forever, looking like it was still running.**
   Nothing recovered a row left in `planning`/`implementing`/`reviewing`/`fixing` by a process
   that died mid-run, despite an earlier note above claiming legacy `running` items were
   recovered -- they weren't. `queue.ts`'s new `recoverInterruptedJobs()`, called once at startup,
   now marks every such row `failed` with `needsAttention` set, so it surfaces immediately and
   the existing retry endpoint can pick it back up.
4. **Live usage tracking's Chrome/CDP path is gone**, replaced entirely by the CLI-based reads
   described above -- `usage-scraper.ts`, `scripts/launch-chrome-debug.mjs`, the `playwright-core`
   dependency, `pnpm usage:chrome`, and every `PM_CHROME_*`/`PM_USAGE_PROFILE_PATH` env var are
   removed. One fewer moving part to keep running, no browser profile to sign into or maintain.
5. **Test files were never typechecked.** `tsconfig.json`'s `include` is `src` only, so `lint`/
   `typecheck` silently never caught a type error in `test/**` -- which is exactly how #1's fix
   would have gone unnoticed if a test config object had drifted from `Config`'s real shape. Both
   scripts now also run a new `tsconfig.test.json` covering `src` + `test`.
