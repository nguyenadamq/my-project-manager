import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { quoteWindowsArg, runCli } from "../src/services/cli.js";
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
  it("builds the pinned Claude plan arguments, reading the prompt from stdin", () => {
    expect(buildPlanArgs("sonnet", "high")).toEqual(["-p", "-", "--model", "sonnet", "--effort", "high", "--permission-mode", "plan"]);
  });
  it("builds first-run and resume Codex arguments, reading plan/feedback text from stdin", () => {
    const worktree = path.join(os.tmpdir(), "worktree"); const output = path.join(os.tmpdir(), "pm-codex-output-test.txt");
    expect(buildImplementArgs({ worktree, model: "gpt-5.6-sol", effort: "medium" }, output)).toEqual(["exec", "-s", "workspace-write", "-C", worktree, "-c", "model=gpt-5.6-sol", "-c", "model_reasoning_effort=medium", "-o", output, "-"]);
    // `codex exec resume` has no `-C`/`--cd` flag at all -- it resolves the session to resume by
    // matching the process's actual cwd (already set by runCli's own `cwd` option), and passing
    // one anyway is a hard CLI error ("unexpected argument '-C' found").
    expect(buildImplementArgs({ worktree, model: "ignored", effort: "ignored", resume: true }, output)).toEqual(["exec", "resume", "--last", "-o", output, "-"]);
  });
  it("builds the independent Claude review arguments, reading the prompt from stdin", () => expect(buildReviewArgs("sonnet", "medium")).toEqual(["-p", "-", "--model", "sonnet", "--effort", "medium", "--permission-mode", "plan"]));
  it("pipes the prompt through stdin instead of a CLI argument", async () => {
    const result = await runCli(process.execPath, ["-e", "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',(chunk)=>data+=chunk);process.stdin.on('end',()=>console.log(data))"], { stdin: "hello from stdin\nwith a newline" });
    expect(result.stdout.trim()).toBe("hello from stdin\nwith a newline");
  });
});

describe("quoteWindowsArg", () => {
  it("leaves simple arguments untouched", () => {
    expect(quoteWindowsArg("--flag")).toBe("--flag");
    expect(quoteWindowsArg("value")).toBe("value");
    expect(quoteWindowsArg("")).toBe('""');
  });
  it("quotes an argument containing a space, preserving its content", () => {
    expect(quoteWindowsArg("F:\\Coding Practice\\repo")).toBe('"F:\\Coding Practice\\repo"');
  });
  it("escapes embedded quotes and backslashes per the CRT/list2cmdline algorithm", () => {
    expect(quoteWindowsArg('say "hi"')).toBe('"say \\"hi\\""');
  });
});

// Windows-only, and specifically targeting runCli's shell:true (bare, non-absolute command)
// branch -- this is what actually broke in production. Every runCli test above uses
// process.execPath (an absolute path), which never exercises that branch at all; `claude` and
// `codex` are invoked by their bare names by default (see config.ts), so this is the realistic
// case.
(process.platform === "win32" ? describe : describe.skip)("runCli with a bare command name on Windows", () => {
  it("preserves a space inside an argument value through a real subprocess spawn", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pm cli test "));
    const scriptPath = path.join(dir, "argv-echo.mjs");
    await fs.writeFile(scriptPath, "console.log(JSON.stringify(process.argv.slice(2)));");
    try {
      // "node" (bare, not process.execPath) is what forces the shell:true branch.
      const result = await runCli("node", [scriptPath, "-C", dir, "--flag", "value with spaces"]);
      expect(JSON.parse(result.stdout)).toEqual(["-C", dir, "--flag", "value with spaces"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
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
