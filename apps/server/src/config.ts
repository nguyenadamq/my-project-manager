import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Resolves a root through the filesystem the same way projects.ts and browse.ts resolve
// every path they check against it (fs.realpath, so symlinks collapse) -- otherwise a root
// that itself sits behind a symlink (macOS's /var -> /private/var and /tmp -> /private/tmp
// chief among them, but also any external volume or manually symlinked folder) would never
// match a real project path and every registration under it would be wrongly rejected as
// "outside PM_ALLOWED_ROOTS". Falls back to the resolved-but-unlinked path if the root
// doesn't exist yet (e.g. a typo the app should still be able to report clearly).
export function realRoot(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

export interface Config {
  host: string;
  port: number;
  databasePath: string;
  authToken: string;
  allowedRoots: string[];
  concurrency: number;
  syncDebounceMs: number;
  chatgptWeeklyLimit: number;
  chatgptResetDay: number;
  claudeFiveHourLimit: number;
  cliTimeoutMs: number;
  claudeCliPath: string;
  codexCliPath: string;
  usageScrapeEnabled: boolean;
  usageScrapeIntervalMs: number;
  claudeProjectsPath: string;
  codexUsageCwd: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.PM_HOST ?? "127.0.0.1",
    port: Number(env.PM_PORT ?? 4174),
    databasePath: path.resolve(env.PM_DATABASE_PATH ?? "./data/pm.db"),
    authToken: env.PM_AUTH_TOKEN ?? "development-only-token",
    allowedRoots: (env.PM_ALLOWED_ROOTS ?? process.cwd()).split(path.delimiter).map((p) => realRoot(path.resolve(p))),
    concurrency: Math.max(1, Number(env.PM_GLOBAL_CONCURRENCY ?? 1)),
    syncDebounceMs: Math.max(0, Number(env.PM_SYNC_DEBOUNCE_MS ?? 30_000)),
    chatgptWeeklyLimit: Math.max(1, Number(env.PM_CHATGPT_WEEKLY_LIMIT ?? 1000)),
    chatgptResetDay: Math.min(6, Math.max(0, Number(env.PM_CHATGPT_RESET_DAY ?? 1))),
    claudeFiveHourLimit: Math.max(1, Number(env.PM_CLAUDE_FIVE_HOUR_LIMIT ?? 100_000)),
    // A hung `claude`/`codex` subprocess would otherwise hold its concurrency slot (and
    // block every other queued prompt behind it) forever; this is the outer safety net.
    cliTimeoutMs: Math.max(1, Number(env.PM_CLI_TIMEOUT_MS ?? 20 * 60_000)),
    // Bare command names by default -- resolved via PATH the same way a normal shell would
    // find them (see cli.ts). Only set these if `claude`/`codex` aren't on PATH for the
    // account running the server, or a specific install needs to be pinned.
    claudeCliPath: env.PM_CLAUDE_CLI_PATH?.trim() || "claude",
    codexCliPath: env.PM_CODEX_CLI_PATH?.trim() || "codex",
    // Live usage tracking reads straight from `claude`/`codex`'s own CLIs (see
    // cli-usage-scraper.ts) -- this interval is a fallback heartbeat for an idle app; the real
    // trigger is a fresh read after every pipeline CLI turn.
    usageScrapeEnabled: (env.PM_USAGE_SCRAPE_ENABLED ?? "true").trim().toLowerCase() !== "false",
    usageScrapeIntervalMs: Math.max(60_000, Number(env.PM_USAGE_SCRAPE_INTERVAL_MS ?? 10 * 60_000)),
    // Overridable mainly so tests can point this at an empty fixture directory instead of
    // scanning the real, potentially large (and, for whoever runs the tests, personal)
    // ~/.claude/projects history.
    claudeProjectsPath: env.PM_CLAUDE_PROJECTS_PATH?.trim() || path.join(os.homedir(), ".claude", "projects"),
    // Where cli-usage-scraper.ts launches `codex` from to ask it "/status" -- must be a
    // directory Codex already trusts (approved once, interactively; see cli-usage.ts), or every
    // reading times out waiting on Codex's own unattended trust prompt. Defaults to wherever the
    // server itself was started from, since whoever runs this app has typically already
    // approved that same repo for the pipeline's own implement/review stages.
    codexUsageCwd: env.PM_CODEX_USAGE_CWD?.trim() || process.cwd(),
  };
}
