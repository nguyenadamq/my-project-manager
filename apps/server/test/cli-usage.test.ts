import { describe, expect, it } from "vitest";
import { parseClaudeCliUsageText, parseCodexCliStatusText } from "../src/services/cli-usage.js";

// Transcribed from `claude -p "/usage" --output-format json`'s `result` field, run live (see
// chat history) -- including the on-the-hour case ("12pm", no ":00") that first broke the
// reset-time regex.
const claudeTextWithMinutes = `You are currently using your subscription to power your Claude Code usage

Current session: 13% used · resets Sep 5 at 10:50pm (America/Los_Angeles)
Current week (all models): 28% used · resets Sep 6 at 12pm (America/Los_Angeles)

What's contributing to your limits usage?`;

// Codex's interactive "/status" panel, driven through a real pseudo-terminal and ANSI-stripped
// (see cli-usage.ts's readCodexUsage) -- transcribed from a live run. The "gpt-reserve Weekly
// limit" row is a separate credits pool the parser must not confuse with the plan's own weekly
// window.
const codexStatusText = `
  gpt-reserve Weekly limit:   [████████████████████] 100% left (resets 18:15 on 12 Sep)
  5h limit:                   [███████████████████░] 93% left (resets 23:08)
  Weekly limit:               [██████████████░░░░░░] 69% left (resets 22:20 on 6 Sep)
`;

describe("parseClaudeCliUsageText", () => {
  it("reads the session and weekly percentages, converting % used directly (no inversion needed)", () => {
    const parsed = parseClaudeCliUsageText(claudeTextWithMinutes, new Date("2026-09-05T20:00:00"));
    expect(parsed).not.toBeNull();
    expect(parsed!.session.percent).toBe(13);
    expect(parsed!.weekly.percent).toBe(28);
  });
  it("parses an on-the-hour reset time ('at 12pm', no minutes)", () => {
    const parsed = parseClaudeCliUsageText(claudeTextWithMinutes, new Date("2026-09-05T20:00:00"));
    const reset = new Date(parsed!.weekly.resetAt!);
    expect(reset.getMonth()).toBe(8); expect(reset.getDate()).toBe(6);
    expect(reset.getHours()).toBe(12); expect(reset.getMinutes()).toBe(0);
  });
  it("parses a reset time with explicit minutes", () => {
    const parsed = parseClaudeCliUsageText(claudeTextWithMinutes, new Date("2026-09-05T20:00:00"));
    const reset = new Date(parsed!.session.resetAt!);
    expect(reset.getHours()).toBe(22); expect(reset.getMinutes()).toBe(50);
  });
  it("returns null when the expected lines are missing (e.g. a CLI output-format change)", () => {
    expect(parseClaudeCliUsageText("Sign in to continue", new Date())).toBeNull();
  });
});

describe("parseCodexCliStatusText", () => {
  it("normalizes '% left' to '% used' for the plan's 5h and weekly windows", () => {
    const parsed = parseCodexCliStatusText(codexStatusText, new Date("2026-09-05T20:00:00"));
    expect(parsed).not.toBeNull();
    expect(parsed!.fiveHour.percent).toBe(7); // 93% left -> 7% used
    expect(parsed!.weekly.percent).toBe(31); // 69% left -> 31% used
  });
  it("ignores the unrelated 'gpt-reserve Weekly limit' credits row", () => {
    const parsed = parseCodexCliStatusText(codexStatusText, new Date("2026-09-05T20:00:00"));
    // If the gpt-reserve row were picked up instead, weekly would read 0% used (100% left).
    expect(parsed!.weekly.percent).not.toBe(0);
  });
  it("parses a bare 'resets HH:MM' as today, or tomorrow if that time already passed", () => {
    const parsed = parseCodexCliStatusText(codexStatusText, new Date("2026-09-05T20:00:00"));
    const reset = new Date(parsed!.fiveHour.resetAt!);
    expect(reset.getHours()).toBe(23); expect(reset.getMinutes()).toBe(8);
    expect(reset.getDate()).toBe(5); // 23:08 hasn't passed yet at 20:00 the same day
  });
  it("parses a 'resets HH:MM on D Mon' as that date this year", () => {
    const parsed = parseCodexCliStatusText(codexStatusText, new Date("2026-09-05T20:00:00"));
    const reset = new Date(parsed!.weekly.resetAt!);
    expect(reset.getMonth()).toBe(8); expect(reset.getDate()).toBe(6);
    expect(reset.getHours()).toBe(22); expect(reset.getMinutes()).toBe(20);
  });
  it("returns null when the expected rows are missing", () => {
    expect(parseCodexCliStatusText("Ask Codex to do anything", new Date())).toBeNull();
  });
});
