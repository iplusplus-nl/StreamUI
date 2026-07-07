import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ArtifactShareThemeMode = "day" | "night";

export type ArtifactShareRecord = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  themeMode: ArtifactShareThemeMode;
  document: string;
  sourceMessageId?: string;
};

export type ArtifactSharePublishResult = {
  experimental: false;
  id: string;
  path: string;
  record: ArtifactShareRecord;
  reused: boolean;
  url: string;
};

const ARTIFACT_SHARE_MAX_DOCUMENT_CHARS = 5_000_000;
const ARTIFACT_SHARE_ID_PATTERN = /^share-[a-z0-9-]{12,80}$/;
const DEFAULT_PUBLIC_ORIGIN = "http://127.0.0.1:8787";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(projectRoot, "../..");
const sessionsDir = path.resolve(
  process.env.STREAMUI_SESSION_DIR || path.join(workspaceRoot, "sessions")
);
const artifactSharesDir = path.resolve(
  process.env.STREAMUI_ARTIFACT_SHARE_DIR ||
    path.join(sessionsDir, "artifact-shares")
);

class ArtifactShareError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function getString(input: unknown): string {
  return typeof input === "string" ? input : "";
}

function normalizeTitle(input: unknown): string {
  return getString(input).trim().replace(/\s+/g, " ").slice(0, 120) || "Artifact";
}

function normalizeThemeMode(input: unknown): ArtifactShareThemeMode {
  return input === "day" ? "day" : "night";
}

function normalizeSourceMessageId(input: unknown): string | undefined {
  const value = getString(input).trim().slice(0, 180);
  return value || undefined;
}

function createShareId(): string {
  return `share-${Date.now().toString(36)}-${randomUUID()
    .replace(/-/g, "")
    .slice(0, 18)}`;
}

function getSharePath(id: string): string {
  if (!ARTIFACT_SHARE_ID_PATTERN.test(id)) {
    throw new ArtifactShareError(404, "Artifact share not found.");
  }

  return path.join(artifactSharesDir, `${id}.json`);
}

function getRequestOrigin(req: Request): string {
  const forwardedProto = getString(req.headers["x-forwarded-proto"])
    .split(",")[0]
    .trim();
  const forwardedHost = getString(req.headers["x-forwarded-host"])
    .split(",")[0]
    .trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host") || "127.0.0.1:8787";
  return `${protocol}://${host}`;
}

function normalizePublicOrigin(input: string): string {
  return input.trim().replace(/\/+$/, "") || DEFAULT_PUBLIC_ORIGIN;
}

export function getArtifactSharePath(id: string): string {
  if (!ARTIFACT_SHARE_ID_PATTERN.test(id)) {
    throw new ArtifactShareError(404, "Artifact share not found.");
  }

  return `/artifacts/${encodeURIComponent(id)}`;
}

export function getArtifactSharePublicOrigin(): string {
  return normalizePublicOrigin(
    process.env.CHATHTML_PUBLIC_URL ||
      process.env.STREAMUI_PUBLIC_URL ||
      process.env.PUBLIC_URL ||
      DEFAULT_PUBLIC_ORIGIN
  );
}

export function getArtifactSharePublicUrl(
  id: string,
  origin = getArtifactSharePublicOrigin()
): string {
  return `${normalizePublicOrigin(origin)}${getArtifactSharePath(id)}`;
}

function createRecord(input: unknown): ArtifactShareRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ArtifactShareError(400, "Artifact share payload is required.");
  }

  const body = input as {
    document?: unknown;
    html?: unknown;
    sourceMessageId?: unknown;
    themeMode?: unknown;
    title?: unknown;
  };
  const documentInput = getString(body.document);
  const htmlInput = getString(body.html);
  const document = documentInput.trim() ? documentInput : htmlInput;
  if (!document.trim()) {
    throw new ArtifactShareError(400, "Artifact document is required.");
  }
  if (document.length > ARTIFACT_SHARE_MAX_DOCUMENT_CHARS) {
    throw new ArtifactShareError(413, "Artifact document is too large.");
  }

  return {
    id: createShareId(),
    title: normalizeTitle(body.title),
    createdAt: new Date().toISOString(),
    themeMode: normalizeThemeMode(body.themeMode),
    document,
    sourceMessageId: normalizeSourceMessageId(body.sourceMessageId)
  };
}

async function findShareRecordBySourceMessageId(
  sourceMessageId: string
): Promise<ArtifactShareRecord | null> {
  let entries: string[];
  try {
    entries = await readdir(artifactSharesDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) {
      continue;
    }

    try {
      const record = JSON.parse(
        await readFile(path.join(artifactSharesDir, entry), "utf8")
      ) as ArtifactShareRecord;
      if (
        ARTIFACT_SHARE_ID_PATTERN.test(record.id) &&
        record.sourceMessageId === sourceMessageId
      ) {
        return record;
      }
    } catch {
      // Ignore stale or malformed share records.
    }
  }

  return null;
}

export async function createOrUpdateArtifactShareRecord(
  input: unknown
): Promise<{ record: ArtifactShareRecord; reused: boolean }> {
  const nextRecord = createRecord(input);
  const existingRecord = nextRecord.sourceMessageId
    ? await findShareRecordBySourceMessageId(nextRecord.sourceMessageId)
    : null;

  if (!existingRecord) {
    return { record: nextRecord, reused: false };
  }

  return {
    record: reuseArtifactShareRecord(nextRecord, existingRecord),
    reused: true
  };
}

export function reuseArtifactShareRecord(
  nextRecord: ArtifactShareRecord,
  existingRecord: ArtifactShareRecord
): ArtifactShareRecord {
  return {
    ...nextRecord,
    id: existingRecord.id,
    createdAt: existingRecord.createdAt,
    updatedAt: nextRecord.createdAt
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeJsonScript(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function createArtifactSharePageHtml(record: ArtifactShareRecord): string {
  const title = escapeHtml(record.title);
  const themeClass = record.themeMode === "day" ? "theme-day" : "theme-night";

  return `<!doctype html>
<html lang="en" class="${themeClass}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: dark;
      --page-bg: #09090b;
      --text: #f4f4f5;
      --muted: #a1a1aa;
      --border: rgba(255, 255, 255, 0.12);
      --panel: rgba(24, 24, 27, 0.88);
    }
    .theme-day {
      color-scheme: light;
      --page-bg: #fafafa;
      --text: #18181b;
      --muted: #71717a;
      --border: #e4e4e7;
      --panel: rgba(255, 255, 255, 0.92);
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; margin: 0; }
    body {
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background: var(--page-bg);
    }
    .share-shell {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .share-header {
      display: flex;
      min-height: 44px;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      background: var(--panel);
      backdrop-filter: blur(14px);
    }
    .share-title {
      min-width: 0;
      overflow: hidden;
      color: var(--text);
      font-size: 13px;
      font-weight: 620;
      line-height: 1.3;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .share-badge {
      flex: 0 0 auto;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 3px 8px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 650;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    .share-main {
      width: min(1200px, 100%);
      margin: 0 auto;
      padding: 18px 14px 28px;
    }
    iframe {
      display: block;
      width: 100%;
      height: calc(100vh - 90px);
      min-height: 360px;
      border: 0;
      background: transparent;
    }
  </style>
</head>
<body>
  <main class="share-shell">
    <header class="share-header">
      <div class="share-title">${title}</div>
      <div class="share-badge">ChatHTML</div>
    </header>
    <section class="share-main">
      <iframe id="artifact-frame" title="${title}" sandbox="allow-scripts allow-forms allow-popups allow-downloads" referrerpolicy="no-referrer"></iframe>
    </section>
  </main>
  <script id="artifact-document" type="application/json">${safeJsonScript(
    record.document
  )}</script>
  <script>
    const frame = document.getElementById("artifact-frame");
    const documentPayload = document.getElementById("artifact-document");
    const MIN_FRAME_HEIGHT = 360;
    const MAX_FRAME_HEIGHT = 20000;
    const setFrameHeight = (height) => {
      if (!Number.isFinite(height)) return;
      frame.style.height = Math.min(
        Math.max(Math.ceil(height), MIN_FRAME_HEIGHT),
        MAX_FRAME_HEIGHT
      ) + "px";
    };
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow) return;
      const data = event.data || {};
      if (
        data.source === "streamui-runtime" &&
        data.kind === "resize" &&
        typeof data.height === "number"
      ) {
        setFrameHeight(data.height);
      }
    });
    frame.srcdoc = JSON.parse(documentPayload.textContent || '""');
  </script>
</body>
</html>
`;
}

async function writeShareRecord(record: ArtifactShareRecord): Promise<void> {
  await mkdir(artifactSharesDir, { recursive: true, mode: 0o700 });
  await writeFile(getSharePath(record.id), JSON.stringify(record), {
    encoding: "utf8",
    mode: 0o600
  });
}

export async function publishArtifactShare(
  input: unknown,
  origin = getArtifactSharePublicOrigin()
): Promise<ArtifactSharePublishResult> {
  const { record, reused } = await createOrUpdateArtifactShareRecord(input);
  await writeShareRecord(record);
  const path = getArtifactSharePath(record.id);

  return {
    experimental: false,
    id: record.id,
    path,
    record,
    reused,
    url: `${normalizePublicOrigin(origin)}${path}`
  };
}

async function readShareRecord(id: string): Promise<ArtifactShareRecord> {
  try {
    return JSON.parse(await readFile(getSharePath(id), "utf8")) as ArtifactShareRecord;
  } catch (error) {
    if (error instanceof ArtifactShareError) {
      throw error;
    }
    throw new ArtifactShareError(404, "Artifact share not found.");
  }
}

function getErrorStatus(error: unknown): number {
  return error instanceof ArtifactShareError ? error.status : 500;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Artifact share failed.";
}

export async function handleCreateArtifactShare(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const result = await publishArtifactShare(req.body, getRequestOrigin(req));
    res.status(result.reused ? 200 : 201).json({
      experimental: result.experimental,
      id: result.id,
      path: result.path,
      reused: result.reused,
      url: result.url
    });
  } catch (error) {
    res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
  }
}

export async function handleGetArtifactSharePage(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const record = await readShareRecord(req.params.shareId);
    res.status(200);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.send(createArtifactSharePageHtml(record));
  } catch (error) {
    res.status(getErrorStatus(error)).send(escapeHtml(getErrorMessage(error)));
  }
}
