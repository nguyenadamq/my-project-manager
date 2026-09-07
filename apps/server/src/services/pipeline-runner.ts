import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { collectBaseline, collectDelta } from "./git.js";
import { runCli } from "./cli.js";

// Forwarded straight from runCli's onChunk (see cli.ts): a live slice of that stage's own CLI
// output, as it's produced. Optional everywhere below -- a caller that doesn't pass one just
// gets the existing buffered-until-exit behavior.
type OutputListener = (stream: "stdout" | "stderr", chunk: string) => void;

export interface PlanInput { repo: string; prompt: string; model: string; effort: string; onOutput?: OutputListener }
// `summary` is what the approval screen shows by default (see QueueItem.tsx): a short,
// human-facing readout of what's about to happen, distinct from `text` (the full plan, which
// still gets edited/approved/fed to the implement stage verbatim -- the summary is purely a
// concise front for reviewing it, not a replacement for it).
export interface PlanResult { text: string; reviewPrompt: string; checkpoints?: string[]; summary?: string }
export interface ImplementInput { worktree: string; planText: string; model: string; effort: string; resume?: boolean; feedback?: string; checkpoints?: string[]; onOutput?: OutputListener }
export interface ReviewInput { worktree: string; planText: string; reviewPrompt: string; baseRef: string; model: string; effort: string; onOutput?: OutputListener }
export interface ReviewResult { verdict: "CLEAN" | "NEEDS-FIXES"; notes: string }

export interface PipelineRunner {
  plan(input: PlanInput): Promise<PlanResult>;
  implement(input: ImplementInput): Promise<string>;
  review(input: ReviewInput): Promise<ReviewResult>;
}

// Used whenever the planner's response doesn't include a parseable "## REVIEW INSTRUCTIONS"
// section (see splitPlanAndReviewPrompt) -- this is exactly the instruction review() always
// gave before it started asking the planner for bespoke ones, so a parsing miss degrades to
// the old generic behavior instead of failing the plan stage outright.
export const DEFAULT_REVIEW_PROMPT = "Report correctness bugs, missing requirements, scope creep, and verification gaps.";

// The planner is asked to hand back two sections under fixed headings (case-insensitive, any
// amount of markdown emphasis/heading punctuation around them) rather than making a second,
// separate model call for the review prompt -- a second call would re-read the same repository
// context from scratch and roughly double the token cost this is meant to reduce for a single
// plan stage. Splits on the LAST such heading line so a plan that happens to mention the phrase
// "review instructions" in passing earlier in its prose doesn't truncate the plan section.
const REVIEW_SECTION_HEADING = /^[#*\s]*review instructions[#*\s:]*$/i;
// Same tolerant heading match as REVIEW_SECTION_HEADING, one section earlier: "## CHECKPOINTS"
// plus whatever markdown emphasis/punctuation the model wraps it in.
const CHECKPOINTS_SECTION_HEADING = /^[#*\s]*checkpoints[#*\s:]*$/i;
// A checkpoint list item: "1. Add the migration" / "2) Wire up the route", etc. Only lines
// that actually look like a numbered list item become a checkpoint -- stray prose in that
// section (a one-line intro sentence, say) is silently ignored rather than becoming a bogus
// checkpoint.
const CHECKPOINT_ITEM = /^\s*\d+[.)]\s+(.+)$/;
// Unlike the other two sections, SUMMARY comes first in the prompt (it's the thing meant to be
// read before the detailed plan below it), so it's found by scanning forward for the first
// match rather than backward for the last -- and its own content runs until whichever of the
// other section headings comes next, not to the end of the response.
const SUMMARY_SECTION_HEADING = /^[#*\s]*summary[#*\s:]*$/i;
const NEXT_SECTION_HEADINGS = [/^[#*\s]*implementation plan[#*\s:]*$/i, CHECKPOINTS_SECTION_HEADING, REVIEW_SECTION_HEADING];

function parseCheckpointList(raw: string): string[] {
  const items: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = CHECKPOINT_ITEM.exec(line);
    if (match) items.push(match[1]!.trim());
  }
  return items;
}

// Pulls the SUMMARY section (if present) out of the response entirely -- both its own content
// and the heading/body lines themselves are removed from what's returned as `rest`, so the
// existing plan/checkpoints/review splitting below never has to know this section exists.
function extractSummary(lines: string[]): { summary: string; rest: string[] } {
  let start = -1;
  for (let i = 0; i < lines.length; i++) { if (SUMMARY_SECTION_HEADING.test(lines[i]!.trim())) { start = i; break; } }
  if (start === -1) return { summary: "", rest: lines };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) { if (NEXT_SECTION_HEADINGS.some((heading) => heading.test(lines[i]!.trim()))) { end = i; break; } }
  return { summary: lines.slice(start + 1, end).join("\n").trim(), rest: [...lines.slice(0, start), ...lines.slice(end)] };
}

export function splitPlanAndReviewPrompt(stdout: string): PlanResult {
  const { summary, rest } = extractSummary(stdout.split(/\r?\n/));
  const lines = rest;
  let reviewIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (REVIEW_SECTION_HEADING.test(lines[i]!.trim())) { reviewIndex = i; break; }
  }
  const reviewPrompt = reviewIndex === -1 ? DEFAULT_REVIEW_PROMPT : (lines.slice(reviewIndex + 1).join("\n").trim() || DEFAULT_REVIEW_PROMPT);
  const beforeReview = reviewIndex === -1 ? lines : lines.slice(0, reviewIndex);

  // Same "scan from the end" approach as the review heading, and for the same reason: a plan
  // that happens to mention the word "checkpoints" in passing earlier in its prose shouldn't
  // truncate the plan section at that point instead of the real heading.
  let checkpointsIndex = -1;
  for (let i = beforeReview.length - 1; i >= 0; i--) {
    if (CHECKPOINTS_SECTION_HEADING.test(beforeReview[i]!.trim())) { checkpointsIndex = i; break; }
  }
  const checkpoints = checkpointsIndex === -1 ? [] : parseCheckpointList(beforeReview.slice(checkpointsIndex + 1).join("\n"));
  const planLines = checkpointsIndex === -1 ? beforeReview : beforeReview.slice(0, checkpointsIndex);

  const text = planLines.join("\n").trim() || stdout.trim();
  return { text, reviewPrompt, checkpoints, summary };
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

// PM_CHECKPOINT is a plain shell command Codex is asked to actually run (not just mention in
// its own prose) once it finishes each checkpoint, in order -- see queue.ts's captureOutput,
// which watches the live stdout stream for this exact line shape and turns it into a
// job.checkpoint event. Running it as a real command means it shows up in the transcript
// whether or not the model remembers to narrate its own progress, but it is still the same
// agent grading its own work: a skipped, miscounted, or out-of-order marker is possible, so
// this is a best-effort progress indicator, not a verified one.
export function checkpointMarkerCommand(index: number, total: number, description: string): string {
  return `echo "PM_CHECKPOINT ${index}/${total}: ${description}"`;
}

export function buildImplementStdin(planText: string, checkpoints: string[] | undefined): string {
  if (!checkpoints?.length) return planText;
  const total = checkpoints.length;
  const list = checkpoints.map((description, i) => `${i + 1}. ${description}`).join("\n");
  const example = checkpointMarkerCommand(1, total, "short description of what you just finished");
  return `${planText}\n\nCHECKPOINT PROGRESS REPORTING: This plan has been broken into ${total} checkpoints:\n${list}\n\nImmediately after finishing each checkpoint, in order, run it as an actual shell command before moving on to the next one (not just written in your response text) -- for example, after checkpoint 1:\n  ${example}\nSubstitute the real checkpoint number and a short description each time. Run this once per checkpoint, in order, so progress can be tracked while you work.`;
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
    const prompt = `Plan an implementation for this task. Inspect the repository context below. Do not edit files. This is a non-interactive, headless run: there is no one to approve a plan via a tool call, so do not attempt to call ExitPlanMode or any other approval tool.\n\nProduce exactly four sections, in this order, each starting with its own heading line exactly as shown below (so they can be split apart programmatically):\n\n## SUMMARY\nA short, plain-English readout for a human deciding whether to approve this, not a developer reading code: 2-5 sentences or a few short bullet points covering (1) what feature or behavior is being added or changed, (2) briefly how, in plain terms, and (3) what will be tested or verified. No file paths, no code, no restating the plan verbatim -- someone approving this should be able to read only this section and understand what's about to happen.\n\n## IMPLEMENTATION PLAN\nA concrete plan for the code agent that will implement this: naming files, behavior, edge cases, and verification steps.\n\n## CHECKPOINTS\nThe same plan broken into 3-8 concrete, sequential, independently-completable milestones, as a markdown numbered list ("1. ...", "2. ..."). Each one should be a short, self-contained description of one discrete unit of work the implementer can finish and report before moving to the next. Skip this section (write nothing under the heading) if the task is genuinely too small or exploratory to break down usefully -- don't force a list onto one-line changes.\n\n## REVIEW INSTRUCTIONS\nSpecific, concrete criteria for independently reviewing the implementation against this exact plan afterward -- what to check file-by-file, the failure modes most likely for this specific change, and what would count as scope creep here. This is read by a separate reviewer who does not see this planning session, so make it self-contained; do not just say "review the plan."\n\nTASK:\n${input.prompt}\n\nREPOSITORY CONTEXT:\n${context}`;
    const { stdout } = await runCli(this.claudeCliPath, buildPlanArgs(input.model, input.effort), { cwd: input.repo, stdin: prompt, timeoutMs: this.timeoutMs, onChunk: input.onOutput });
    if (!stdout.trim()) throw new Error("Plan stage returned no output");
    return splitPlanAndReviewPrompt(stdout);
  }

  async implement(input: ImplementInput) {
    const stdin = input.resume ? (input.feedback ?? "Address the review findings and complete the approved plan.") : buildImplementStdin(input.planText, input.checkpoints);
    // Outside the worktree (see buildImplementArgs's comment) and unique per call so concurrent
    // jobs -- or a fix round following a first pass -- never collide on the same path.
    const outputFile = path.join(os.tmpdir(), `pm-codex-output-${randomUUID()}.txt`);
    try {
      const { stdout } = await runCli(this.codexCliPath, buildImplementArgs(input, outputFile), { cwd: input.worktree, stdin, timeoutMs: this.timeoutMs, onChunk: input.onOutput });
      const captured = await fs.readFile(outputFile, "utf8").catch(() => stdout);
      return captured.trim() || "Codex completed without a summary message.";
    } finally {
      await fs.rm(outputFile, { force: true }).catch(() => {});
    }
  }

  async review(input: ReviewInput) {
    const diff = await collectDelta(input.worktree, input.baseRef, "HEAD");
    const instructions = input.reviewPrompt?.trim() || DEFAULT_REVIEW_PROMPT;
    const prompt = `Review this implementation against the approved plan. This is a non-interactive, headless run: there is no one to approve anything via a tool call, so do not attempt to call ExitPlanMode or any other approval tool -- just answer in plain markdown.\n\n${instructions}\n\nEnd with exactly CLEAN or NEEDS-FIXES on its own final line.\n\nAPPROVED PLAN:\n${input.planText}\n\nIMPLEMENTATION DIFF:\n${diff}`;
    const { stdout } = await runCli(this.claudeCliPath, buildReviewArgs(input.model, input.effort), { cwd: input.worktree, stdin: prompt, timeoutMs: this.timeoutMs, onChunk: input.onOutput });
    return extractVerdict(stdout);
  }
}
