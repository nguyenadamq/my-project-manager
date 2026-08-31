// One-command first-time setup: writes a .env with a freshly generated auth token and a sane
// PM_ALLOWED_ROOTS for this machine, so a new clone is runnable without hand-editing anything.
// Never overwrites an existing .env -- re-running it on a configured checkout is a no-op that
// just reports what is already there.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(repoRoot, ".env");
const examplePath = path.join(repoRoot, ".env.example");

if (fs.existsSync(envPath)) {
  console.log(`.env already exists at ${envPath} -- leaving it untouched.`);
  console.log("Delete it first if you want a fresh one generated.");
  process.exit(0);
}

// Default the allow-list to the folder that contains this repository: for the common layout
// (a folder full of checkouts) that is exactly the set of repos worth registering, and it is
// always a real, existing path on this machine. Edit it afterward to taste.
const defaultRoot = path.dirname(repoRoot);
const token = crypto.randomBytes(32).toString("base64url");

const example = fs.readFileSync(examplePath, "utf8");
const configured = example
  .replace(/^PM_AUTH_TOKEN=.*$/m, `PM_AUTH_TOKEN=${token}`)
  // Escaped for .env parsing on Windows, where a backslash path would otherwise be read as an
  // escape sequence.
  .replace(/^PM_ALLOWED_ROOTS=.*$/m, `PM_ALLOWED_ROOTS=${defaultRoot.replaceAll("\\", "\\\\")}`);

fs.writeFileSync(envPath, configured);
console.log(`Wrote ${envPath}`);
console.log("  PM_AUTH_TOKEN   generated (32 random bytes) -- this is what the web UI asks for");
console.log(`  PM_ALLOWED_ROOTS ${defaultRoot}`);
console.log("");
console.log("Edit PM_ALLOWED_ROOTS if your repositories live elsewhere, then run: pnpm start");
