import { buildIframeDocument } from "../runtime/streamui/sandboxDocument";
import type { PageThemeMode, RenderSnapshot } from "../runtime/streamui/types";
import { htmlToTranscriptText } from "./artifactContext";

const MAX_CANVAS_DIMENSION = 16_384;
const MAX_CANVAS_PIXELS = 32_000_000;
const EXPORT_FRAME_MIN_WIDTH = 280;
const EXPORT_PREPARE_TIMEOUT_MS = 8_000;
const EXPORT_ASSET_SETTLE_TIMEOUT_MS = 4_000;
const EXPORT_RASTERIZE_TIMEOUT_MS = 8_000;
const SVG_MIME_TYPE = "image/svg+xml;charset=utf-8";
const HTML_MIME_TYPE = "text/html;charset=utf-8";
const PLAIN_TEXT_MIME_TYPE = "text/plain;charset=utf-8";

type SnapshotDocumentOptions = {
  themeMode?: PageThemeMode;
  width: number;
};

type PreparedSnapshotDocument = {
  document: Document;
  height: number;
  width: number;
};

type ArtifactExtension = "png" | "svg" | "html" | "txt";

type PngExportResult = {
  blob: Blob;
  height: number;
  scale: number;
  width: number;
};

export type ArtifactExportDiagnosticsOptions = {
  exportWidth?: number;
  themeMode?: PageThemeMode;
};

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, timeoutMs));
}

async function settleWithin<T>(
  promise: Promise<T> | undefined,
  timeoutMs: number
): Promise<void> {
  if (!promise) {
    return;
  }

  await Promise.race([
    promise.then(() => undefined).catch(() => undefined),
    delay(timeoutMs)
  ]);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeoutId = 0;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function waitForFrameLoad(frame: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Timed out while preparing the export."));
    }, EXPORT_PREPARE_TIMEOUT_MS);

    frame.addEventListener(
      "load",
      () => {
        window.clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

function waitForFramePaint(frame: HTMLIFrameElement): Promise<void> {
  const requestFrame =
    frame.contentWindow?.requestAnimationFrame.bind(frame.contentWindow) ??
    window.requestAnimationFrame.bind(window);

  return new Promise((resolve) => requestFrame(() => resolve()));
}

async function waitForImages(document: Document): Promise<void> {
  const images = Array.from(document.images);

  await Promise.all(
    images.map(async (image) => {
      if (image.complete && image.naturalWidth > 0) {
        return;
      }

      await new Promise<void>((resolve) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.addEventListener("error", () => resolve(), { once: true });
      });
    })
  );
}

function measureDocument(document: Document) {
  const body = document.body;
  const html = document.documentElement;
  const width = Math.ceil(
    Math.max(
      body?.scrollWidth || 0,
      body?.offsetWidth || 0,
      html?.scrollWidth || 0,
      html?.offsetWidth || 0
    )
  );
  const height = Math.ceil(
    Math.max(
      body?.scrollHeight || 0,
      body?.offsetHeight || 0,
      html?.scrollHeight || 0,
      html?.offsetHeight || 0
    )
  );

  return {
    width: Math.max(1, width),
    height: Math.max(1, height)
  };
}

export function getArtifactExportScale(width: number, height: number) {
  const deviceScale = Math.min(
    typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
    2
  );
  const dimensionScale = Math.min(
    MAX_CANVAS_DIMENSION / width,
    MAX_CANVAS_DIMENSION / height
  );
  const pixelScale = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));

  return Math.max(0.1, Math.min(deviceScale, dimensionScale, pixelScale));
}

export function getSnapshotSourceCode(snapshot: RenderSnapshot): string {
  const source =
    snapshot.raw || snapshot.completedHtml || snapshot.iframeDocument || "";

  return source.endsWith("\n") ? source : `${source}\n`;
}

export function getSnapshotVisibleText(snapshot: RenderSnapshot): string {
  return htmlToTranscriptText(
    snapshot.completedHtml || snapshot.iframeDocument || snapshot.raw
  );
}

export function getSnapshotHtmlDocument(
  snapshot: RenderSnapshot,
  themeMode?: PageThemeMode
): string {
  const html = snapshot.completedHtml || snapshot.raw;
  const document = html
    ? buildIframeDocument(html, themeMode ?? "night")
    : snapshot.iframeDocument;

  return document.endsWith("\n") ? document : `${document}\n`;
}

export function createArtifactFilename(
  baseName: string,
  extension: ArtifactExtension
): string {
  const sanitized = baseName
    .trim()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return `${sanitized || "streamui-artifact"}.${extension}`;
}

export function normalizeSvgMarkup(markup: string): string {
  const trimmed = markup.trim();

  if (trimmed.startsWith("<?xml")) {
    return `${trimmed}\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n${trimmed}\n`;
}

export function getSnapshotDiagnostics(
  snapshot: RenderSnapshot,
  options: ArtifactExportDiagnosticsOptions = {}
): string {
  const visibleText = getSnapshotVisibleText(snapshot);
  const lines = [
    "StreamUI Artifact Diagnostics",
    `Generated: ${new Date().toISOString()}`,
    `Status: ${snapshot.status}`,
    `Theme mode: ${options.themeMode ?? "unknown"}`,
    `Requested export width: ${options.exportWidth ?? "unknown"}`,
    "",
    "Source sizes:",
    `- Raw source chars: ${snapshot.raw.length}`,
    `- Completed HTML chars: ${snapshot.completedHtml.length}`,
    `- Iframe document chars: ${snapshot.iframeDocument.length}`,
    `- Visible text chars: ${visibleText.length}`,
    "",
    "Render errors:",
    snapshot.errors.length
      ? snapshot.errors
          .map((error, index) => {
            return `${index + 1}. ${error.kind}: ${error.message} (${new Date(
              error.timestamp
            ).toISOString()})`;
          })
          .join("\n")
      : "- none",
    "",
    "Visible text:",
    visibleText || "(none)",
    "",
    "Raw source:",
    getSnapshotSourceCode(snapshot),
    "",
    "Completed HTML:",
    snapshot.completedHtml || "(none)"
  ];

  return `${lines.join("\n")}\n`;
}

function createHiddenExportFrame(
  snapshot: RenderSnapshot,
  options: SnapshotDocumentOptions
): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts");
  frame.sandbox.add("allow-same-origin");
  frame.style.position = "fixed";
  frame.style.left = "-100000px";
  frame.style.top = "0";
  frame.style.width = `${Math.max(
    EXPORT_FRAME_MIN_WIDTH,
    Math.round(options.width)
  )}px`;
  frame.style.height = "1px";
  frame.style.border = "0";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";
  frame.srcdoc = options.themeMode
    ? buildIframeDocument(snapshot.completedHtml, options.themeMode)
    : snapshot.iframeDocument;

  return frame;
}

async function withPreparedSnapshotDocument<T>(
  snapshot: RenderSnapshot,
  options: SnapshotDocumentOptions,
  callback: (prepared: PreparedSnapshotDocument) => Promise<T>
): Promise<T> {
  const frame = createHiddenExportFrame(snapshot, options);
  const loadPromise = waitForFrameLoad(frame);
  document.body.appendChild(frame);

  try {
    await loadPromise;

    const frameDocument = frame.contentDocument;
    if (!frameDocument) {
      throw new Error("Could not access the prepared export document.");
    }

    frameDocument.documentElement.style.overflow = "visible";
    frameDocument.body.style.overflow = "visible";
    await settleWithin(
      frameDocument.fonts?.ready,
      EXPORT_ASSET_SETTLE_TIMEOUT_MS
    );
    await settleWithin(
      waitForImages(frameDocument),
      EXPORT_ASSET_SETTLE_TIMEOUT_MS
    );

    const measured = measureDocument(frameDocument);
    frame.style.height = `${measured.height}px`;
    await waitForFramePaint(frame);

    return await callback({
      document: frameDocument,
      height: measured.height,
      width: measured.width
    });
  } finally {
    frame.remove();
  }
}

function createCaptureArea(
  document: Document,
  width: number,
  height: number
): DOMRectReadOnly {
  const FrameDomRect = document.defaultView?.DOMRect;
  if (FrameDomRect) {
    return new FrameDomRect(0, 0, width, height);
  }

  return {
    x: 0,
    y: 0,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    width,
    height,
    toJSON() {
      return {
        x: 0,
        y: 0,
        top: 0,
        right: width,
        bottom: height,
        left: 0,
        width,
        height
      };
    }
  };
}

function serializeSvgDocument(svgDocument: XMLDocument): string {
  const markup = new XMLSerializer().serializeToString(
    svgDocument.documentElement
  );

  return normalizeSvgMarkup(markup);
}

function collectDocumentStyles(document: Document): string {
  return Array.from(document.styleSheets)
    .map((styleSheet) => {
      try {
        return Array.from(styleSheet.cssRules)
          .map((rule) => rule.cssText)
          .join("\n");
      } catch {
        const ownerNode = styleSheet.ownerNode;
        return ownerNode && "textContent" in ownerNode
          ? ownerNode.textContent ?? ""
          : "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

function renderPreparedDocumentToForeignObjectSvg(
  prepared: PreparedSnapshotDocument
): string {
  const clonedBody = prepared.document.body.cloneNode(true) as HTMLElement;
  const style = prepared.document.createElement("style");
  style.textContent = collectDocumentStyles(prepared.document);
  clonedBody.querySelectorAll("script").forEach((script) => script.remove());
  clonedBody.prepend(style);
  clonedBody.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  clonedBody.style.margin = "0";
  clonedBody.style.width = `${prepared.width}px`;
  clonedBody.style.minHeight = `${prepared.height}px`;

  const bodyMarkup = new XMLSerializer().serializeToString(clonedBody);

  return normalizeSvgMarkup(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${prepared.width}" height="${prepared.height}" viewBox="0 0 ${prepared.width} ${prepared.height}"><foreignObject x="0" y="0" width="${prepared.width}" height="${prepared.height}">${bodyMarkup}</foreignObject></svg>`
  );
}

async function renderPreparedDocumentToSvgString(
  prepared: PreparedSnapshotDocument
): Promise<string> {
  const { elementToSVG, inlineResources } = await import("dom-to-svg");
  const svgDocument = elementToSVG(prepared.document.body, {
    captureArea: createCaptureArea(
      prepared.document,
      prepared.width,
      prepared.height
    )
  });
  await withTimeout(
    inlineResources(svgDocument.documentElement),
    EXPORT_RASTERIZE_TIMEOUT_MS,
    "Timed out while inlining SVG resources."
  );

  return serializeSvgDocument(svgDocument);
}

async function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  const image = new Image();

  return withTimeout(
    new Promise<HTMLImageElement>((resolve, reject) => {
      image.addEventListener("load", () => resolve(image), { once: true });
      image.addEventListener(
        "error",
        () => reject(new Error("Could not load the SVG export for PNG.")),
        { once: true }
      );
      image.decoding = "async";
      image.src = url;
    }),
    EXPORT_RASTERIZE_TIMEOUT_MS,
    "Timed out while loading the SVG export for PNG."
  );
}

async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return withTimeout(
    new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
          return;
        }

        reject(new Error("Could not encode the PNG export."));
      }, "image/png");
    }),
    EXPORT_RASTERIZE_TIMEOUT_MS,
    "Timed out while encoding the PNG export."
  );
}

async function rasterizeSvgToPngBlob(
  svg: string,
  width: number,
  height: number,
  scale: number
): Promise<Blob> {
  const image = await loadImageFromUrl(
    `data:${SVG_MIME_TYPE},${encodeURIComponent(svg)}`
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create a canvas for PNG export.");
  }

  context.setTransform(scale, 0, 0, scale, 0, 0);
  context.drawImage(image, 0, 0, width, height);

  return await canvasToPngBlob(canvas);
}

export async function renderSnapshotToPngBlob(
  snapshot: RenderSnapshot,
  options: SnapshotDocumentOptions
): Promise<Blob> {
  const result = await renderSnapshotToPngExport(snapshot, options);
  return result.blob;
}

async function renderSnapshotToPngExport(
  snapshot: RenderSnapshot,
  options: SnapshotDocumentOptions
): Promise<PngExportResult> {
  return withPreparedSnapshotDocument(snapshot, options, async (prepared) => {
    const svg = renderPreparedDocumentToForeignObjectSvg(prepared);
    const scale = getArtifactExportScale(prepared.width, prepared.height);
    const blob = await rasterizeSvgToPngBlob(
      svg,
      prepared.width,
      prepared.height,
      scale
    );

    return {
      blob,
      height: prepared.height,
      scale,
      width: prepared.width
    };
  });
}

export async function renderSnapshotToSvgString(
  snapshot: RenderSnapshot,
  options: SnapshotDocumentOptions
): Promise<string> {
  return withPreparedSnapshotDocument(snapshot, options, async (prepared) => {
    return renderPreparedDocumentToSvgString(prepared);
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function downloadTextFile(
  content: string,
  filename: string,
  type = PLAIN_TEXT_MIME_TYPE
): void {
  downloadBlob(new Blob([content], { type }), filename);
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Some embedded browser surfaces expose the Clipboard API but still deny
      // write permission. Fall through to the user-activation based fallback.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-10000px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw new Error("Clipboard copy was rejected.");
    }
  } finally {
    textarea.remove();
  }
}

export async function copySnapshotSourceCode(
  snapshot: RenderSnapshot
): Promise<void> {
  await copyTextToClipboard(getSnapshotSourceCode(snapshot));
}

export async function copySnapshotVisibleText(
  snapshot: RenderSnapshot
): Promise<void> {
  const text = getSnapshotVisibleText(snapshot);
  if (!text) {
    throw new Error("No visible text found in this artifact.");
  }

  await copyTextToClipboard(text);
}

export function downloadSnapshotAsHtml(
  snapshot: RenderSnapshot,
  options: { filename: string; themeMode?: PageThemeMode }
): void {
  downloadTextFile(
    getSnapshotHtmlDocument(snapshot, options.themeMode),
    options.filename,
    HTML_MIME_TYPE
  );
}

export function downloadSnapshotDiagnostics(
  snapshot: RenderSnapshot,
  options: ArtifactExportDiagnosticsOptions & { filename: string }
): void {
  downloadTextFile(
    getSnapshotDiagnostics(snapshot, options),
    options.filename,
    PLAIN_TEXT_MIME_TYPE
  );
}

export async function downloadSnapshotAsPng(
  snapshot: RenderSnapshot,
  options: SnapshotDocumentOptions & { filename: string }
): Promise<Omit<PngExportResult, "blob">> {
  const result = await renderSnapshotToPngExport(snapshot, options);
  downloadBlob(result.blob, options.filename);

  return {
    height: result.height,
    scale: result.scale,
    width: result.width
  };
}

export async function downloadSnapshotAsSvg(
  snapshot: RenderSnapshot,
  options: SnapshotDocumentOptions & { filename: string }
): Promise<void> {
  const svg = await renderSnapshotToSvgString(snapshot, options);
  downloadTextFile(svg, options.filename, SVG_MIME_TYPE);
}
