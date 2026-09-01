import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function git(repo: string, args: string[], maxBuffer = 2_000_000): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", repo, ...args], { maxBuffer });
    return stdout.trim();
  } catch (error) {
    // execFile's rejection carries the actual reason on `.stderr` (git always writes its
    // "fatal: ..." explanation there), but `.message` alone is just "Command failed: git ...
    // <args>" with no explanation -- exactly the dead-end error a failed plan/review stage
    // previously surfaced to the user with no way to tell what actually went wrong.
    const stderr = (error as { stderr?: string }).stderr?.trim();
    if (stderr) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
    throw error;
  }
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

// Git worktrees (including the isolated `.pm/worktrees/<jobId>` ones a pipeline run creates)
// share their main repo's hooks -- there is no per-worktree hooks directory -- so this hook
// fires on the "pm: implement"/"pm: fix round" commits queue.ts makes too, not just on ordinary
// commits to the project's own primary checkout. An earlier version had no guard against that:
// `git rev-parse --show-toplevel` inside a linked worktree resolves to the *worktree's own*
// root, so the hook happily wrote `<worktree>/.pm/trigger` there, and the pipeline's own
// `git add -A` on its *next* commit (a fix round) swept that leftover file into the generated
// branch -- caught live by an independent review flagging it as unplanned scope creep, the same
// class of bug fixed for `.codex-last-message.txt` above. `.git` is a directory in a repo's
// primary checkout and a `gitdir: ...` pointer *file* in a linked worktree, so checking that
// distinguishes the two without embedding this repo's own path (and its escaping/format hazards
// across OSes) into the hook script at all.
const TRIGGER_MARKER = "# my-project-manager-trigger";
const OLD_TRIGGER_BODY = `${TRIGGER_MARKER}\nmkdir -p \"$(git rev-parse --show-toplevel)/.pm\"\ngit rev-parse HEAD > \"$(git rev-parse --show-toplevel)/.pm/trigger\"\n`;
const TRIGGER_BODY = `${TRIGGER_MARKER}\ntoplevel=\"$(git rev-parse --show-toplevel)\"\nif [ -d \"$toplevel/.git\" ]; then\n  mkdir -p \"$toplevel/.pm\"\n  git rev-parse HEAD > \"$toplevel/.pm/trigger\"\nfi\n`;

export async function installPostCommitHook(repo: string): Promise<void> {
  const gitDir = await git(repo, ["rev-parse", "--git-dir"]);
  const hookPath = path.resolve(repo, gitDir, "hooks", "post-commit");
  let existing = "#!/bin/sh\n";
  try { existing = await fs.readFile(hookPath, "utf8"); } catch { /* new hook */ }
  let updated: string | null = null;
  if (existing.includes(OLD_TRIGGER_BODY)) {
    // Repair a hook installed by an older version of this app on an already-registered project.
    updated = existing.replace(OLD_TRIGGER_BODY, TRIGGER_BODY);
  } else if (!existing.includes(TRIGGER_MARKER)) {
    updated = `${existing.trimEnd()}\n${TRIGGER_BODY}`;
  }
  if (updated !== null) {
    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    await fs.writeFile(hookPath, updated, { mode: 0o755 });
  }
  await fs.mkdir(path.join(repo, ".pm"), { recursive: true });
}

export async function writeTrigger(repo: string, sha?: string): Promise<void> {
  await fs.mkdir(path.join(repo, ".pm"), { recursive: true });
  await fs.writeFile(path.join(repo, ".pm", "trigger"), `${sha ?? await git(repo, ["rev-parse", "HEAD"])}\n`);
}

export async function createWorktree(repo: string, promptId: string) {
  const { sha: baseSha } = await getRepoMetadata(repo);
  const branch = `pm/${promptId}`;
  const worktree = path.join(repo, ".pm", "worktrees", promptId);
  await fs.mkdir(path.dirname(worktree), { recursive: true });
  await git(repo, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
  return { worktree, branch, baseSha };
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
