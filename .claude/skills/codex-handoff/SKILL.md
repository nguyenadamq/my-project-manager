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
- `command -v codex` and `command -v claude` (or `where` on Windows) -- confirms
  both CLIs are installed. If either is missing, tell the user rather than trying
  to substitute something else.
- `git status --porcelain` on the current tree -- just informational. Uncommitted
  changes here are fine and untouched by this skill (everything happens in a
  separate worktree), but mention them to the user if there's a lot, since they
  won't be visible from inside the worktree.

## Pipeline shape: three separate headless stages

This is a fully headless pipeline, not "this conversation plans and reviews,
Codex just codes." Each of the three stages below -- plan, implement, review --
runs as its own subprocess with its own pinned model and reasoning effort, so
the cost/quality tradeoff per stage is explicit and doesn't depend on whatever
this orchestrating session happens to be running at. Default pins (override if
the user asks for different ones for a given task):

| Stage  | Command    | Model         | Effort   |
|--------|------------|---------------|----------|
| Plan   | `claude -p`| `sonnet`      | `high`   |
| Code   | `codex exec` | `gpt-5.6-sol` | `medium` |
| Review | `claude -p`| `sonnet`      | `medium` |

The orchestrating session (you, running this skill) still does the judgment
work a subprocess can't: deciding when the loop is done, creating/cleaning up
the worktree, committing (Codex's sandbox can't, see Step 3), and reporting
back to the user. It just doesn't do the planning or reviewing *itself* --
it dispatches those too, the same way it dispatches the coding.

## Step 1 -- Plan (headless, sonnet/high)

Run from the **original repo directory** (not the worktree -- it doesn't exist
yet), in read-only planning mode so this stage can only investigate, not edit.
Write the plan to a temp file, not into the repo itself -- these intermediate
artifacts are scratch, not something that should show up as an untracked file
in the user's working tree:

```bash
plan_file="$(mktemp -t codex-handoff-plan-XXXX)"

claude -p --model sonnet --effort high --permission-mode plan "$(cat <<'EOF'
Plan an implementation for the following task in this repository. You have no
memory of any prior conversation about it, so investigate the codebase
yourself first (read the relevant files, follow existing conventions) before
writing the plan.

Task: <the user's task description>

Produce a concrete, self-contained implementation plan: name the exact files
involved, the behavior expected, and how to verify it worked (tests/commands
to run). An agent with no other context needs to be able to follow it exactly.
Do not implement anything -- plan only.
EOF
)" < /dev/null > "$plan_file"
```

Read `$plan_file` back before moving on -- if it's vague, underspecified, or the
model asked a clarifying question instead of producing a plan, that's worth
noticing now rather than after Codex has already run on a bad plan.

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

## Step 3 -- Delegate to Codex (headless, gpt-5.6-sol/medium)

Run Codex non-interactively, scoped to the new worktree, with the sandbox set to
allow file writes, and the model/effort pinned explicitly (don't rely on
whatever's in the user's global `~/.codex/config.toml` -- pin it here so this
stage's behavior doesn't silently change if that default is edited later):

```bash
codex exec -s workspace-write -C "<worktree-path>" \
  -c model="gpt-5.6-sol" -c model_reasoning_effort="medium" \
  -o "<worktree-path>/.codex-last-message.txt" "$(cat <<EOF
Implement the following plan in this repository, and run any relevant
tests/checks yourself to confirm it works. Leave the changes as edited files --
you do not need to commit.

$(cat "$plan_file")
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

## Step 4 -- Review (headless, sonnet/medium)

Don't just trust Codex's self-report -- dispatch a fresh, independent review
pass over the actual diff, run from inside the worktree so it can also read
surrounding code for context, not just the patch text:

```bash
cd "<worktree-path>"
review_file="$(mktemp -t codex-handoff-review-XXXX)"
claude -p --model sonnet --effort medium --permission-mode plan "$(cat <<EOF
Review this diff against the plan it was supposed to implement. Read
surrounding code as needed for context -- don't judge the diff in isolation.

Plan:
$(cat "$plan_file")

Diff:
$(git diff <base-branch>...HEAD)

Report: does it actually implement the plan, any correctness bugs, any
scope creep (files touched the plan didn't call for), and whether the
tests/checks the plan called for were actually run and passed (say plainly if
you can't tell, don't assume). End with a one-line verdict: CLEAN or
NEEDS-FIXES.
EOF
)" < /dev/null > "$review_file"
cd -
```

Read `$review_file` yourself before deciding what to do next -- you're the one
accountable to the user for the final call, the subprocess is an input to that
judgment, not a replacement for it.

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
