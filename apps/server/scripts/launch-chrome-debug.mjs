// Launches a dedicated Chrome window with remote debugging enabled, which usage-scraper.ts then
// attaches to over CDP to read the real usage percentages on claude.ai and chatgpt.com.
//
// This uses its OWN profile directory (default apps/server/data/usage-profile, override with
// PM_USAGE_PROFILE_PATH) rather than your everyday one -- Chrome's own security hardening
// refuses to open a debugging port on the default profile at all, full stop, regardless of any
// flag. So the very first run opens a signed-out window: sign into claude.ai and chatgpt.com
// there once, like any normal login (this is a plain, non-automated window; nothing drives it
// until the server reads a page afterward over CDP), and it stays signed in on every later
// launch. It runs alongside your everyday Chrome with no conflict -- separate profile
// directories are independent processes, so there is nothing to close first.
//
//   pnpm --filter @pm/server usage:chrome
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = /:(\d+)\s*$/.exec(process.env.PM_CHROME_CDP_URL ?? "")?.[1] ?? "9222";
const profileDir = path.resolve(process.env.PM_USAGE_PROFILE_PATH?.trim() || path.join(here, "..", "data", "usage-profile"));

// Ordinary install locations per platform, plus the escape hatch for anything unusual. The
// executable is spawned directly (no shell), so a path containing spaces needs no quoting of
// its own -- Node passes each argv entry through intact.
const candidates = {
  win32: [
    process.env["ProgramFiles"] && path.join(process.env["ProgramFiles"], "Google/Chrome/Application/chrome.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Google/Chrome/Application/chrome.exe"),
    process.env["LOCALAPPDATA"] && path.join(process.env["LOCALAPPDATA"], "Google/Chrome/Application/chrome.exe"),
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"],
}[process.platform] ?? [];

const chrome = [process.env.PM_CHROME_EXECUTABLE_PATH?.trim(), ...candidates].find((candidate) => candidate && fs.existsSync(candidate));
if (!chrome) {
  console.error("Couldn't find Chrome. Set PM_CHROME_EXECUTABLE_PATH to its full path and try again.");
  process.exit(1);
}

const firstRun = !fs.existsSync(profileDir);
const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check"];
if (firstRun) args.push("https://claude.ai/settings/usage", "https://chatgpt.com/codex/cloud/settings/analytics#usage");

console.log(`Launching ${chrome} with remote debugging on port ${port}`);
console.log(`  profile: ${profileDir}${firstRun ? " (new -- you will need to sign in)" : ""}`);
// Detached and unref'd so Chrome outlives this command instead of dying with the pnpm process.
spawn(chrome, args, { detached: true, stdio: "ignore" }).unref();
console.log(firstRun
  ? "First run: sign into both accounts in the window that just opened, then leave it running."
  : "Done. Leave that window running -- Project Manager reads its usage pages on an interval.");
