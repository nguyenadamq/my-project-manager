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
import { SummaryService } from "./services/summaries.js";
import { QueueService, ClaudePromptRunner, type PromptRunner } from "./services/queue.js";
import { UsageService } from "./services/usage.js";
import { TriggerWatcher } from "./services/watcher.js";

export interface BuildOptions { db?: Db; runner?: PromptRunner; startWatcher?: boolean }

export async function buildApp(config: Config, options: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  const db = options.db ?? createDatabase(config.databasePath);
  const events = new EventHub();
  const projects = new ProjectService(db, config);
  const summaries = new SummaryService(db, events);
  const queue = new QueueService(db, events, options.runner ?? new ClaudePromptRunner(), config.concurrency);
  const usage = new UsageService(db, config, events);
  const watcher = new TriggerWatcher(db, summaries, config.syncDebounceMs);
  const background = new Set<Promise<unknown>>();
  const schedule = (task: Promise<unknown>) => {
    background.add(task);
    void task.catch((error) => app.log.error(error)).finally(() => background.delete(task));
  };

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
  app.post<{ Body: { path: string; name?: string } }>("/api/projects", async (request, reply) => {
    const project = await projects.add(request.body.path, request.body.name);
    watcher.addProject(project.path);
    schedule(summaries.sync(project.id, true));
    return reply.code(201).send(project);
  });
  app.get<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => projects.get(request.params.id) ?? reply.code(404).send({ error: "Project not found" }));
  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (request, reply) => {
    const project = projects.get(request.params.id);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    watcher.removeProject(project.path); projects.remove(project.id); return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/projects/:id/refresh", async (request, reply) => { await summaries.sync(request.params.id, true); return reply.code(202).send({ accepted: true }); });
  app.get<{ Params: { id: string } }>("/api/projects/:id/queue", async (request) => queue.list(request.params.id));
  app.post<{ Params: { id: string }; Body: { text: string } }>("/api/projects/:id/queue", async (request, reply) => reply.code(201).send(queue.add(request.params.id, request.body.text)));
  app.patch<{ Params: { promptId: string }; Body: { text?: string; position?: number; status?: "cancelled" } }>("/api/queue/:promptId", async (request) => queue.update(request.params.promptId, request.body));
  app.post<{ Params: { promptId: string } }>("/api/queue/:promptId/push", async (request, reply) => {
    setImmediate(() => schedule(queue.push(request.params.promptId)));
    return reply.code(202).send({ accepted: true });
  });
  app.get("/api/usage", async () => usage.snapshot());
  app.post<{ Body: { note?: string } }>("/api/usage/chatgpt/log", async (request, reply) => { usage.logChatGpt(request.body?.note); return reply.code(201).send({ logged: true }); });
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
  if (options.startWatcher !== false) watcher.start();
  app.addHook("onClose", async () => { await watcher.stop(); await Promise.allSettled(background); db.close(); });
  return app;
}
