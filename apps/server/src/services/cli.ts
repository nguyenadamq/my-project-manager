import { spawn } from "node:child_process";
import path from "node:path";

export function runCli(command: string, args: string[], options: { cwd?: string; maxBuffer?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32" && !path.isAbsolute(command),
    });
    const maxBuffer = options.maxBuffer ?? 8_000_000;
    let stdout = "", stderr = "", overflow = false;
    child.stdout.on("data", (chunk: Buffer) => { if (stdout.length + chunk.length <= maxBuffer) stdout += chunk; else overflow = true; });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length + chunk.length <= maxBuffer) stderr += chunk; else overflow = true; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (overflow) return reject(new Error(`${command} output exceeded ${maxBuffer} bytes`));
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${command} exited with code ${code}: ${(stderr || stdout).slice(-4000)}`));
    });
  });
}
