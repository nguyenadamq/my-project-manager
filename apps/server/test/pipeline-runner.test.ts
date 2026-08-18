import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/services/cli.js";
import { buildImplementArgs, buildPlanArgs, buildReviewArgs, extractVerdict } from "../src/services/pipeline-runner.js";

describe("pipeline CLI", () => {
  it("closes stdin so a subprocess can exit", async () => {
    const result = await runCli(process.execPath, ["-e", "process.stdin.resume();process.stdin.on('end',()=>console.log('closed'))"]);
    expect(result.stdout.trim()).toBe("closed");
  });
  it("kills a hung subprocess after the timeout instead of blocking forever", async () => {
    await expect(runCli(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 200 })).rejects.toThrow(/timed out/);
  });
  it("decodes a multi-byte UTF-8 character split across separate stdout chunks", async () => {
    const script = "const bytes = Buffer.from([0xE2, 0x82, 0xAC]); process.stdout.write(bytes.subarray(0, 1)); setTimeout(() => process.stdout.write(bytes.subarray(1)), 20);";
    const result = await runCli(process.execPath, ["-e", script]);
    expect(result.stdout).toBe("€");
  });
  it("builds the pinned Claude plan arguments", () => {
    expect(buildPlanArgs("plan prompt", "sonnet", "high")).toEqual(["-p", "plan prompt", "--model", "sonnet", "--effort", "high", "--permission-mode", "plan"]);
  });
  it("builds first-run and resume Codex arguments", () => {
    const worktree = path.join(os.tmpdir(), "worktree"); const output = path.join(worktree, ".codex-last-message.txt");
    expect(buildImplementArgs({ worktree, planText: "approved", model: "gpt-5.6-sol", effort: "medium" })).toEqual(["exec", "-s", "workspace-write", "-C", worktree, "-c", "model=gpt-5.6-sol", "-c", "model_reasoning_effort=medium", "-o", output, "approved"]);
    expect(buildImplementArgs({ worktree, planText: "approved", model: "ignored", effort: "ignored", resume: true, feedback: "fix it" })).toEqual(["exec", "resume", "--last", "-C", worktree, "-o", output, "fix it"]);
  });
  it("builds the independent Claude review arguments", () => expect(buildReviewArgs("review prompt", "sonnet", "medium")).toEqual(["-p", "review prompt", "--model", "sonnet", "--effort", "medium", "--permission-mode", "plan"]));
});

describe("verdict extraction", () => {
  it("finds an exact verdict as the last line", () => {
    expect(extractVerdict("Looks solid.\n\nCLEAN").verdict).toBe("CLEAN");
  });
  it("tolerates markdown emphasis and trailing footers after the verdict", () => {
    expect(extractVerdict("Reviewed the diff.\n\n**CLEAN**\n\n(cost: $0.02, 12s)").verdict).toBe("CLEAN");
    expect(extractVerdict("Found a bug in the parser.\n\nNEEDS-FIXES\n").verdict).toBe("NEEDS-FIXES");
  });
  it("throws a clear error when no verdict line is present", () => {
    expect(() => extractVerdict("This response never states a verdict.")).toThrow(/CLEAN or NEEDS-FIXES/);
  });
});
