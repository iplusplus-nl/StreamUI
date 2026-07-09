import type { Request, Response } from "express";
import "./env.js";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGitHubIssueForBugReport,
  getGitHubIssueConfig,
  type BugReportIssueImage,
  type BugReportIssueInput,
  type CreatedGitHubIssue
} from "./githubIssues.js";

const MAX_BUG_REPORT_IMAGES = 8;
const MAX_BUG_REPORT_TEXT_LENGTH = 12_000;
const MAX_BUG_REPORT_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_BUG_REPORT_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(projectRoot, "../..");
const sessionsDir = path.resolve(
  process.env.STREAMUI_SESSION_DIR || path.join(workspaceRoot, "sessions")
);
const bugReportsDir = path.resolve(
  process.env.CHATHTML_BUG_REPORT_DIR || path.join(sessionsDir, "bug-reports")
);

type BugReportImageInput = {
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  size?: unknown;
  dataUrl?: unknown;
  width?: unknown;
  height?: unknown;
  captured?: unknown;
  createdAt?: unknown;
};

type StoredBugReportImage = {
  id: string;
  issueLabel: string;
  name: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  captured?: boolean;
  createdAt?: number;
  fileName: string;
  sha256: string;
};

type StoredBugReport = {
  id: string;
  submittedAt: string;
  imageAccessToken: string;
  sessionId?: string;
  sessionTitle?: string;
  clientId?: string;
  pageUrl?: string;
  userAgent?: string;
  viewport?: unknown;
  remoteAddress?: string;
  text: string;
  images: StoredBugReportImage[];
};

type PreparedBugReportImage = {
  metadata: StoredBugReportImage;
  buffer: Buffer;
};

type GitHubIssueSyncRecord =
  | {
      ok: true;
      skipped?: false;
      syncedAt: string;
      repository: string;
      number: number;
      url: string;
      apiUrl: string;
    }
  | {
      ok: false;
      skipped: true;
      syncedAt: string;
      reason: string;
    }
  | {
      ok: false;
      skipped?: false;
      syncedAt: string;
      error: string;
    };

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safePathSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
  return normalized || "item";
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") {
    return ".jpg";
  }
  if (mimeType === "image/webp") {
    return ".webp";
  }
  if (mimeType === "image/gif") {
    return ".gif";
  }
  return ".png";
}

function parseImageDataUrl(dataUrl: string): {
  mimeType: string;
  buffer: Buffer;
} {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new Error("Invalid image data URL.");
  }

  const mimeType = match[1].toLowerCase();
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(`${mimeType} is not a supported image type.`);
  }

  return {
    mimeType,
    buffer: Buffer.from(match[2].replace(/\s+/g, ""), "base64")
  };
}

function createReportId(): string {
  return `bug-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function createImageAccessToken(): string {
  return randomBytes(32).toString("base64url");
}

function createIssueImageLabel(): string {
  return Array.from(randomBytes(10), (byte) =>
    String.fromCharCode(97 + (byte % 26))
  ).join("");
}

function getTodayDateSegment(): string {
  return new Date().toISOString().slice(0, 10);
}

function assertDateSegment(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Invalid bug report date.");
  }
  return value;
}

function getReportDirectory(dateSegment: string, reportId: string): string {
  assertDateSegment(dateSegment);
  const resolved = path.resolve(
    bugReportsDir,
    dateSegment,
    safePathSegment(reportId)
  );
  if (!resolved.startsWith(`${bugReportsDir}${path.sep}`)) {
    throw new Error("Invalid bug report path.");
  }
  return resolved;
}

function safeTokenEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function singleQueryValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return "";
}

function envString(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function normalizeBaseUrl(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function getBugReportIssueBaseUrl(): string | undefined {
  const configured = normalizeBaseUrl(
    envString(
      "CHATHTML_BUG_REPORT_ISSUE_BASE_URL",
      "CHATHTML_BUG_REPORT_LOCAL_BASE_URL"
    )
  );
  if (configured) {
    return configured;
  }

  const port = envString("PORT") || "8787";
  return `http://127.0.0.1:${port}`;
}

function buildBugReportImageUrl(
  dateSegment: string,
  report: StoredBugReport,
  image: StoredBugReportImage
): string | undefined {
  const baseUrl = getBugReportIssueBaseUrl();
  if (!baseUrl) {
    return undefined;
  }

  const url = new URL(
    `/api/bug-reports/${encodeURIComponent(dateSegment)}/${encodeURIComponent(
      report.id
    )}/images/${encodeURIComponent(image.fileName)}`,
    baseUrl
  );
  url.searchParams.set("token", report.imageAccessToken);
  return url.toString();
}

function createBugReportIssueInput(
  dateSegment: string,
  report: StoredBugReport
): BugReportIssueInput {
  const images: BugReportIssueImage[] = [];
  for (const image of report.images) {
    const url = buildBugReportImageUrl(dateSegment, report, image);
    if (!url) {
      continue;
    }
    images.push({
      label: image.issueLabel,
      url
    });
  }

  return {
    id: report.id,
    submittedAt: report.submittedAt,
    sessionId: report.sessionId,
    sessionTitle: report.sessionTitle,
    clientId: report.clientId,
    pageUrl: report.pageUrl,
    userAgent: report.userAgent,
    viewport: report.viewport,
    remoteAddress: report.remoteAddress,
    text: report.text,
    images
  };
}

function sanitizeGitHubError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000);
}

async function writeGitHubIssueSyncRecord(
  reportDir: string,
  record: GitHubIssueSyncRecord
): Promise<void> {
  await writeFile(
    path.join(reportDir, "github.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 }
  );
}

async function syncBugReportToGitHubIssue(
  reportDir: string,
  dateSegment: string,
  report: StoredBugReport
): Promise<GitHubIssueSyncRecord> {
  const config = getGitHubIssueConfig();
  if (!config) {
    const record: GitHubIssueSyncRecord = {
      ok: false,
      skipped: true,
      syncedAt: new Date().toISOString(),
      reason:
        "GitHub issue sync is not configured. Set GITHUB_REPOSITORY and GITHUB_ISSUES_TOKEN."
    };
    await writeGitHubIssueSyncRecord(reportDir, record);
    return record;
  }

  try {
    const issue: CreatedGitHubIssue = await createGitHubIssueForBugReport(
      config,
      createBugReportIssueInput(dateSegment, report)
    );
    const record: GitHubIssueSyncRecord = {
      ok: true,
      syncedAt: new Date().toISOString(),
      repository: config.repository,
      number: issue.number,
      url: issue.url,
      apiUrl: issue.apiUrl
    };
    await writeGitHubIssueSyncRecord(reportDir, record);
    return record;
  } catch (error) {
    const record: GitHubIssueSyncRecord = {
      ok: false,
      syncedAt: new Date().toISOString(),
      error: sanitizeGitHubError(error)
    };
    await writeGitHubIssueSyncRecord(reportDir, record);
    console.warn(`[bug-report] GitHub issue sync failed: ${record.error}`);
    return record;
  }
}

function prepareBugReportImage(
  input: BugReportImageInput,
  index: number
): PreparedBugReportImage {
  const parsed = parseImageDataUrl(stringValue(input.dataUrl));
  if (parsed.buffer.byteLength > MAX_BUG_REPORT_IMAGE_BYTES) {
    throw new Error("A bug report image is too large.");
  }

  const name = stringValue(input.name, `bug-report-${index + 1}`).trim();
  const extension = extensionForMimeType(parsed.mimeType);
  const baseName = safePathSegment(path.basename(name, path.extname(name)));
  const fileName = `${String(index + 1).padStart(2, "0")}-${baseName}${extension}`;
  const width = finiteNumber(input.width);
  const height = finiteNumber(input.height);
  const createdAt = finiteNumber(input.createdAt);

  return {
    buffer: parsed.buffer,
    metadata: {
      id:
        stringValue(input.id).trim().slice(0, 160) ||
        `image-${index + 1}`,
      issueLabel: createIssueImageLabel(),
      name: name.slice(0, 180) || `bug-report-${index + 1}${extension}`,
      mimeType: parsed.mimeType,
      size: parsed.buffer.byteLength,
      width: width ? Math.max(1, Math.round(width)) : undefined,
      height: height ? Math.max(1, Math.round(height)) : undefined,
      captured: input.captured ? true : undefined,
      createdAt,
      fileName,
      sha256: createHash("sha256").update(parsed.buffer).digest("hex")
    }
  };
}

function prepareBugReportImages(input: unknown): PreparedBugReportImage[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const images = input
    .slice(0, MAX_BUG_REPORT_IMAGES)
    .map((item, index) => prepareBugReportImage(item as BugReportImageInput, index));
  const totalBytes = images.reduce(
    (sum, image) => sum + image.buffer.byteLength,
    0
  );
  if (totalBytes > MAX_BUG_REPORT_TOTAL_IMAGE_BYTES) {
    throw new Error("Bug report images are too large.");
  }

  return images;
}

export async function handleCreateBugReport(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const body =
      req.body && typeof req.body === "object"
        ? (req.body as Record<string, unknown>)
        : {};
    const text = stringValue(body.text).slice(0, MAX_BUG_REPORT_TEXT_LENGTH);
    const images = prepareBugReportImages(body.images);
    if (!text.trim() && images.length === 0) {
      res.status(400).json({ error: "Bug report text or images are required." });
      return;
    }

    const dateSegment = getTodayDateSegment();
    const reportId = createReportId();
    const reportDir = getReportDirectory(dateSegment, reportId);
    await mkdir(reportDir, { recursive: true, mode: 0o700 });

    for (const image of images) {
      await writeFile(path.join(reportDir, image.metadata.fileName), image.buffer, {
        mode: 0o600
      });
    }

    const submittedAt = new Date().toISOString();
    const report: StoredBugReport = {
      id: reportId,
      submittedAt,
      imageAccessToken: createImageAccessToken(),
      sessionId: stringValue(body.sessionId).trim().slice(0, 180) || undefined,
      sessionTitle:
        stringValue(body.sessionTitle).trim().slice(0, 240) || undefined,
      clientId: stringValue(body.clientId).trim().slice(0, 180) || undefined,
      pageUrl: stringValue(body.pageUrl).trim().slice(0, 2_000) || undefined,
      userAgent: stringValue(body.userAgent).trim().slice(0, 1_000) || undefined,
      viewport:
        body.viewport && typeof body.viewport === "object"
          ? body.viewport
          : undefined,
      remoteAddress: req.ip,
      text,
      images: images.map((image) => image.metadata)
    };

    await writeFile(
      path.join(reportDir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 }
    );

    const github = await syncBugReportToGitHubIssue(
      reportDir,
      dateSegment,
      report
    );

    console.info(
      `[bug-report] stored id=${reportId} session=${report.sessionId ?? "unknown"} images=${images.length} github=${github.ok ? `#${github.number}` : github.skipped ? "skipped" : "failed"}`
    );
    res.json({
      ok: true,
      id: reportId,
      github:
        github.ok
          ? {
              ok: true,
              issueNumber: github.number,
              issueUrl: github.url
            }
          : {
              ok: false,
              skipped: Boolean(github.skipped)
            }
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function isStoredBugReportImage(value: unknown): value is StoredBugReportImage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const image = value as Partial<StoredBugReportImage>;
  return (
    (typeof image.issueLabel === "string" ||
      typeof image.issueLabel === "undefined") &&
    typeof image.name === "string" &&
    typeof image.mimeType === "string" &&
    typeof image.fileName === "string" &&
    typeof image.size === "number"
  );
}

function parseStoredBugReport(value: unknown): StoredBugReport | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const report = value as Partial<StoredBugReport>;
  const images = Array.isArray(report.images)
    ? report.images.filter(isStoredBugReportImage).map((image) => ({
        ...image,
        issueLabel: image.issueLabel || createIssueImageLabel()
      }))
    : [];
  if (
    typeof report.id !== "string" ||
    typeof report.submittedAt !== "string" ||
    typeof report.imageAccessToken !== "string" ||
    typeof report.text !== "string"
  ) {
    return undefined;
  }
  return {
    id: report.id,
    submittedAt: report.submittedAt,
    imageAccessToken: report.imageAccessToken,
    sessionId: typeof report.sessionId === "string" ? report.sessionId : undefined,
    sessionTitle:
      typeof report.sessionTitle === "string" ? report.sessionTitle : undefined,
    clientId: typeof report.clientId === "string" ? report.clientId : undefined,
    pageUrl: typeof report.pageUrl === "string" ? report.pageUrl : undefined,
    userAgent: typeof report.userAgent === "string" ? report.userAgent : undefined,
    viewport: report.viewport,
    remoteAddress:
      typeof report.remoteAddress === "string" ? report.remoteAddress : undefined,
    text: report.text,
    images
  };
}

async function readStoredBugReport(
  dateSegment: string,
  reportId: string
): Promise<{
  reportDir: string;
  report: StoredBugReport;
}> {
  const reportDir = getReportDirectory(dateSegment, reportId);
  const raw = await readFile(path.join(reportDir, "report.json"), "utf8");
  const parsed = parseStoredBugReport(JSON.parse(raw));
  if (!parsed || parsed.id !== reportId) {
    throw new Error("Bug report was not found.");
  }
  return { reportDir, report: parsed };
}

function isLocalBugReportImageRequest(req: Request): boolean {
  const allowPublic = envString("CHATHTML_BUG_REPORT_IMAGE_ALLOW_PUBLIC")
    .toLowerCase()
    .trim();
  if (allowPublic === "true" || allowPublic === "1") {
    return true;
  }

  const host = (req.get("host") ?? "").toLowerCase().trim();
  if (!host) {
    return false;
  }

  const normalizedHost = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.split(":", 1)[0];
  return (
    normalizedHost === "localhost" ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "::1"
  );
}

export async function handleBugReportImageRequest(
  req: Request,
  res: Response
): Promise<void> {
  try {
    if (!isLocalBugReportImageRequest(req)) {
      res.status(404).json({ error: "Bug report image was not found." });
      return;
    }

    const dateSegment = stringValue(req.params.date);
    const reportId = stringValue(req.params.reportId);
    const fileName = stringValue(req.params.fileName);
    const token = singleQueryValue(req.query.token);
    if (!dateSegment || !reportId || !fileName || !token) {
      res.status(404).json({ error: "Bug report image was not found." });
      return;
    }

    const { reportDir, report } = await readStoredBugReport(
      dateSegment,
      reportId
    );
    if (!safeTokenEquals(token, report.imageAccessToken)) {
      res.status(404).json({ error: "Bug report image was not found." });
      return;
    }

    const image = report.images.find(
      (candidate) => candidate.fileName === fileName
    );
    if (!image) {
      res.status(404).json({ error: "Bug report image was not found." });
      return;
    }

    const imagePath = path.resolve(reportDir, image.fileName);
    if (!imagePath.startsWith(`${reportDir}${path.sep}`)) {
      res.status(404).json({ error: "Bug report image was not found." });
      return;
    }

    const buffer = await readFile(imagePath);
    res.status(200);
    res.setHeader("Cache-Control", "private, max-age=604800");
    res.setHeader("Content-Type", image.mimeType);
    res.setHeader("Content-Length", String(buffer.byteLength));
    res.setHeader("Content-Disposition", `inline; filename="${image.fileName}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(buffer);
  } catch {
    res.status(404).json({ error: "Bug report image was not found." });
  }
}
