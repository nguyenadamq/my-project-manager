import type { Db } from "../db.js";
import type { EventHub } from "../events.js";

export interface PoolReading { percent: number; resetAt: string | null }
export type UsagePool = "claude_session" | "claude_weekly" | "codex_five_hour" | "codex_weekly";
const ALL_POOLS: readonly UsagePool[] = ["claude_session", "claude_weekly", "codex_five_hour", "codex_weekly"];

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Reset times on both pages are rendered as short, timezone-less human text (the browser's own
// local clock, same as the account viewing it) rather than an ISO timestamp -- these turn the
// three phrasings actually seen on the two pages into an absolute ISO instant, relative to
// `now` (always the server's local clock, which is what the browser doing the scraping uses
// too). Returns null rather than throwing on anything unrecognized: a reset time we can't
// parse still leaves the percent reading itself usable.
export function parseResetText(text: string, now: Date): string | null {
  const relative = /Resets in\s+(?:(\d+)\s*hr)?\s*(?:(\d+)\s*min)?/i.exec(text);
  if (relative && (relative[1] || relative[2])) {
    const ms = (Number(relative[1] ?? 0) * 60 + Number(relative[2] ?? 0)) * 60_000;
    return new Date(now.getTime() + ms).toISOString();
  }
  // "Resets Sun 12:00 PM" -- the next upcoming occurrence of that weekday+time.
  const weekly = /Resets\s+(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\w*\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(text);
  if (weekly) {
    const targetDay = WEEKDAYS.indexOf(weekly[1]!.toLowerCase());
    const result = nextOccurrence(now, targetDay, Number(weekly[2]), Number(weekly[3]), weekly[4]!.toUpperCase());
    return result.toISOString();
  }
  // "Expires Sep 20, 4:23 PM" -- this year, or next year if that date already passed.
  const absolute = /Expires\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(text);
  if (absolute) {
    const month = MONTHS.indexOf(absolute[1]!.toLowerCase());
    let hour = Number(absolute[3]) % 12; if (absolute[5]!.toUpperCase() === "PM") hour += 12;
    const candidate = new Date(now.getFullYear(), month, Number(absolute[2]), hour, Number(absolute[4]));
    if (candidate.getTime() < now.getTime()) candidate.setFullYear(candidate.getFullYear() + 1);
    return candidate.toISOString();
  }
  return null;
}

function nextOccurrence(now: Date, targetDay: number, hour12: number, minute: number, meridiem: string): Date {
  let hour = hour12 % 12; if (meridiem === "PM") hour += 12;
  const result = new Date(now); result.setHours(hour, minute, 0, 0);
  let daysAhead = (targetDay - now.getDay() + 7) % 7;
  if (daysAhead === 0 && result.getTime() <= now.getTime()) daysAhead = 7;
  result.setDate(result.getDate() + daysAhead);
  return result;
}

function readAfterLabel(text: string, label: RegExp, valuePattern: RegExp, now: Date): PoolReading | null {
  const labelMatch = label.exec(text);
  if (!labelMatch) return null;
  // The percent and its reset line always render within a couple hundred characters of the
  // label on both pages; capping the search window keeps a match from accidentally picking up
  // the *next* section's numbers if a label's own value is ever missing.
  const window = text.slice(labelMatch.index, labelMatch.index + 300);
  const valueMatch = valuePattern.exec(window);
  if (!valueMatch) return null;
  return { percent: Math.max(0, Math.min(100, Number(valueMatch[1]))), resetAt: parseResetText(window, now) };
}

// claude.ai/settings/usage renders "Current session" (a rolling ~5h window) and, under
// "Weekly limits", an "All models" row -- both already expressed as "% used". Parsing walks
// forward from each label rather than relying on DOM structure/class names, which is far more
// resilient to that page's own React internals changing than a CSS selector would be.
export function parseClaudeUsageText(text: string, now: Date): { session: PoolReading; weekly: PoolReading } | null {
  const session = readAfterLabel(text, /Current session/i, /(\d{1,3})%\s*used/i, now);
  const weekly = readAfterLabel(text, /All models/i, /(\d{1,3})%\s*used/i, now);
  if (!session || !weekly) return null;
  return { session, weekly };
}

// chatgpt.com/codex's usage analytics page reports "% remaining", the inverse convention from
// Claude's page -- normalized to "% used" here so every UsageGauge in this app means the same
// thing regardless of source.
export function parseCodexUsageText(text: string, now: Date): { fiveHour: PoolReading; weekly: PoolReading } | null {
  const fiveHour = readAfterLabel(text, /5 hour usage limit/i, /(\d{1,3})%\s*remaining/i, now);
  const weekly = readAfterLabel(text, /Weekly usage limit/i, /(\d{1,3})%\s*remaining/i, now);
  if (!fiveHour || !weekly) return null;
  // The shared "Full reset (Weekly + 5 hr)" / "Expires ..." line applies to both pools; look
  // for it across the whole page once other than each pool's own (usually absent) local text.
  const sharedReset = parseResetText(text, now);
  return {
    fiveHour: { percent: 100 - fiveHour.percent, resetAt: fiveHour.resetAt ?? sharedReset },
    weekly: { percent: 100 - weekly.percent, resetAt: weekly.resetAt ?? sharedReset },
  };
}

export interface UsageScraperOptions {
  enabled: boolean;
  intervalMs: number;
  // http://host:port of an already-running Chrome's --remote-debugging-port (see
  // scripts/launch-chrome-debug.ps1). Deliberately NOT a separate automated profile that logs
  // itself in: a fresh, cookie-less, CDP-flagged login attempt is exactly what triggers
  // anti-bot defenses on both claude.ai and chatgpt.com (both sit behind Cloudflare). Attaching
  // to the user's real, already-authenticated Chrome means there is no automated login step at
  // all -- only an already-signed-in page being read, the same way a Claude Code browser tool
  // session reads it.
  cdpUrl: string;
}

// Reads the real usage percentages Anthropic and OpenAI show each account on its own settings
// page, by attaching to the user's own running Chrome over CDP and opening a background tab.
// Every failure mode (Chrome not running with the debug port, page layout changed, network
// hiccup, no matching window) is caught and recorded per-pool rather than thrown -- this is a
// best-effort enhancement over the existing local estimate, never a hard dependency the rest of
// the app can be broken by.
export class UsageScraper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private db: Db, private events: EventHub, private options: UsageScraperOptions) {}

  start(): void {
    if (!this.options.enabled || this.timer) return;
    // Stagger the first run slightly after boot rather than racing app startup.
    this.timer = setInterval(() => void this.scrapeOnce(), this.options.intervalMs);
    setTimeout(() => void this.scrapeOnce(), 15_000);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private record(pool: UsagePool, reading: PoolReading | null, error?: string): void {
    const now = new Date().toISOString();
    if (reading) {
      this.db.prepare("INSERT INTO live_usage(pool,percent_used,resets_at,checked_at,error) VALUES(?,?,?,?,NULL) ON CONFLICT(pool) DO UPDATE SET percent_used=excluded.percent_used,resets_at=excluded.resets_at,checked_at=excluded.checked_at,error=NULL").run(pool, reading.percent, reading.resetAt, now);
    } else {
      this.db.prepare("INSERT INTO live_usage(pool,percent_used,resets_at,checked_at,error) VALUES(?,0,NULL,?,?) ON CONFLICT(pool) DO UPDATE SET checked_at=excluded.checked_at,error=excluded.error").run(pool, now, error ?? "Reading failed");
    }
  }

  // Exposed for a manual "check now" API call, in addition to the interval loop. If a scrape is
  // already running (the interval timer fired, or another caller got here first), this returns
  // that SAME in-flight promise rather than silently no-opping -- a manual "check now" click
  // must always resolve once a genuinely fresh read has landed, never return early with stale,
  // unchanged data and no indication anything was skipped (this used to be exactly that: a
  // boolean guard that dropped the request on the floor).
  scrapeOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doScrape().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async doScrape(): Promise<void> {
    try {
      const { chromium } = await import("playwright-core");
      let browser: import("playwright-core").Browser;
      try {
        browser = await chromium.connectOverCDP(this.options.cdpUrl, { timeout: 10_000 });
      } catch (error) {
        const message = `Couldn't reach Chrome at ${this.options.cdpUrl}: ${error instanceof Error ? error.message : String(error)}. Launch Chrome with remote debugging enabled (scripts/launch-chrome-debug.ps1 -- see README's "Live usage tracking" section) and stay signed into claude.ai/chatgpt.com there.`;
        for (const pool of ALL_POOLS) this.record(pool, null, message);
        return;
      }
      // Deliberately never call browser.close()/context.close() below: this connection is
      // attached to the user's own already-running Chrome, not a browser this process
      // launched, so closing it would close their real windows. Only the individual pages this
      // scraper opens (in scrapeClaude/scrapeCodex) are ever closed.
      const context = browser.contexts()[0];
      if (!context) {
        const message = "Chrome is reachable over CDP but has no open window; open any tab and try again.";
        for (const pool of ALL_POOLS) this.record(pool, null, message);
        return;
      }
      const now = new Date();
      await this.scrapeClaude(context, now);
      await this.scrapeCodex(context, now);
      this.events.emit({ type: "usage.updated" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const pool of ALL_POOLS) this.record(pool, null, message);
    }
  }

  private async scrapeClaude(context: import("playwright-core").BrowserContext, now: Date): Promise<void> {
    try {
      const page = await context.newPage();
      try {
        // "networkidle" is deliberately avoided: claude.ai is an active chat SPA that keeps
        // background connections (websockets, polling) open indefinitely, so the network never
        // actually goes idle and this would reliably time out (confirmed live: it did,
        // consistently, every time). waitForSelector below already waits for the actual
        // content this scrape needs, making networkidle both redundant and harmful here.
        await page.goto("https://claude.ai/settings/usage", { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForSelector("text=/Current session/i", { timeout: 15_000 });
        const text = await page.evaluate(() => document.body.innerText);
        const parsed = parseClaudeUsageText(text, now);
        if (!parsed) throw new Error("Claude usage page loaded but its expected labels were not found (page layout may have changed, or this Chrome isn't signed into claude.ai)");
        this.record("claude_session", parsed.session);
        this.record("claude_weekly", parsed.weekly);
      } finally { await page.close().catch(() => {}); }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.record("claude_session", null, message);
      this.record("claude_weekly", null, message);
    }
  }

  private async scrapeCodex(context: import("playwright-core").BrowserContext, now: Date): Promise<void> {
    try {
      const page = await context.newPage();
      try {
        // Same reasoning as scrapeClaude above: "networkidle" is unreliable on an active chat
        // SPA, and waitForSelector already waits for the content this scrape actually needs.
        await page.goto("https://chatgpt.com/codex/cloud/settings/analytics#usage", { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForSelector("text=/5 hour usage limit/i", { timeout: 15_000 });
        const text = await page.evaluate(() => document.body.innerText);
        const parsed = parseCodexUsageText(text, now);
        if (!parsed) throw new Error("Codex usage page loaded but its expected labels were not found (page layout may have changed, or this Chrome isn't signed into chatgpt.com)");
        this.record("codex_five_hour", parsed.fiveHour);
        this.record("codex_weekly", parsed.weekly);
      } finally { await page.close().catch(() => {}); }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.record("codex_five_hour", null, message);
      this.record("codex_weekly", null, message);
    }
  }
}
