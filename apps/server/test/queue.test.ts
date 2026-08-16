import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { EventHub } from "../src/events.js";
import { QueueService, type PromptRunner } from "../src/services/queue.js";
import fs from "node:fs";
import path from "node:path";

const migration = fs.readFileSync(path.resolve("migrations/001_initial.sql"), "utf8");
const runner: PromptRunner = { run: async () => ({ branch: "pm/test", summary: "1 file changed" }) };
let db: DatabaseSync; let queue: QueueService;

beforeEach(() => {
  db = new DatabaseSync(":memory:"); db.exec(migration);
  db.prepare("INSERT INTO projects(id,name,path,status,added_at) VALUES('p','Test','.', 'active',?)").run(new Date().toISOString());
  queue = new QueueService(db, new EventHub(), runner);
});

describe("prompt queue", () => {
  it("appends prompts in FIFO positions", () => {
    expect(queue.add("p", "first").position).toBe(1);
    expect(queue.add("p", "second").position).toBe(2);
    expect(queue.list("p").map((q) => q.text)).toEqual(["first", "second"]);
  });
  it("allows a queued prompt to be cancelled", () => {
    const item = queue.add("p", "later");
    expect(queue.update(item.id, { status: "cancelled" }).status).toBe("cancelled");
  });
  it("reorders without duplicating positions", () => {
    queue.add("p", "first"); const second = queue.add("p", "second"); queue.add("p", "third");
    queue.update(second.id, { position: 1 });
    expect(queue.list("p").map((q) => [q.text, q.position])).toEqual([["second", 1], ["first", 2], ["third", 3]]);
  });
});
