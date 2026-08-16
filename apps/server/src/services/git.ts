import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(repo: string, args: string[], maxBuffer = 2_000_000): Promise<string> {
  const { stdout } = await exec("git", ["-C", repo, ...args], { maxBuffer });
  return stdout.trim();
}

export async function assertGitRepository(repo: string): Promise<void> {
  if ((await git(repo, ["rev-parse", "--is-inside-work-tree"])) !== "true") throw new Error("Path is not a git repository");
}

export async function getRepoMetadata(repo: string) {
  const [sha, root] = await Promise.all([git(repo, ["rev-parse", "HEAD"]), git(repo, ["rev-parse", "--show-toplevel"])]);
  let remote: string | null = null;
  try { remote = await git(repo, ["remote", "get-url", "origin"]); } catch { /* optional */ }
  return { sha, root: path.resolve(root), remote };
}

export async function installPostCommitHook(repo: string): Promise<void> {
  const gitDir = await git(repo, ["rev-parse", "--git-dir"]);
  const hookPath = path.resolve(repo, gitDir, "hooks", "post-commit");
  const marker = "# my-project-manager-trigger";
  let existing = "#!/bin/sh\n";
  try { existing = await fs.readFile(hookPath, "utf8"); } catch { /* new hook */ }
  if (!existing.includes(marker)) {
    const line = `${marker}\nmkdir -p \"$(git rev-parse --show-toplevel)/.pm\"\ngit rev-parse HEAD > \"$(git rev-parse --show-toplevel)/.pm/trigger\"\n`;
    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    await fs.writeFile(hookPath, `${existing.trimEnd()}\n${line}`, { mode: 0o755 });
  }
  await fs.mkdir(path.join(repo, ".pm"), { recursive: true });
}

export async function writeTrigger(repo: string, sha?: string): Promise<void> {
  await fs.mkdir(path.join(repo, ".pm"), { recursive: true });
  await fs.writeFile(path.join(repo, ".pm", "trigger"), `${sha ?? await git(repo, ["rev-parse", "HEAD"])}\n`);
}

export async function collectBaseline(repo: string): Promise<string> {
  const [log, files, readme] = await Promise.all([
    git(repo, ["log", "--oneline", "-50"]),
    git(repo, ["ls-files"]),
    fs.readFile(path.join(repo, "README.md"), "utf8").catch(() => ""),
  ]);
  return `COMMITS\n${log}\n\nFILES\n${files.slice(0, 30_000)}\n\nREADME\n${readme.slice(0, 20_000)}`;
}

export async function collectDelta(repo: string, fromSha: string, toSha: string): Promise<string> {
  const [log, diff] = await Promise.all([
    git(repo, ["log", "--stat", "--oneline", `${fromSha}..${toSha}`]),
    git(repo, ["diff", "--no-ext-diff", "--unified=1", fromSha, toSha], 8_000_000),
  ]);
  return `${log}\n\n${diff}`.slice(0, 45_000);
}
