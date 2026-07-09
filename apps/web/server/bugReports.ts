import type { Request, Response } from "express";
import "./env.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

type PreparedBugReportImage = {
  metadata: StoredBugReportImage;
  buffer: Buffer;
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

function getReportDirectory(reportId: string): string {
  const dateSegment = new Date().toISOString().slice(0, 10);
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

    const reportId = createReportId();
    const reportDir = getReportDirectory(reportId);
    await mkdir(reportDir, { recursive: true, mode: 0o700 });

    for (const image of images) {
      await writeFile(path.join(reportDir, image.metadata.fileName), image.buffer, {
        mode: 0o600
      });
    }

    const submittedAt = new Date().toISOString();
    const report = {
      id: reportId,
      submittedAt,
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

    console.info(
      `[bug-report] stored id=${reportId} session=${report.sessionId ?? "unknown"} images=${images.length}`
    );
    res.json({ ok: true, id: reportId });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
