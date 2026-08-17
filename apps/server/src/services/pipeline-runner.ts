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

export function buildPlanArgs(prompt: string, model: string, effort: string) {
  return ["-p", prompt, "--model", model, "--effort", effort, "--permission-mode", "plan"];
}

export function buildImplementArgs(input: ImplementInput) {
  const output = path.join(input.worktree, ".codex-last-message.txt");
  if (input.resume) return ["exec", "resume", "--last", "-C", input.worktree, "-o", output, input.feedback ?? "Address the review findings and complete the approved plan."];
  return ["exec", "-s", "workspace-write", "-C", input.worktree, "-c", `model=${input.model}`, "-c", `model_reasoning_effort=${input.effort}`, "-o", output, input.planText];
}

export function buildReviewArgs(prompt: string, model: string, effort: string) {
  return ["-p", prompt, "--model", model, "--effort", effort, "--permission-mode", "plan"];
}

export class RealPipelineRunner implements PipelineRunner {
  async plan(input: PlanInput) {
    const context = await collectBaseline(input.repo);
    const prompt = `Plan an implementation for this task. Inspect the repository context below. Do not edit files. Produce a concrete plan naming files, behavior, edge cases, and verification.\n\nTASK:\n${input.prompt}\n\nREPOSITORY CONTEXT:\n${context}`;
    const { stdout } = await runCli("claude", buildPlanArgs(prompt, input.model, input.effort), { cwd: input.repo });
    if (!stdout.trim()) throw new Error("Plan stage returned no output");
    return stdout.trim();
  }

  async implement(input: ImplementInput) {
    const { stdout } = await runCli("codex", buildImplementArgs(input), { cwd: input.worktree });
    const outputFile = path.join(input.worktree, ".codex-last-message.txt");
    const captured = await fs.readFile(outputFile, "utf8").catch(() => stdout);
    return captured.trim() || "Codex completed without a summary message.";
  }

  async review(input: ReviewInput) {
    const diff = await collectDelta(input.worktree, input.baseRef, "HEAD");
    const prompt = `Review this implementation against the approved plan. Report correctness bugs, missing requirements, scope creep, and verification gaps. End with exactly CLEAN or NEEDS-FIXES on its own final line.\n\nAPPROVED PLAN:\n${input.planText}\n\nIMPLEMENTATION DIFF:\n${diff}`;
    const { stdout } = await runCli("claude", buildReviewArgs(prompt, input.model, input.effort), { cwd: input.worktree });
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const verdict = lines.at(-1);
    if (verdict !== "CLEAN" && verdict !== "NEEDS-FIXES") throw new Error("Review did not end with a CLEAN or NEEDS-FIXES verdict");
    const parsed: ReviewResult["verdict"] = verdict;
    return { verdict: parsed, notes: lines.slice(0, -1).join("\n").trim() || parsed };
  }
}
