import { describe, expect, it } from "vitest";
import { parseClaudeUsageText, parseCodexUsageText, parseResetText } from "../src/services/usage-scraper.js";

// Fixtures below are transcribed from what claude.ai/settings/usage and
// chatgpt.com/codex/cloud/settings/analytics#usage actually rendered when checked live (see
// chat history), not guessed -- these are the real label/value/reset phrasings the parser has
// to survive.
const claudeText = `
Plan usage limits Pro
Current session
Resets in 4 hr 38 min
17% used
Weekly limits
Your limits are temporarily boosted. Your weekly Claude Code limit is 50% higher through August 31.
All models
Resets Sun 12:00 PM
79% used
Last updated: just now
Usage credits
`;

const codexText = `
Codex and Work Analytics
Balance
Codex and Work share the same usage limit.
5 hour usage limit
100% remaining
Weekly usage limit
100% remaining
Credits remaining
0
Usage limit resets
Use a reset to restore your 5 hour limit, weekly limit, or both.
Full reset (Weekly + 5 hr)
Expires Sep 20, 4:23 PM
`;

describe("parseResetText", () => {
  it("resolves a relative 'Resets in X hr Y min' to now + that duration", () => {
    const now = new Date("2026-08-28T10:00:00");
    const resetAt = parseResetText("Resets in 4 hr 38 min", now);
    expect(Date.parse(resetAt!) - now.getTime()).toBe((4 * 60 + 38) * 60_000);
  });
  it("resolves a weekday+time to its next upcoming occurrence", () => {
    const now = new Date("2026-08-28T10:00:00"); // a Friday
    const resetAt = parseResetText("Resets Sun 12:00 PM", now);
    const result = new Date(resetAt!);
    expect(result.getDay()).toBe(0); expect(result.getHours()).toBe(12);
    expect(result.getTime()).toBeGreaterThan(now.getTime());
    expect(result.getTime() - now.getTime()).toBeLessThanOrEqual(3 * 24 * 60 * 60 * 1000);
  });
  it("resolves an absolute 'Expires Mon DD, H:MM AM/PM' this year when still upcoming", () => {
    const now = new Date("2026-08-28T10:00:00");
    const result = new Date(parseResetText("Expires Sep 20, 4:23 PM", now)!);
    expect(result.getFullYear()).toBe(2026); expect(result.getMonth()).toBe(8); expect(result.getDate()).toBe(20);
    expect(result.getHours()).toBe(16); expect(result.getMinutes()).toBe(23);
  });
  it("returns null for text with no recognizable reset phrasing", () => {
    expect(parseResetText("no reset information here", new Date())).toBeNull();
  });
});

describe("parseClaudeUsageText", () => {
  it("reads the session and weekly percentages from the real page text, not conflating the two", () => {
    const parsed = parseClaudeUsageText(claudeText, new Date("2026-08-28T10:00:00"));
    expect(parsed).not.toBeNull();
    expect(parsed!.session.percent).toBe(17);
    expect(parsed!.weekly.percent).toBe(79);
  });
  it("returns null when the expected labels are missing (page layout changed, or not logged in)", () => {
    expect(parseClaudeUsageText("Sign in to continue", new Date())).toBeNull();
  });
});

describe("parseCodexUsageText", () => {
  it("normalizes '% remaining' to '% used' for both pools", () => {
    const parsed = parseCodexUsageText(codexText, new Date("2026-08-28T10:00:00"));
    expect(parsed).not.toBeNull();
    expect(parsed!.fiveHour.percent).toBe(0); // 100% remaining -> 0% used
    expect(parsed!.weekly.percent).toBe(0);
  });
  it("falls back to the shared 'Expires' line for each pool's reset time even outside its own label's search window", () => {
    const parsed = parseCodexUsageText(codexText, new Date("2026-08-28T10:00:00"));
    expect(parsed!.fiveHour.resetAt).not.toBeNull();
    expect(parsed!.weekly.resetAt).not.toBeNull();
    expect(new Date(parsed!.fiveHour.resetAt!).getDate()).toBe(20);
  });
  it("returns null when the expected labels are missing", () => {
    expect(parseCodexUsageText("Sign in to continue", new Date())).toBeNull();
  });
});
