// Shared between cli-usage.ts (parsing) and cli-usage-scraper.ts (the scheduler that calls it
// and writes results into the `live_usage` table) -- pulled out on its own so neither has to
// import the other just for these two small types.
export interface PoolReading { percent: number; resetAt: string | null }
export type UsagePool = "claude_session" | "claude_weekly" | "codex_five_hour" | "codex_weekly";
export const ALL_USAGE_POOLS: readonly UsagePool[] = ["claude_session", "claude_weekly", "codex_five_hour", "codex_weekly"];
