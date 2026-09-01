import { spawn } from "node:child_process";
import path from "node:path";

// Claude Code and Codex both authenticate through their own CLI login (a Pro/Max or
// ChatGPT subscription session stored by the CLI itself) rather than an API key. This
// server process may separately hold an ANTHROPIC_API_KEY for the unrelated
// summary-synthesis feature (see summaries.ts) -- stripping these before every spawn
// keeps that key from leaking into the child and silently switching Claude Code (or
// Codex, for the OpenAI-side equivalents) from subscription auth to pay-per-token API
// billing.
const CREDENTIAL_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "AZURE_OPENAI_API_KEY"];

function subscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of CREDENTIAL_ENV_VARS) delete env[name];
  return env;
}

// MS CRT / list2cmdline-style argument quoting. Confirmed live to matter: when `shell: true` is
// used on Windows (see below), Node.js does NOT reliably quote array elements containing spaces
// before handing them to cmd.exe -- an argument like a worktree path under this project's own
// real "Coding Practice" folder arrives at the child process split into two separate argv
// entries at the space, silently corrupting `-C <path>`/`-o <path>` and the like. Wrapping any
// argument that needs it in a properly backslash-escaped quoted string, per the same algorithm
// Python's subprocess.list2cmdline() and the Windows CRT itself use, is the fix.
export function quoteWindowsArg(arg: string): string {
  if (arg === "") return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let result = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") { backslashes++; continue; }
    if (ch === '"') { result += "\\".repeat(backslashes * 2 + 1) + '"'; backslashes = 0; continue; }
    result += "\\".repeat(backslashes) + ch; backslashes = 0;
  }
  result += "\\".repeat(backslashes * 2) + '"';
  return result;
}

export function runCli(command: string, args: string[], options: { cwd?: string; stdin?: string; maxBuffer?: number; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const useShell = process.platform === "win32" && !path.isAbsolute(command);
    // With useShell, the entire quoted command line is built ourselves and passed as the sole
    // `command` argument (args omitted) -- passing `command` and `args` separately here would
    // hand the array straight to Node's own unreliable Windows quoting (see quoteWindowsArg's
    // comment). Without useShell (an absolute path, or a non-Windows OS), Node's normal
    // CreateProcess-based array argument passing is already correct on its own.
    const child = useShell
      ? spawn([command, ...args].map(quoteWindowsArg).join(" "), {
          cwd: options.cwd, env: subscriptionEnv(),
          stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
          windowsHide: true, shell: true,
        })
      : spawn(command, args, {
          cwd: options.cwd, env: subscriptionEnv(),
          // stdin stays "ignore" (immediately closed) unless the caller has content to pipe in
          // -- see the write below. Piping the prompt through stdin instead of a CLI argument
          // avoids Windows' ~8K command-line length limit and cmd.exe's own quoting/percent-
          // expansion hazards on large, free-text repository context and plan text.
          stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
          windowsHide: true, shell: false,
        });
    if (options.stdin !== undefined) {
      // The child may exit (e.g. it never reads stdin, or dies early) before this write
      // finishes; that surfaces as an EPIPE on the stream, not a promise rejection here --
      // the 'close'/'error' handlers below already report the real outcome, so swallow it.
      child.stdin!.on("error", () => {});
      child.stdin!.end(options.stdin, "utf8");
    }
    const maxBuffer = options.maxBuffer ?? 8_000_000;
    const timeoutMs = options.timeoutMs ?? 20 * 60_000;
    // Buffers are accumulated raw and decoded once at the end (not chunk-by-chunk)
    // so a multi-byte UTF-8 character split across two "data" events decodes correctly.
    const stdoutChunks: Buffer[] = []; const stderrChunks: Buffer[] = [];
    let stdoutLength = 0, stderrLength = 0, overflow = false, settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms and was terminated`));
    }, timeoutMs);
    // stdout/stderr are always requested as "pipe" above regardless of the stdin branch, so
    // these are never actually null -- the conditional first element of `stdio` just widens
    // TypeScript's inferred tuple type past what it can narrow on its own.
    child.stdout!.on("data", (chunk: Buffer) => { if (stdoutLength + chunk.length <= maxBuffer) { stdoutChunks.push(chunk); stdoutLength += chunk.length; } else overflow = true; });
    child.stderr!.on("data", (chunk: Buffer) => { if (stderrLength + chunk.length <= maxBuffer) { stderrChunks.push(chunk); stderrLength += chunk.length; } else overflow = true; });
    child.on("error", (error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (overflow) return reject(new Error(`${command} output exceeded ${maxBuffer} bytes`));
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${command} exited with code ${code}: ${(stderr || stdout).slice(-4000)}`));
    });
  });
}
