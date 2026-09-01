import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import staticPlugin from "@fastify/static";
import path from "node:path";
import fs from "node:fs";
import type { Config } from "./config.js";
import { createDatabase, type Db } from "./db.js";
import { EventHub } from "./events.js";
import { ProjectService } from "./services/projects.js";
import { BrowseService } from "./services/browse.js";
import { SummaryService } from "./services/summaries.js";
import { QueueService } from "./services/queue.js";
import { RealPipelineRunner, type PipelineRunner } from "./services/pipeline-runner.js";
import { SettingsService } from "./services/settings.js";
import { UsageService } from "./services/usage.js";
import { UsageScraper } from "./services/usage-scraper.js";
import { AutoDispatchService, AutoDispatchSettingsStore } from "./services/auto-dispatch.js";
import { TriggerWatcher } from "./services/watcher.js";
import type { AutoDispatchSettings, DispatchMode, PipelineMode, PipelineOverrides } from "@pm/shared";

export interface BuildOptions { db?: Db; runner?: PipelineRunner; startWatcher?: boolean }

export async function buildApp(config: Config, options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  const db = options.db ?? createDatabase(config.databasePath);
  const events = new EventHub();
  const projects = new ProjectService(db, config);
  const browse = new BrowseService(db, config);
  const summaries = new SummaryService(db, events);
  const settings = new SettingsService(db);
  const queue = new QueueService(db, events, options.runner ?? new RealPipelineRunner(config.cliTimeoutMs, config.claudeCliPath, config.codexCliPath), settings, config.concurrency);
  const usage = new UsageService(db, config, events);
  const usageScraper = new UsageScraper(db, events, { enabled: config.usageScrapeEnabled, intervalMs: config.usageScrapeIntervalMs, cdpUrl: config.chromeCdpUrl });
  const autoDispatchSettings = new AutoDispatchSettingsStore(db);
  const watcher = new TriggerWatcher(db, summaries, config.syncDebounceMs);
  const background = new Set<Promise<unknown>>();
  const schedule = (task: Promise<unknown>) => {
    background.add(task);
    void task.catch((error) => app.log.error(error)).finally(() => background.delete(task));
  };
  const autoDispatch = new AutoDispatchService(db, queue, autoDispatchSettings, schedule);
  let autoDispatchTimer: ReturnType<typeof setInterval> | null = null;

  // Fastify's stock JSON parser rejects a request that declares `Content-Type: application/json`
  // but sends no body ("Body cannot be empty..."), which is exactly what a plain
  // `curl -X DELETE -H 'Content-Type: application/json'` or a client that sets the header
  // globally produces. Several routes here legitimately take no payload (push, approve-plan,
  // refresh, scrape-now, delete), so an empty body is read as "no body" rather than a 400. A
  // body that is present but malformed is still a 400, as it should be.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const text = typeof body === "string" ? body.trim() : "";
    if (!text) return done(null, undefined);
    try { done(null, JSON.parse(text)); } catch (error) { done(error as Error, undefined); }
  });

  await app.register(cors, { origin: false });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  await app.register(websocket);
  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/api/health" || !request.url.startsWith("/api/")) return;
    if (request.headers.authorization !== `Bearer ${config.authToken}`) return reply.code(401).send({ error: "Unauthorized" });
  });
  app.setErrorHandler((error, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/i.test(message) ? 404 : /duplicate|UNIQUE/i.test(message) ? 409 : 400;
    return reply.code(status).send({ error: message });
  });

  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/projects", async () => projects.list());
  // Backs the folder picker: with no `path`, lists the allowed roots to start from.
  app.get<{ Querystring: { path?: string } }>("/api/browse", async (request) => browse.browse(request.query.path));
  app.post<{ Body: { path: string; name?: string } }>("/api/projects", async (request, reply) => {
    const project = await projects.add(request.body.path, request.body.name);
    watcher.addProject(project.path);
    schedule(summaries.sync(project.id, true));
    return reply.code(201).send(project);
  });
  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => projects.get(request.params.id) ?? reply.code(404).send({ error: "Project not found" }));
  app.patch<{ Params: { id: string }; Body: { pipelineOverrides?: PipelineOverrides | null; priority?: number } }>("/api/projects/:id", async (request) => {
    if (!projects.get(request.params.id)) throw new Error("Project not found");
    if (request.body.pipelineOverrides !== undefined) {
      if (request.body.pipelineOverrides) settings.validate(request.body.pipelineOverrides);
      projects.setPipelineOverrides(request.params.id, request.body.pipelineOverrides);
    }
    if (request.body.priority !== undefined) projects.setPriority(request.params.id, request.body.priority);
    return projects.get(request.params.id)!;
  });
  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const project = projects.get(request.params.id);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    watcher.removeProject(project.path); projects.remove(project.id); return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/projects/:id/refresh", async (request, reply) => { await summaries.sync(request.params.id, true); return reply.code(202).send({ accepted: true }); });
  app.get<{ Params: { id: string } }>("/api/projects/:id/queue", async (request) => queue.list(request.params.id));
  app.post<{ Params: { id: string }; Body: { text: string; overrides?: PipelineOverrides; mode?: PipelineMode; dispatch?: DispatchMode } }>("/api/projects/:id/queue", async (request, reply) => {
    const item = queue.add(request.params.id, request.body.text, request.body.overrides, request.body.mode, request.body.dispatch);
    // Instant mode: kick the pipeline off right now instead of waiting for an explicit push or
    // for auto-dispatch to choose it. Deliberately the same call the push route makes, so an
    // instant item is in every other respect an ordinary queue item -- it still waits for a
    // free concurrency slot, still runs in its own worktree, and is still cancellable while it
    // waits. The response is not held for it; progress arrives over the websocket.
    //
    // A `full`-mode item plans eagerly regardless of dispatch: the plan stage never writes to
    // the repo, and implementation still can't start until a human approves the plan either
    // way, so "queue it" waiting on the plan too just means a stale plan sits undrafted until
    // someone pushes it -- the queued/instant distinction only has teeth once there's a
    // human checkpoint downstream to actually gate. `implement_only` has no such checkpoint
    // (runPlanStage runs the implementation directly for that mode -- see queue.ts), so it
    // keeps the original wait-for-push-or-instant behavior unchanged.
    if (item.dispatch === "instant" || item.mode === "full") setImmediate(() => schedule(queue.runPlanStage(item.id)));
    return reply.code(201).send(item);
  });
  app.patch<{ Params: { promptId: string }; Body: { text?: string; position?: number; status?: "cancelled" } }>("/api/queue/:promptId", async (request) => queue.update(request.params.promptId, request.body));
  app.patch<{ Params: { promptId: string }; Body: { text: string } }>("/api/queue/:promptId/plan", async (request) => queue.editPlan(request.params.promptId, request.body.text));
  app.post<{ Params: { promptId: string } }>("/api/queue/:promptId/push", async (request, reply) => {
    setImmediate(() => schedule(queue.runPlanStage(request.params.promptId)));
    return reply.code(202).send({ accepted: true });
  });
  app.post<{ Params: { promptId: string } }>("/api/queue/:promptId/approve-plan", async (request, reply) => {
    await queue.approvePlan(request.params.promptId);
    setImmediate(() => schedule(queue.runImplementReviewLoop(request.params.promptId)));
    return reply.code(202).send({ accepted: true });
  });
  app.post<{ Params: { promptId: string }; Body: { instructions?: string } }>("/api/queue/:promptId/request-fixes", async (request, reply) => {
    queue.requestMoreFixes(request.params.promptId, request.body?.instructions);
    setImmediate(() => schedule(queue.runImplementReviewLoop(request.params.promptId, false)));
    return reply.code(202).send({ accepted: true });
  });
  app.post<{ Params: { promptId: string } }>("/api/queue/:promptId/retry", async (request, reply) => {
    const item = await queue.retryFailed(request.params.promptId);
    // Only implement/review needs to be kicked off here -- a retry that landed back on
    // 'queued' waits for the normal explicit push, same as any other queued item. retryFailed
    // can resume into either 'implementing' (fresh pass) or 'fixing' (resuming a prior Codex
    // session), and runImplementReviewLoop accepts both.
    if (item.status === "implementing" || item.status === "fixing") setImmediate(() => schedule(queue.runImplementReviewLoop(item.id)));
    return reply.code(202).send({ accepted: true });
  });
  app.get<{ Params: { promptId: string } }>("/api/queue/:promptId/events", async (request) => queue.listEvents(request.params.promptId));
  app.get("/api/settings/pipeline", async () => settings.getGlobalDefaults());
  app.put<{ Body: PipelineOverrides }>("/api/settings/pipeline", async (request) => settings.setGlobalDefaults(request.body));
  app.get("/api/usage", async () => usage.snapshot());
  app.post<{ Body: { note?: string } }>("/api/usage/chatgpt/log", async (request, reply) => { usage.logChatGpt(request.body?.note); return reply.code(201).send({ logged: true }); });
  app.post("/api/usage/scrape-now", async () => { await usageScraper.scrapeOnce(); return usage.snapshot(); });
  app.get("/api/settings/auto-dispatch", async () => autoDispatchSettings.get());
  app.put<{ Body: Partial<AutoDispatchSettings> }>("/api/settings/auto-dispatch", async (request) => autoDispatchSettings.set(request.body));
  app.get<{ Querystring: { token?: string } }>("/ws", { websocket: true }, (socket, request) => {
    if (request.query.token !== config.authToken) return socket.close(1008, "Unauthorized");
    const unsubscribe = events.subscribe((event) => socket.send(JSON.stringify(event)));
    socket.on("close", unsubscribe);
  });

  const webRoot = path.resolve(process.cwd(), "../web/dist");
  if (fs.existsSync(webRoot)) {
    await app.register(staticPlugin, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => request.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html"));
  }
  if (options.startWatcher !== false) {
    watcher.start();
    usageScraper.start();
    // Runs independently of the usage-scraper interval: auto-dispatch reacts to whatever
    // usage reading is on hand right now (live, estimated, or unknown -- see
    // requiredPoolsOk), it doesn't need a fresh scrape to have just happened.
    autoDispatchTimer = setInterval(() => schedule(usage.snapshot().then((snapshot) => autoDispatch.tick(snapshot))), 60_000);
  }
  app.addHook("onClose", async () => {
    if (autoDispatchTimer) clearInterval(autoDispatchTimer);
    usageScraper.stop();
    await watcher.stop();
    await Promise.allSettled(background);
    db.close();
  });
  return app;
}
