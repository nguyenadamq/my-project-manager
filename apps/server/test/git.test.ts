import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "../src/services/git.js";

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
