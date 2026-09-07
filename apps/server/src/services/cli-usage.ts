import * as pty from "node-pty";
import { runCli } from "./cli.js";
import type { PoolReading } from "./usage-types.js";

// Both CLIs already know their own account's rate-limit percentages -- they show them in-app
// (Claude Code's "/usage", Codex's "/status") purely from state fetched at session start, with
// no new model turn involved. That makes both reads effectively free: no tokens spent, no
// browser, no signed-in Chrome window to keep open. See cli-usage-scraper.ts for the scheduler
// that calls these, and queue.ts's stage-completion hook for where a fresh read also gets
// triggered opportunistically after every real CLI turn.

// "Sep 5 at 10:49pm (America/Los_Angeles)" / "Sep 6 at 11:59am (...)" -- Claude Code renders
// this in the *server's own* local time zone (same process, same machine), so the parenthesized
// IANA name is informational only; it never needs converting -- it gets its own regex rather
// than a generic "Expires Mon Day, h:mm AM/PM" one because "at" and a bare am/pm (no space, no
// colon-less shorthand) don't fit that shape.
function parseClaudeCliReset(text: string, now: Date): string | null {
  // Minutes are dropped on the hour -- "at 12pm", not "at 12:00pm" (confirmed live) -- so
  // ":(\d{2})" has to be optional, not just the whole match failing over to null and silently
  // losing the reset time for exactly this one time of day every day.
  const match = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!match) return null;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const month = months.indexOf(match[1]!.toLowerCase());
  let hour = Number(match[3]) % 12; if (match[5]!.toLowerCase() === "pm") hour += 12;
  const candidate = new Date(now.getFullYear(), month, Number(match[2]), hour, Number(match[4] ?? 0));
  if (candidate.getTime() < now.getTime() - 60_000) candidate.setFullYear(candidate.getFullYear() + 1);
  return candidate.toISOString();
}

// The exact two lines `claude -p "/usage" --output-format json`'s `result` field contains, e.g.:
//   Current session: 7% used · resets Sep 5 at 10:49pm (America/Los_Angeles)
//   Current week (all models): 27% used · resets Sep 6 at 11:59am (America/Los_Angeles)
// Exported for the same reason parseClaudeUsageText is: cheap to unit-test against a captured
// real transcript without spawning a CLI.
export function parseClaudeCliUsageText(text: string, now: Date): { session: PoolReading; weekly: PoolReading } | null {
  const session = /Current session:\s*(\d{1,3})%\s*used[^\n]*/i.exec(text);
  const weekly = /Current week[^:]*:\s*(\d{1,3})%\s*used[^\n]*/i.exec(text);
  if (!session || !weekly) return null;
  return {
    session: { percent: Math.max(0, Math.min(100, Number(session[1]))), resetAt: parseClaudeCliReset(session[0], now) },
    weekly: { percent: Math.max(0, Math.min(100, Number(weekly[1]))), resetAt: parseClaudeCliReset(weekly[0], now) },
  };
}

// Runs `/usage` as a print-mode "prompt" rather than a real turn: Claude Code recognizes the
// leading slash and answers from already-known account state, so this is a plain subprocess
// call, not a conversation -- `total_cost_usd`/`usage.*` on the result are all zero, confirmed
// live. `--output-format json` is what makes the answer machine-parseable at all; the same text
// printed to a real terminal is meant for a human, not a scraper.
export async function readClaudeUsage(cliPath: string, timeoutMs: number, now = new Date()): Promise<{ session: PoolReading; weekly: PoolReading } | null> {
  const { stdout } = await runCli(cliPath, ["-p", "/usage", "--output-format", "json"], { timeoutMs, maxBuffer: 1_000_000 });
  const payload = JSON.parse(stdout) as { result?: string };
  if (!payload.result) return null;
  return parseClaudeCliUsageText(payload.result, now);
}

// Codex has no non-interactive equivalent of "/status" -- `codex exec "/status"` was confirmed
// live to NOT recognize the slash command at all: it hands the literal text to the model as a
// real prompt (33k input tokens billed, a `git status` run, no rate-limit numbers anywhere in
// the reply). The percentages only render inside the interactive TUI, and the TUI refuses to
// start at all against a plain pipe ("stdin is not a terminal") -- confirmed live. A real
// pseudo-terminal is the only way to ask it the question a human would, which is what
// node-pty exists for here.
const CODEX_STATUS_TIMEOUT_MS = 15_000;

// "23:08" (today, or tomorrow if that time already passed) and "22:20 on 6 Sep" (this year,
// unless that date already passed) are the two forms seen on the 5h and weekly rows
// respectively -- unlike Claude's CLI text, Codex's /status never names a time zone, because it
// is already the viewer's own local clock (this machine's).
function parseCodexCliReset(text: string, now: Date): string | null {
  const withDate = /(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.exec(text);
  if (withDate) {
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const month = months.indexOf(withDate[4]!.toLowerCase());
    const candidate = new Date(now.getFullYear(), month, Number(withDate[3]), Number(withDate[1]), Number(withDate[2]));
    if (candidate.getTime() < now.getTime() - 60_000) candidate.setFullYear(candidate.getFullYear() + 1);
    return candidate.toISOString();
  }
  const bareTime = /\(resets\s+(\d{1,2}):(\d{2})\)/i.exec(text);
  if (bareTime) {
    const candidate = new Date(now); candidate.setHours(Number(bareTime[1]), Number(bareTime[2]), 0, 0);
    if (candidate.getTime() < now.getTime() - 60_000) candidate.setDate(candidate.getDate() + 1);
    return candidate.toISOString();
  }
  return null;
}

// Codex's page (and its own /status panel) reports "% left", the inverse of Claude's "% used" --
// normalized to "% used" here, same convention parseCodexUsageText uses for the Chrome-scraped
// reading, so every UsageGauge in the app means the same thing regardless of source. The
// "gpt-reserve Weekly limit" row (a separate credits pool, unrelated to the plan's own 5h/weekly
// windows) is excluded by requiring the line not start with "gpt-reserve".
export function parseCodexCliStatusText(text: string, now: Date): { fiveHour: PoolReading; weekly: PoolReading } | null {
  const fiveHour = /5h limit:\s*\[[█░]*\]\s*(\d{1,3})%\s*left\s*\(resets[^)]*\)/i.exec(text);
  const weekly = /(?<!gpt-reserve )\bWeekly limit:\s*\[[█░]*\]\s*(\d{1,3})%\s*left\s*\(resets[^)]*\)/i.exec(text);
  if (!fiveHour || !weekly) return null;
  return {
    fiveHour: { percent: 100 - Math.max(0, Math.min(100, Number(fiveHour[1]))), resetAt: parseCodexCliReset(fiveHour[0], now) },
    weekly: { percent: 100 - Math.max(0, Math.min(100, Number(weekly[1]))), resetAt: parseCodexCliReset(weekly[0], now) },
  };
}

const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g;

export async function readCodexUsage(cliPath: string, cwd: string): Promise<{ fiveHour: PoolReading; weekly: PoolReading } | null> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL"]) delete env[name];
    // No `--skip-git-repo-check`: that flag only exists on `codex exec`, and the plain
    // interactive command this needs rejects it outright (confirmed live: "unexpected argument").
    // `cwd` must instead be a directory Codex already trusts (approved once, interactively, the
    // same one-time cost as this app's existing Chrome sign-in) -- an untrusted directory makes
    // the TUI show its own trust prompt and wait forever, which the outer timeout below would
    // then have to eat as a false "failed" reading every single call.
    const term = pty.spawn(cliPath, [], { name: "xterm-256color", cols: 120, rows: 40, cwd, env });
    let buf = "";
    let settled = false;
    const finish = (result: { fiveHour: PoolReading; weekly: PoolReading } | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dataSub.dispose();
      try { term.kill(); } catch { /* already gone */ }
      if (error) reject(error); else resolve(result);
    };
    // The status panel is fully drawn well within a couple seconds of the TUI's own boot on a
    // warm CLI install (confirmed live: ~3-5s total). Polling the accumulated, ANSI-stripped
    // buffer for the row this needs to see, rather than waiting a fixed delay before parsing
    // once, means a slower boot (a cold cache, a busy machine) still succeeds instead of racing
    // a guess -- capped by the outer timeout below so a truly stuck process still terminates.
    // Typing "/status" opens Codex's own slash-command autocomplete dropdown (it's a prefix of
    // "/statusline" too); an Enter sent before that dropdown has actually rendered is consumed
    // by it silently instead of submitting anything. A fixed 1.5s gap between finishing the text
    // and sending Enter (confirmed live against 300ms, which was too fast and left the composer
    // just sitting on "/status" with nothing submitted) is what makes this reliable.
    let typed = false;
    let enterAttempts = 0;
    const dataSub = term.onData((chunk) => {
      buf += chunk;
      const clean = buf.replace(ANSI_PATTERN, "");
      if (!typed && /Ask Codex to do anything|›\s*$/.test(clean)) {
        typed = true;
        setTimeout(() => term.write("/status"), 400);
        // A single Enter occasionally lands before the dropdown has actually rendered and gets
        // consumed by it with nothing submitted (confirmed live at a 300ms gap) -- sending a
        // second one a couple seconds later is a cheap safety net for that same race under a
        // slower boot, and is harmless once the panel already answered (the composer is empty by
        // then, so it submits nothing).
        for (const [attempt, delay] of [[1, 1900], [2, 4000]] as const) {
          setTimeout(() => { enterAttempts = attempt; term.write("\r"); }, delay);
        }
      }
      if (enterAttempts > 0) {
        const parsed = parseCodexCliStatusText(clean, new Date());
        if (parsed) finish(parsed);
      }
    });
    term.onExit(() => finish(null, settled ? undefined : new Error("codex exited before the status panel rendered")));
    const timer = setTimeout(() => finish(null, new Error(`codex did not render /status within ${CODEX_STATUS_TIMEOUT_MS}ms`)), CODEX_STATUS_TIMEOUT_MS);
  });
}
