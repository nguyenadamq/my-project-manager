import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import type { UsageSnapshot } from "@pm/shared";
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

export class UsageService {
  constructor(private db: Db, private config: Config, private events: EventHub) {}
  logChatGpt(note?: string) {
    this.db.prepare("INSERT INTO usage_events(id,tool,kind,timestamp,note) VALUES(?, 'chatgpt','manual_log',?,?)").run(nanoid(), new Date().toISOString(), note ?? null);
    this.events.emit({ type: "usage.updated" });
  }
  async snapshot(now = new Date()): Promise<UsageSnapshot> {
    const fiveHoursAgo = now.getTime() - 5 * 60 * 60 * 1000;
    let claudeTokens = 0; let firstClaude: number | null = null;
    for (const file of await findJsonl(path.join(os.homedir(), ".claude", "projects"))) {
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
    const { start: weekStart, end: nextReset } = weeklyWindow(now, this.config.chatgptResetDay);
    const chatgptUsed = Number((this.db.prepare("SELECT COUNT(*) value FROM usage_events WHERE tool='chatgpt' AND timestamp>=?").get(weekStart.toISOString()) as any).value);
    const claudePercent = Math.min(100, Math.round(claudeTokens / this.config.claudeFiveHourLimit * 100));
    const chatgptPercent = Math.min(100, Math.round(chatgptUsed / this.config.chatgptWeeklyLimit * 100));
    return {
      claude: { used: claudeTokens, limit: this.config.claudeFiveHourLimit, percent: claudePercent, resetAt: firstClaude ? new Date(firstClaude + 5 * 60 * 60 * 1000).toISOString() : null, estimated: true },
      chatgpt: { used: chatgptUsed, limit: this.config.chatgptWeeklyLimit, percent: chatgptPercent, resetAt: nextReset.toISOString(), estimated: true },
      recommendation: claudePercent >= 80 && chatgptPercent < 80 ? "Claude usage is high; consider ChatGPT for the next non-urgent task." : chatgptPercent >= 80 && claudePercent < 80 ? "ChatGPT usage is high; Claude has more headroom." : "Both tools have usable headroom; choose the best fit for the task.",
    };
  }
}
