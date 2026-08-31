import fs from "node:fs/promises";
import path from "node:path";
import type { BrowseEntry, BrowseResult } from "@pm/shared";
import type { Db } from "../db.js";
import type { Config } from "../config.js";

// Directories that are never worth showing in a repository picker: they are large, noisy, and
// can never themselves be a project root worth registering.
const hidden = new Set(["node_modules", ".git", ".pm", "dist", "build", "coverage", ".next", ".turbo", "$RECYCLE.BIN", "System Volume Information"]);

// Backs the folder picker in the PWA, so registering a project is "click through your allowed
// roots and pick the repo" instead of "type an absolute path exactly right". Every path it
// returns is verified (via realpath, so a symlink can't step out) to sit inside
// PM_ALLOWED_ROOTS -- this is a read-only directory listing, but it is still an authenticated
// endpoint that reveals folder names, so it must never wander outside the same allow-list that
// gates registration itself.
export class BrowseService {
  constructor(private db: Db, private config: Config) {}

  private contains(real: string): boolean {
    return this.config.allowedRoots.some((root) => real === root || real.startsWith(`${root}${path.sep}`));
  }

  private registeredPaths(): Set<string> {
    return new Set((this.db.prepare("SELECT path FROM projects").all() as { path: string }[]).map((row) => row.path));
  }

  async browse(requested?: string | null): Promise<BrowseResult> {
    const registered = this.registeredPaths();
    // No path yet: offer the allowed roots themselves as the starting points, rather than
    // guessing one. With a single configured root this still shows exactly one entry to open,
    // which keeps the first click identical no matter how many roots exist.
    if (!requested?.trim()) {
      const entries = await Promise.all(this.config.allowedRoots.map((root) => this.describe(root, registered)));
      return { path: null, parent: null, current: null, entries: entries.filter((entry): entry is BrowseEntry => entry !== null) };
    }
    const real = await fs.realpath(path.resolve(requested)).catch(() => { throw new Error("Folder not found"); });
    if (!this.contains(real)) throw new Error("Folder is outside PM_ALLOWED_ROOTS");
    const children = await fs.readdir(real, { withFileTypes: true }).catch(() => { throw new Error("Folder could not be read"); });
    const described = await Promise.all(children
      .filter((child) => child.isDirectory() && !hidden.has(child.name) && !child.name.startsWith("."))
      .map((child) => this.describe(path.join(real, child.name), registered)));
    const entries = described
      .filter((entry): entry is BrowseEntry => entry !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
    // Only offer "up" while the parent is still inside an allowed root; at a root itself this
    // is null and the UI falls back to the roots list.
    const parentPath = path.dirname(real);
    const parent = parentPath !== real && this.contains(parentPath) ? parentPath : null;
    return { path: real, parent, current: await this.describe(real, registered), entries };
  }

  private async describe(dir: string, registered: Set<string>): Promise<BrowseEntry | null> {
    // A directory that disappeared or can't be read (permissions, a dead junction) is simply
    // omitted rather than failing the whole listing.
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) return null;
    // `.git` is a directory in a normal clone and a file in a linked worktree; either means
    // "this folder is a repository", so stat rather than a directory-only check.
    const isGitRepo = await fs.stat(path.join(dir, ".git")).then(() => true).catch(() => false);
    return { name: path.basename(dir), path: dir, isGitRepo, isRegistered: registered.has(dir) };
  }
}
