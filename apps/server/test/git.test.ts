import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree, git, installPostCommitHook } from "../src/services/git.js";

let root: string; let repo: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-git-"));
  repo = path.join(root, "repo"); fs.mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("git()", () => {
  it("returns trimmed stdout on success", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "x");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
    expect(await git(repo, ["ls-files"])).toBe("a.txt");
  });

  // This is the exact bug a real, previously-undebuggable pipeline failure surfaced: git's
  // "fatal: ..." explanation lives on the rejected error's `.stderr`, not `.message`, so
  // without this the user only ever saw "Command failed: git ... <args>" with no reason.
  it("includes git's actual stderr explanation in the thrown error, not just the bare command line", async () => {
    await expect(git(repo, ["rev-parse", "nonexistent-branch"])).rejects.toThrow(/unknown revision|fatal/i);
  });
});

describe("installPostCommitHook", () => {
  // Worktrees share their main repo's hooks, so this hook also fires on commits made inside a
  // pipeline's own isolated `.pm/worktrees/<jobId>` worktree -- caught live by an independent
  // review flagging the trigger file it wrote there as unplanned scope creep once a later
  // pipeline commit's `git add -A` swept it up. The hook must no-op there, not just in the
  // project's own primary checkout.
  it("does not write a trigger file for a commit made inside a linked worktree", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "x");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
    await installPostCommitHook(repo);
    fs.rmSync(path.join(repo, ".pm", "trigger"), { force: true }); // clear the initial-install trigger

    const { worktree } = await createWorktree(repo, "job1");
    fs.writeFileSync(path.join(worktree, "b.txt"), "y");
    execFileSync("git", ["-C", worktree, "add", "-A"]);
    execFileSync("git", ["-C", worktree, "commit", "-m", "pm: implement job1"]);

    expect(fs.existsSync(path.join(worktree, ".pm", "trigger"))).toBe(false);
    // A `git add -A` in that worktree (as the pipeline's own fix-round commit does) must not
    // pick up a trigger file that was never written.
    expect(await git(worktree, ["status", "--porcelain"])).toBe("");
  });

  it("still writes a trigger file for an ordinary commit in the project's own primary checkout", async () => {
    await installPostCommitHook(repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "x");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
    expect(fs.existsSync(path.join(repo, ".pm", "trigger"))).toBe(true);
  });

  it("repairs an already-installed hook from an older version of this app", async () => {
    await installPostCommitHook(repo);
    const hookPath = path.join(repo, ".git", "hooks", "post-commit");
    // Simulate a hook installed before the linked-worktree guard existed.
    fs.writeFileSync(hookPath, '#!/bin/sh\n# my-project-manager-trigger\nmkdir -p "$(git rev-parse --show-toplevel)/.pm"\ngit rev-parse HEAD > "$(git rev-parse --show-toplevel)/.pm/trigger"\n', { mode: 0o755 });

    await installPostCommitHook(repo);

    const upgraded = fs.readFileSync(hookPath, "utf8");
    expect(upgraded).toContain('if [ -d "$toplevel/.git" ]');
  });
});
