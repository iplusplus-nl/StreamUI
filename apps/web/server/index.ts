import "./env.js";
import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleOpenRouterChat } from "./openrouter.js";
import { handleRetrievalRequest } from "./retrieval.js";
import { handleGetSessions, handleSaveSessions } from "./sessions.js";

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
app.post("/api/retrieve", handleRetrievalRequest);
app.get("/api/sessions", handleGetSessions);
app.put("/api/sessions", handleSaveSessions);

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
  console.log(`StreamUI proxy listening on http://${host}:${port}`);
});
