import os from "node:os";
import path from "node:path";

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
  chromeCdpUrl: string;
  claudeProjectsPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: env.PM_HOST ?? "127.0.0.1",
    port: Number(env.PM_PORT ?? 4174),
    databasePath: path.resolve(env.PM_DATABASE_PATH ?? "./data/pm.db"),
    authToken: env.PM_AUTH_TOKEN ?? "development-only-token",
    allowedRoots: (env.PM_ALLOWED_ROOTS ?? process.cwd()).split(path.delimiter).map((p) => path.resolve(p)),
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
    usageScrapeEnabled: (env.PM_USAGE_SCRAPE_ENABLED ?? "true").trim().toLowerCase() !== "false",
    usageScrapeIntervalMs: Math.max(60_000, Number(env.PM_USAGE_SCRAPE_INTERVAL_MS ?? 10 * 60_000)),
    // Attaches over CDP to a dedicated Chrome profile launched by scripts/launch-chrome-debug.ps1
    // (Chrome refuses to open a debugging port on the default profile at all, so this can't be
    // the user's everyday browser). The login into that profile happens through a plain,
    // non-automated Chrome window the launch script opens -- automation only ever reads pages
    // afterward, never drives the login -- which is what keeps this from tripping the same
    // anti-bot defenses an earlier, fully Playwright-driven login attempt reliably did.
    chromeCdpUrl: env.PM_CHROME_CDP_URL?.trim() || "http://127.0.0.1:9222",
    // Overridable mainly so tests can point this at an empty fixture directory instead of
    // scanning the real, potentially large (and, for whoever runs the tests, personal)
    // ~/.claude/projects history.
    claudeProjectsPath: env.PM_CLAUDE_PROJECTS_PATH?.trim() || path.join(os.homedir(), ".claude", "projects"),
  };
}
