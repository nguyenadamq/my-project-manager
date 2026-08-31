import fs from "node:fs/promises";
import path from "node:path";
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

export function buildImplementArgs(input: Omit<ImplementInput, "planText" | "feedback">) {
  const output = path.join(input.worktree, ".codex-last-message.txt");
  if (input.resume) return ["exec", "resume", "--last", "-C", input.worktree, "-o", output, "-"];
  return ["exec", "-s", "workspace-write", "-C", input.worktree, "-c", `model=${input.model}`, "-c", `model_reasoning_effort=${input.effort}`, "-o", output, "-"];
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
    const prompt = `Plan an implementation for this task. Inspect the repository context below. Do not edit files. Produce a concrete plan naming files, behavior, edge cases, and verification.\n\nTASK:\n${input.prompt}\n\nREPOSITORY CONTEXT:\n${context}`;
    const { stdout } = await runCli(this.claudeCliPath, buildPlanArgs(input.model, input.effort), { cwd: input.repo, stdin: prompt, timeoutMs: this.timeoutMs });
    if (!stdout.trim()) throw new Error("Plan stage returned no output");
    return stdout.trim();
  }

  async implement(input: ImplementInput) {
    const stdin = input.resume ? (input.feedback ?? "Address the review findings and complete the approved plan.") : input.planText;
    const { stdout } = await runCli(this.codexCliPath, buildImplementArgs(input), { cwd: input.worktree, stdin, timeoutMs: this.timeoutMs });
    const outputFile = path.join(input.worktree, ".codex-last-message.txt");
    const captured = await fs.readFile(outputFile, "utf8").catch(() => stdout);
    return captured.trim() || "Codex completed without a summary message.";
  }

  async review(input: ReviewInput) {
    const diff = await collectDelta(input.worktree, input.baseRef, "HEAD");
    const prompt = `Review this implementation against the approved plan. Report correctness bugs, missing requirements, scope creep, and verification gaps. End with exactly CLEAN or NEEDS-FIXES on its own final line.\n\nAPPROVED PLAN:\n${input.planText}\n\nIMPLEMENTATION DIFF:\n${diff}`;
    const { stdout } = await runCli(this.claudeCliPath, buildReviewArgs(input.model, input.effort), { cwd: input.worktree, stdin: prompt, timeoutMs: this.timeoutMs });
    return extractVerdict(stdout);
  }
}
