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
  };
}
