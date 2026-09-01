import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { collectBaseline, collectDelta } from "./git.js";
import { runCli } from "./cli.js";

export interface PlanInput { repo: string; prompt: string; model: string; effort: string }
export interface ImplementInput { worktree: string; planText: string; model: string; effort: string; resume?: boolean; feedback?: string }
export interface ReviewInput { worktree: string; planText: string; baseRef: string; model: string; effort: string }
export interface ReviewResult { verdict: "CLEAN" | "NEEDS-FIXES"; notes: string }

export interface PipelineRunner {
  plan(input: PlanInput): Promise<string>;
  implement(input: ImplementInput): Promise<string>;
  review(input: ReviewInput): Promise<ReviewResult>;
}

// Prompt/plan/feedback text is always piped through stdin (the "-" placeholder below) rather
// than embedded as a CLI argument: repository context and plan text can run to hundreds of KB,
// well past Windows' ~8K command-line limit, and free-text passed as an argument through
// cmd.exe (see cli.ts's shell:true on Windows) is subject to its own quoting/percent-expansion
// hazards. Both `claude -p` and `codex exec` read the prompt from stdin when given "-".
export function buildPlanArgs(model: string, effort: string) {
  return ["-p", "-", "--model", model, "--effort", effort, "--permission-mode", "plan"];
}

// `outputFile` is caller-supplied rather than derived from `worktree` so it can live outside
// the worktree entirely (see implement() below) -- writing it inside the worktree used to mean
// a plain `git add -A` there staged Codex's own completion-message file alongside the agent's
// real changes, silently committing it into the user's branch (caught by a live review: a
// NEEDS-FIXES verdict for "scope creep" over a file the approved plan never mentioned).
// `codex exec resume` also does not accept `-C`/`--cd` at all (unlike plain `codex exec`) -- it
// resolves the session to resume by matching the process's actual cwd, which `runCli` already
// sets via its own `cwd` option, so passing it again here as a CLI flag only produced
// "unexpected argument '-C' found" and hard-failed every fix round.
export function buildImplementArgs(input: Omit<ImplementInput, "planText" | "feedback">, outputFile: string) {
  if (input.resume) return ["exec", "resume", "--last", "-o", outputFile, "-"];
  return ["exec", "-s", "workspace-write", "-C", input.worktree, "-c", `model=${input.model}`, "-c", `model_reasoning_effort=${input.effort}`, "-o", outputFile, "-"];
}

export function buildReviewArgs(model: string, effort: string) {
  return ["-p", "-", "--model", model, "--effort", effort, "--permission-mode", "plan"];
}

// Scans from the end of the response for a line that is *just* CLEAN or NEEDS-FIXES
// once markdown emphasis/quote/code-fence punctuation is stripped, rather than requiring
// literally the last raw line to match. This tolerates a trailing footer, banner, or
// closing code fence the CLI appends after the model's actual verdict.
export function extractVerdict(stdout: string): ReviewResult {
  const lines = stdout.split(/\r?\n/);
  const clean = (line: string) => line.trim().replace(/^[*_`#>\s-]+|[*_`.\s]+$/g, "");
  for (let i = lines.length - 1; i >= 0; i--) {
    const token = clean(lines[i]!).toUpperCase();
    if (token === "CLEAN" || token === "NEEDS-FIXES") {
      const notes = lines.slice(0, i).join("\n").trim() || token;
      return { verdict: token as ReviewResult["verdict"], notes };
    }
  }
  throw new Error("Review did not include a CLEAN or NEEDS-FIXES verdict line");
}

export class RealPipelineRunner implements PipelineRunner {
  constructor(private timeoutMs?: number, private claudeCliPath = "claude", private codexCliPath = "codex") {}

  async plan(input: PlanInput) {
    const context = await collectBaseline(input.repo);
    // --permission-mode plan (below) is used purely to keep this stage read-only; there is no
    // interactive reviewer to call ExitPlanMode on in this headless `-p` run, and without this
    // instruction the model tries anyway, finds the tool unavailable, and pollutes the captured
    // plan text with a note about the failed attempt instead of just answering in prose -- this
    // stdout is stored verbatim as the plan (and fed into the review stage below), so it must be
    // ready to display and act on as-is.
    const prompt = `Plan an implementation for this task. Inspect the repository context below. Do not edit files. This is a non-interactive, headless run: there is no one to approve a plan via a tool call, so do not attempt to call ExitPlanMode or any other approval tool -- just write the complete plan as your final answer in plain markdown, naming files, behavior, edge cases, and verification.\n\nTASK:\n${input.prompt}\n\nREPOSITORY CONTEXT:\n${context}`;
    const { stdout } = await runCli(this.claudeCliPath, buildPlanArgs(input.model, input.effort), { cwd: input.repo, stdin: prompt, timeoutMs: this.timeoutMs });
    if (!stdout.trim()) throw new Error("Plan stage returned no output");
    return stdout.trim();
  }

  async implement(input: ImplementInput) {
    const stdin = input.resume ? (input.feedback ?? "Address the review findings and complete the approved plan.") : input.planText;
    // Outside the worktree (see buildImplementArgs's comment) and unique per call so concurrent
    // jobs -- or a fix round following a first pass -- never collide on the same path.
    const outputFile = path.join(os.tmpdir(), `pm-codex-output-${randomUUID()}.txt`);
    try {
      const { stdout } = await runCli(this.codexCliPath, buildImplementArgs(input, outputFile), { cwd: input.worktree, stdin, timeoutMs: this.timeoutMs });
      const captured = await fs.readFile(outputFile, "utf8").catch(() => stdout);
      return captured.trim() || "Codex completed without a summary message.";
    } finally {
      await fs.rm(outputFile, { force: true }).catch(() => {});
    }
  }

  async review(input: ReviewInput) {
    const diff = await collectDelta(input.worktree, input.baseRef, "HEAD");
    const prompt = `Review this implementation against the approved plan. This is a non-interactive, headless run: there is no one to approve anything via a tool call, so do not attempt to call ExitPlanMode or any other approval tool -- just answer in plain markdown. Report correctness bugs, missing requirements, scope creep, and verification gaps. End with exactly CLEAN or NEEDS-FIXES on its own final line.\n\nAPPROVED PLAN:\n${input.planText}\n\nIMPLEMENTATION DIFF:\n${diff}`;
    const { stdout } = await runCli(this.claudeCliPath, buildReviewArgs(input.model, input.effort), { cwd: input.worktree, stdin: prompt, timeoutMs: this.timeoutMs });
    return extractVerdict(stdout);
  }
}
