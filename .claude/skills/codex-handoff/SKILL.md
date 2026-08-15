---
name: codex-handoff
description: Automates the plan -> implement -> review loop between Claude and OpenAI's Codex CLI. After a plan exists, this skill creates an isolated git worktree, hands the plan to `codex exec` to implement, reviews the resulting diff itself, and loops fixes back to Codex (up to 3 rounds) -- so the user never has to copy a plan or diff between two terminals by hand. Use this whenever the user wants to delegate/hand off an implementation to Codex, says things like "have codex build this", "send this plan to codex", "get codex to code it up", mentions bouncing work between Claude and Codex CLI, wants their plan-then-code-then-review workflow automated, or asks for an isolated branch/worktree where an AI coding agent implements a plan before it gets merged. Trigger this even if the user doesn't name the skill directly or say "codex" explicitly -- any request to plan something here and have a separate coding agent write the code, with Claude reviewing the result, qualifies.
---

# Codex Handoff

## Why this exists

The user's manual workflow is: plan with Claude, copy the plan into Codex CLI, wait
for it to code, copy the result back to Claude to review. The copy-pasting is the
only reason a human has to be in the loop between steps. Both `claude` and `codex`
are ordinary CLIs, and `codex exec` has a non-interactive mode built for exactly
this kind of scripted handoff -- so Claude can drive the whole loop itself with the
Bash tool and only surface the user when there's a real decision to make (does the
final result look right, do you want to merge it).

## Preflight (do this before touching git)

Run these checks with Bash and stop with a clear explanation if any fail -- don't
silently fall back to something riskier:

- `git rev-parse --is-inside-work-tree` -- confirms this is a git repo.
- `command -v codex` (or `where codex` on Windows) -- confirms the Codex CLI is
  installed. If missing, tell the user to install it rather than trying to
  substitute something else.
- `git status --porcelain` on the current tree -- just informational. Uncommitted
  changes here are fine and untouched by this skill (everything happens in a
  separate worktree), but mention them to the user if there's a lot, since they
  won't be visible from inside the worktree.

## Step 1 -- Plan

Produce the implementation plan the same way you normally would (this skill isn't
a replacement for planning quality, just for the handoff after). Make sure the
plan is concrete enough that an agent with no memory of this conversation could
follow it: name the files involved, the behavior expected, and how to verify it
worked (tests to run, commands to try). Codex will receive only what you write
down here -- it doesn't have this conversation's context.

## Step 2 -- Isolate: create a worktree + branch

Never let Codex touch the user's current working directory -- it may have
uncommitted work, and a bad automated run should be trivially discardable. Create
a new branch and worktree as a sibling directory, named after the task:

```bash
slug=<short-kebab-case-description-of-the-task>
git worktree add "../$(basename "$(pwd)")-codex-${slug}" -b "codex/${slug}"
```

**Stdin gotcha (important):** always redirect stdin from `/dev/null` (or `NUL` on a
raw PowerShell invocation) on every `codex exec` / `codex exec resume` call below.
`codex exec` treats a non-terminal stdin as additional piped input and blocks
waiting for EOF before it starts working -- even though the prompt was already
passed as an argument. Without the redirect the process hangs forever with zero
output and zero commits, which looks identical to "still thinking" from the
outside. Always verify a `codex exec` call is actually making progress (new
commits, output file growing) rather than assuming a long runtime means it's
working -- if it's been quiet for a while, check for this before waiting longer.

This branches off whatever HEAD currently is. Note the resulting path (Bash prints
it) -- that's the cwd for every Codex/git command in the following steps, and
what you'll report back to the user at the end.

If `git worktree add` fails (e.g. branch name collision, dirty submodules), report
the actual error to the user rather than retrying blindly.

## Step 3 -- Delegate to Codex

Run Codex non-interactively, scoped to the new worktree, with the sandbox set to
allow file writes:

```bash
codex exec -s workspace-write -C "<worktree-path>" -o "<worktree-path>/.codex-last-message.txt" "$(cat <<'EOF'
Implement the following plan in this repository, and run any relevant
tests/checks yourself to confirm it works. Leave the changes as edited files --
you do not need to commit.

<paste the full plan here>
EOF
)" < /dev/null
```

`-C` points Codex at the worktree regardless of the shell's cwd. `-o` captures
Codex's final summary message to a file you can read back without re-parsing
terminal output. `-s workspace-write` lets it edit/run inside that directory
without interactive approval prompts (which would hang, since this is
non-interactive) but does not grant it network or system-wide access.

**Don't ask Codex to commit.** A git worktree's real `.git` metadata lives
outside the worktree directory (in the main repo's `.git/worktrees/...`), which
`workspace-write`'s sandbox treats as outside the writable root -- `git commit`
inside the sandbox fails with a permission error even though file edits work
fine. Committing is trivial for you to do directly (you're not sandboxed), so
after Codex finishes, inspect and commit the result yourself:

```bash
git -C "<worktree-path>" add -A
git -C "<worktree-path>" commit -m "<describe what was actually implemented>"
```

Read Codex's summary and confirm the tests it claims to have run actually make
sense -- if its sandbox couldn't run them either (missing interpreter, missing
dependency, etc.), say so plainly rather than assuming they passed, and run them
yourself if you can.

## Step 4 -- Review

Review the diff yourself, in the worktree, on its own merits -- don't assume
Codex's summary is accurate, check the actual commits:

```bash
git -C "<worktree-path>" log --oneline <base-branch>..HEAD
git -C "<worktree-path>" diff <base-branch>...HEAD
```

If this repo has a `/code-review` (or similarly named) skill/command available,
prefer using it against this diff -- it's more thorough than a first-pass manual
read. Otherwise review directly for: does it actually implement the plan,
correctness bugs, obvious scope creep (files touched that the plan didn't call
for), and whether tests/checks the plan mentioned were actually run and passed.

## Step 5 -- Loop on real issues

If review turns up genuine problems, send them back into the *same* Codex
session rather than starting fresh -- it keeps full context of what it just
did:

```bash
codex exec resume --last -C "<worktree-path>" -o "<worktree-path>/.codex-last-message.txt" "$(cat <<'EOF'
Review found the following issues -- fix them:

<specific, concrete list of what's wrong and where>
EOF
)" < /dev/null
```

Commit the result yourself again (same reasoning as Step 3 -- Codex's sandbox
can't commit inside a worktree), then repeat Step 4. Cap this at **3 rounds total** (initial implementation +
2 fix rounds). If it's still broken after that, stop -- don't keep spending the
user's time and API usage on a loop that isn't converging. Hand back to the user
with a precise account of what's still wrong; guessing at a 4th fix without their
input is more likely to compound the problem than solve it.

## Step 6 -- Report back, never merge automatically

Whether the loop succeeded or you gave up, tell the user:

- The worktree path and branch name.
- A short summary of what was actually implemented (from your own reading of the
  diff, not just Codex's self-report).
- The outcome of the final review (clean, or what's still wrong).
- Exact commands to act on it -- merging and discarding are both the user's call,
  never do either automatically:

```bash
# to bring it into your main working copy:
git -C "<original-repo-path>" merge codex/<slug>
git worktree remove "<worktree-path>"

# to discard instead:
git worktree remove "<worktree-path>" --force
git branch -D codex/<slug>
```

## Notes

- This skill works in any git repo where both `claude` and `codex` are on PATH --
  it isn't tied to a specific project.
- If a task is trivial enough that planning + a worktree + a subprocess round
  trip is obvious overkill (a one-line fix), say so instead of running the full
  procedure -- the point is removing copy-paste friction from real handoffs, not
  adding ceremony to small ones.
- Windows note: `git worktree add` and `codex exec -C` both take plain paths and
  work the same from PowerShell or a POSIX shell -- just keep path quoting
  consistent with whichever shell tool you're running commands through.
