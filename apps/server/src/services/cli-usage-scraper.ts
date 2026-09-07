import type { Db } from "../db.js";
import type { EventHub } from "../events.js";
import { ALL_USAGE_POOLS, type PoolReading, type UsagePool } from "./usage-types.js";
import { readClaudeUsage, readCodexUsage } from "./cli-usage.js";

export interface CliUsageScraperOptions {
  enabled: boolean;
  // Fallback heartbeat only -- the real trigger is queue.ts's onCliTurnFinished callback, fired
  // right after every plan/implement/review CLI turn. This just covers the gap between pipeline
  // runs (an idle app, or one only driven manually) so a stale-reading warning in usage.ts
  // doesn't fire just because nothing happened to invoke it recently.
  intervalMs: number;
  claudeCliPath: string;
  codexCliPath: string;
  claudeTimeoutMs: number;
  // A directory Codex already trusts (see cli-usage.ts's readCodexUsage) -- this app's own repo
  // root is a reasonable default since whoever runs this server already has Codex approved there
  // for the pipeline's own implement/review stages.
  codexCwd: string;
}

// Reads live usage straight from the two CLIs' own account-usage answers (Claude Code's
// "/usage", Codex's "/status") -- both free, local, no browser or signed-in Chrome window
// required. See cli-usage.ts for why each of those is safe to call this often and how the text
// gets parsed. Writes into the `live_usage` table, which usage.ts reads from.
export class CliUsageScraper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(private db: Db, private events: EventHub, private options: CliUsageScraperOptions) {}

  start(): void {
    if (!this.options.enabled || this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.scrapeOnce(), this.options.intervalMs);
    this.startupTimer = setTimeout(() => void this.scrapeOnce(), 5_000);
  }

  // Synchronous half of shutdown: stops the timers and flips `stopped` immediately so no *new*
  // scrape can start (queue.ts's onCliTurnFinished can still fire while other background work
  // drains) -- call this before draining anything else, then await settle() once that drain is
  // done. Split from settle() so app.ts can close this window as early as possible without
  // having to await it up front.
  stop(): void {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.startupTimer) { clearTimeout(this.startupTimer); this.startupTimer = null; }
  }

  // Waits out whichever scrape was already running (or started in the narrow window between
  // stop() and here) before the caller closes the database out from under it -- otherwise its
  // eventual this.record() call throws "database is not open" as an unhandled rejection,
  // harmless in a short-lived test process but exactly the kind of thing that can crash a
  // long-running one.
  async settle(): Promise<void> {
    if (this.inFlight) await this.inFlight.catch(() => {});
  }

  private record(pool: UsagePool, reading: PoolReading | null, error?: string): void {
    const now = new Date().toISOString();
    if (reading) {
      this.db.prepare("INSERT INTO live_usage(pool,percent_used,resets_at,checked_at,error) VALUES(?,?,?,?,NULL) ON CONFLICT(pool) DO UPDATE SET percent_used=excluded.percent_used,resets_at=excluded.resets_at,checked_at=excluded.checked_at,error=NULL").run(pool, reading.percent, reading.resetAt, now);
    } else {
      this.db.prepare("INSERT INTO live_usage(pool,percent_used,resets_at,checked_at,error) VALUES(?,0,NULL,?,?) ON CONFLICT(pool) DO UPDATE SET checked_at=excluded.checked_at,error=excluded.error").run(pool, now, error ?? "Reading failed");
    }
  }

  // A manual "check now" call that lands while a pipeline-triggered read is already running
  // joins that same in-flight read rather than starting a redundant second `claude`/`codex`
  // process.
  scrapeOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doScrape().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async doScrape(): Promise<void> {
    await Promise.all([this.scrapeClaude(), this.scrapeCodex()]);
    this.events.emit({ type: "usage.updated" });
  }

  private async scrapeClaude(): Promise<void> {
    try {
      const parsed = await readClaudeUsage(this.options.claudeCliPath, this.options.claudeTimeoutMs);
      if (!parsed) throw new Error("`claude -p \"/usage\"` ran but its expected lines were not found (the CLI's own output format may have changed).");
      this.record("claude_session", parsed.session);
      this.record("claude_weekly", parsed.weekly);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.record("claude_session", null, message);
      this.record("claude_weekly", null, message);
    }
  }

  private async scrapeCodex(): Promise<void> {
    try {
      const parsed = await readCodexUsage(this.options.codexCliPath, this.options.codexCwd);
      if (!parsed) throw new Error("codex's /status panel never rendered its rate-limit rows.");
      this.record("codex_five_hour", parsed.fiveHour);
      this.record("codex_weekly", parsed.weekly);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.record("codex_five_hour", null, message);
      this.record("codex_weekly", null, message);
    }
  }
}
