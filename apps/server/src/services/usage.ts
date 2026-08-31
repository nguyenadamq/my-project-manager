import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { UsageGauge, UsageSnapshot } from "@pm/shared";
import type { Db } from "../db.js";
import type { Config } from "../config.js";
import type { EventHub } from "../events.js";

export function weeklyWindow(now: Date, resetDay: number) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const daysSinceReset = (start.getDay() - resetDay + 7) % 7;
  start.setDate(start.getDate() - daysSinceReset);
  const end = new Date(start); end.setDate(end.getDate() + 7);
  return { start, end };
}

async function findJsonl(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file); else if (entry.name.endsWith(".jsonl")) result.push(file);
    }
  }
  await visit(root); return result;
}

interface LiveRow { percentUsed: number; resetsAt: string | null; checkedAt: string }

export class UsageService {
  constructor(private db: Db, private config: Config, private events: EventHub) {}

  logChatGpt(note?: string) {
    this.db.prepare("INSERT INTO usage_events(id,tool,kind,timestamp,note) VALUES(?, 'chatgpt','manual_log',?,?)").run(nanoid(), new Date().toISOString(), note ?? null);
    this.events.emit({ type: "usage.updated" });
  }

  // Explicit "check now" request from the UI, in addition to the interval loop in
  // usage-scraper.ts. Kept here (rather than only on the scraper) so callers depend on
  // UsageService alone; app.ts wires the actual scraper instance in.
  // Returns the live gauge when there is a usable one, and otherwise *why* there isn't -- the
  // reason is what the UI needs to explain a "Check usage now" that changed nothing. A pool that
  // has simply never been scraped has no reason to report and yields null for both.
  private gaugeFromLive(pool: string, now: Date): { gauge: UsageGauge | null; detail: string | null } {
    const row = this.db.prepare("SELECT percent_used percentUsed, resets_at resetsAt, checked_at checkedAt, error FROM live_usage WHERE pool=?").get(pool) as (LiveRow & { error: string | null }) | undefined;
    if (!row) return { gauge: null, detail: null };
    if (row.error) return { gauge: null, detail: row.error };
    // A reading older than 2x the scrape interval is stale enough that showing it as "live"
    // would be misleading (the scraper may be stuck, or Chrome/the profile may be unreachable);
    // fall through to the estimate/unknown path instead, saying so.
    const ageMs = now.getTime() - Date.parse(row.checkedAt);
    if (!Number.isFinite(ageMs) || ageMs > this.config.usageScrapeIntervalMs * 2) {
      return { gauge: null, detail: `The last live reading is ${Math.round(ageMs / 60_000)} minutes old, well past the ${Math.round(this.config.usageScrapeIntervalMs / 60_000)}-minute check interval, so it is no longer shown as live. Is the usage Chrome window still open?` };
    }
    return { gauge: { percent: row.percentUsed, resetAt: row.resetsAt, source: "live", checkedAt: row.checkedAt, detail: null }, detail: null };
  }

  async snapshot(now = new Date()): Promise<UsageSnapshot> {
    const live = {
      claudeSession: this.gaugeFromLive("claude_session", now),
      claudeWeekly: this.gaugeFromLive("claude_weekly", now),
      codexFiveHour: this.gaugeFromLive("codex_five_hour", now),
      codexWeekly: this.gaugeFromLive("codex_weekly", now),
    };

    const claudeSession = live.claudeSession.gauge ?? withDetail(await this.estimateClaudeSession(now), live.claudeSession.detail);
    // No reliable local proxy exists for Claude's weekly window (it spans far more activity
    // than this app's own transcripts capture) or for Codex's local session state -- rather
    // than fabricate a number, these stay "unknown" until live tracking is connected.
    const claudeWeekly = live.claudeWeekly.gauge ?? withDetail(unknownGauge(), live.claudeWeekly.detail);
    const codexFiveHour = live.codexFiveHour.gauge ?? withDetail(unknownGauge(), live.codexFiveHour.detail);
    const codexWeekly = live.codexWeekly.gauge ?? withDetail(await this.estimateCodexWeeklyFromManualLog(now), live.codexWeekly.detail);

    const gauges = { claudeSession, claudeWeekly, codexFiveHour, codexWeekly };
    return { ...gauges, recommendation: recommend(gauges) };
  }

  private async estimateClaudeSession(now: Date): Promise<UsageGauge> {
    const fiveHoursAgo = now.getTime() - 5 * 60 * 60 * 1000;
    let claudeTokens = 0; let firstClaude: number | null = null;
    for (const file of await findJsonl(this.config.claudeProjectsPath)) {
      const content = await fs.readFile(file, "utf8").catch(() => "");
      for (const line of content.split("\n")) try {
        const row = JSON.parse(line); const ts = Date.parse(row.timestamp ?? row.created_at ?? "");
        if (ts >= fiveHoursAgo) {
          const usage = row.message?.usage ?? row.usage ?? {};
          claudeTokens += Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0);
          firstClaude = firstClaude === null ? ts : Math.min(firstClaude, ts);
        }
      } catch { /* partial transcript line */ }
    }
    if (firstClaude === null) return unknownGauge();
    const percent = Math.min(100, Math.round(claudeTokens / this.config.claudeFiveHourLimit * 100));
    return { percent, resetAt: new Date(firstClaude + 5 * 60 * 60 * 1000).toISOString(), source: "estimated", checkedAt: now.toISOString(), detail: null };
  }

  private async estimateCodexWeeklyFromManualLog(now: Date): Promise<UsageGauge> {
    const { start, end } = weeklyWindow(now, this.config.chatgptResetDay);
    const used = Number((this.db.prepare("SELECT COUNT(*) value FROM usage_events WHERE tool='chatgpt' AND timestamp>=?").get(start.toISOString()) as { value: number }).value);
    if (used === 0) return unknownGauge();
    const percent = Math.min(100, Math.round(used / this.config.chatgptWeeklyLimit * 100));
    return { percent, resetAt: end.toISOString(), source: "estimated", checkedAt: now.toISOString(), detail: null };
  }
}

function unknownGauge(): UsageGauge {
  return { percent: 0, resetAt: null, source: "unknown", checkedAt: null, detail: null };
}

const withDetail = (gauge: UsageGauge, detail: string | null): UsageGauge => detail ? { ...gauge, detail } : gauge;

function recommend(gauges: { claudeSession: UsageGauge; claudeWeekly: UsageGauge; codexFiveHour: UsageGauge; codexWeekly: UsageGauge }): string {
  const known = Object.values(gauges).filter((g) => g.source !== "unknown");
  if (known.length === 0) return "Live usage isn't connected yet -- run `pnpm usage:chrome`, sign in once, and leave that window open to see real percentages here.";
  const claudeHigh = [gauges.claudeSession, gauges.claudeWeekly].some((g) => g.source !== "unknown" && g.percent >= 80);
  const codexHigh = [gauges.codexFiveHour, gauges.codexWeekly].some((g) => g.source !== "unknown" && g.percent >= 80);
  if (claudeHigh && !codexHigh) return "Claude usage is high; Codex has more headroom for the next task.";
  if (codexHigh && !claudeHigh) return "Codex usage is high; Claude has more headroom for the next task.";
  if (claudeHigh && codexHigh) return "Both Claude and Codex are running high; consider waiting for a reset before starting new work.";
  return "Both tools have usable headroom; choose the best fit for the task.";
}
