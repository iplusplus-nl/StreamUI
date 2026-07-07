import "./env.js";
import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleModelsRequest } from "./models.js";
import { handleChatRunEvents, handleOpenRouterChat } from "./openrouter.js";
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

app.disable("x-powered-by");
app.use(express.json({ limit: "24mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    startedAt,
    node: process.version
  });
});

app.post("/api/chat", handleOpenRouterChat);
app.get("/api/chat/runs/:runId/events", handleChatRunEvents);
app.post("/api/models", handleModelsRequest);
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

app.listen(port, host, () => {
  console.log(`ChatHTML proxy listening on http://${host}:${port}`);
});
