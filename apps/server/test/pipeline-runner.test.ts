import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/services/cli.js";
import { buildImplementArgs, buildPlanArgs, buildReviewArgs } from "../src/services/pipeline-runner.js";

describe("pipeline CLI", () => {
  it("closes stdin so a subprocess can exit", async () => {
    const result = await runCli(process.execPath, ["-e", "process.stdin.resume();process.stdin.on('end',()=>console.log('closed'))"]);
    expect(result.stdout.trim()).toBe("closed");
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
