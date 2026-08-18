import { spawn } from "node:child_process";
import path from "node:path";

export function runCli(command: string, args: string[], options: { cwd?: string; maxBuffer?: number; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32" && !path.isAbsolute(command),
    });
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
    child.stdout.on("data", (chunk: Buffer) => { if (stdoutLength + chunk.length <= maxBuffer) { stdoutChunks.push(chunk); stdoutLength += chunk.length; } else overflow = true; });
    child.stderr.on("data", (chunk: Buffer) => { if (stderrLength + chunk.length <= maxBuffer) { stderrChunks.push(chunk); stderrLength += chunk.length; } else overflow = true; });
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
