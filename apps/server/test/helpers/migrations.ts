import fs from "node:fs";
import path from "node:path";

// Read from the migrations directory rather than a hand-maintained list. Five separate test
// files previously each hardcoded the same array of filenames, so every new migration broke
// all five until they were updated one at a time -- a failure that says nothing about the code
// under test.
export const migrationFiles = (): string[] =>
  fs.readdirSync(path.resolve("migrations")).filter((name) => name.endsWith(".sql")).sort();

export const migrationSql = (): string[] =>
  migrationFiles().map((file) => fs.readFileSync(path.resolve("migrations", file), "utf8"));
