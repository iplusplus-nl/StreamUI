import "./env.js";
import express from "express";
import type { Request, Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleModelsRequest } from "./models.js";
import { handleCreateBugReport } from "./bugReports.js";
import {
  getOpenRouterActivitySnapshot,
  handleArtifactEdit,
  handleCancelChatRun,
  handleChatRunEvents,
  handleOpenRouterChat,
  setOpenRouterDraining,
  waitForOpenRouterIdle
} from "./openrouter.js";
import { handleExportResourceRequest } from "./exportResources.js";
import { handleRetrievalRequest } from "./retrieval.js";
import { handleGetRuntimeSettings } from "./runtimeApiSettings.js";
import {
  handleCreateSessionFile,
  handleDeleteSessionFile,
  handleGetFileContent,
  handleGetSessionIndex,
  handleGetSessionFiles,
  handleGetSessions,
  handleSaveSessions
} from "./sessions.js";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const clientDist = path.join(projectRoot, "dist");

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
const startedAt = new Date().toISOString();
const shutdownGraceMs = parseDurationMs(
  process.env.CHATHTML_SHUTDOWN_GRACE_MS,
  120_000
);
const shutdownIdleMs = parseDurationMs(
  process.env.CHATHTML_SHUTDOWN_IDLE_MS,
  0
);

function parseDurationMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDeployToken(req: Request): string {
  const auth = req.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return req.get("x-chathtml-deploy-token")?.trim() ?? "";
}

function authorizeDeployAdmin(req: Request, res: Response): boolean {
  const expected = process.env.CHATHTML_DEPLOY_TOKEN?.trim();
  if (!expected) {
    res.status(404).json({ error: "Deploy drain endpoint is not configured." });
    return false;
  }
  if (getDeployToken(req) !== expected) {
    res.status(401).json({ error: "Deploy token is invalid." });
    return false;
  }
  return true;
}

app.disable("x-powered-by");
app.use(express.json({ limit: "40mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    startedAt,
    node: process.version,
    activity: getOpenRouterActivitySnapshot()
  });
});

app.post("/api/admin/drain", (req, res) => {
  if (!authorizeDeployAdmin(req, res)) {
    return;
  }
  res.json({
    ok: true,
    activity: setOpenRouterDraining(true)
  });
});

app.delete("/api/admin/drain", (req, res) => {
  if (!authorizeDeployAdmin(req, res)) {
    return;
  }
  res.json({
    ok: true,
    activity: setOpenRouterDraining(false)
  });
});

app.get("/api/admin/deploy-ready", (req, res) => {
  if (!authorizeDeployAdmin(req, res)) {
    return;
  }
  const idleMs = parseDurationMs(
    typeof req.query.idleMs === "string" ? req.query.idleMs : undefined,
    30_000
  );
  const activity = getOpenRouterActivitySnapshot();
  const ready = activity.activeTasks === 0 && activity.idleForMs >= idleMs;
  res.status(ready ? 200 : 409).json({
    ok: ready,
    idleMs,
    activity
  });
});

app.post("/api/chat", handleOpenRouterChat);
app.get("/api/chat/runs/:runId/events", handleChatRunEvents);
app.post("/api/chat/runs/:runId/cancel", handleCancelChatRun);
app.post("/api/artifact-edits", handleArtifactEdit);
app.post("/api/models", handleModelsRequest);
app.post("/api/bug-reports", handleCreateBugReport);
app.post("/api/retrieve", handleRetrievalRequest);
app.get("/api/export-resource", handleExportResourceRequest);
app.get("/api/settings", handleGetRuntimeSettings);
app.get("/api/sessions", handleGetSessions);
app.get("/api/sessions/index", handleGetSessionIndex);
app.post("/api/sessions", handleSaveSessions);
app.put("/api/sessions", handleSaveSessions);
app.get("/api/sessions/:sessionId/files", handleGetSessionFiles);
app.post("/api/sessions/:sessionId/files", handleCreateSessionFile);
app.delete("/api/sessions/:sessionId/files/:fileId", handleDeleteSessionFile);
app.get("/api/files/:fileId/content", handleGetFileContent);

if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.use((req, res, next) => {
    if (req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

const server = app.listen(port, host, () => {
  console.log(`ChatHTML proxy listening on http://${host}:${port}`);
});

let shutdownStarted = false;

function closeServer(): Promise<void> {
  return new Promise((resolve) => {
    server.close((error) => {
      if (error) {
        console.error("Error while closing HTTP server.", error);
      }
      resolve();
    });
  });
}

async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;

  const started = Date.now();
  const initialActivity = setOpenRouterDraining(true);
  console.warn(
    `[shutdown] ${signal} received; draining active_tasks=${initialActivity.activeTasks} grace_ms=${shutdownGraceMs}`
  );

  const shutdownResult = await Promise.race([
    Promise.all([
      closeServer(),
      waitForOpenRouterIdle({
        idleMs: shutdownIdleMs,
        timeoutMs: shutdownGraceMs
      })
    ]).then(([, activity]) => ({ timedOut: false, activity })),
    delay(shutdownGraceMs).then(() => ({
      timedOut: true,
      activity: getOpenRouterActivitySnapshot()
    }))
  ]);

  const durationMs = Date.now() - started;
  if (shutdownResult.timedOut) {
    console.warn(
      `[shutdown] grace period expired duration_ms=${durationMs} active_tasks=${shutdownResult.activity.activeTasks}`
    );
  } else {
    console.info(
      `[shutdown] drained duration_ms=${durationMs} active_tasks=${shutdownResult.activity.activeTasks}`
    );
  }
  process.exit(0);
}

process.once("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

process.once("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});
