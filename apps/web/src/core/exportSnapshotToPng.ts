import html2canvas from "html2canvas";
import type { RenderSnapshot } from "./types";

const MAX_CANVAS_DIMENSION = 16_384;
const MAX_CANVAS_PIXELS = 32_000_000;

function waitForFrameLoad(frame: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      reject(new Error("Timed out while preparing the PNG export."));
    }, 8_000);

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

function getExportScale(width: number, height: number) {
  const deviceScale = Math.min(window.devicePixelRatio || 1, 2);
  const dimensionScale = Math.min(
    MAX_CANVAS_DIMENSION / width,
    MAX_CANVAS_DIMENSION / height
  );
  const pixelScale = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));

  return Math.min(deviceScale, dimensionScale, pixelScale, 1);
}

function downloadBlob(blob: Blob, filename: string) {
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

function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error("Could not encode the PNG export."));
    }, "image/png");
  });
}

export async function downloadSnapshotAsPng(
  snapshot: RenderSnapshot,
  options: {
    filename: string;
    width: number;
  }
): Promise<void> {
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-same-origin");
  frame.style.position = "fixed";
  frame.style.left = "-100000px";
  frame.style.top = "0";
  frame.style.width = `${Math.max(280, Math.round(options.width))}px`;
  frame.style.height = "1px";
  frame.style.border = "0";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";

  const loadPromise = waitForFrameLoad(frame);
  frame.srcdoc = snapshot.iframeDocument;
  document.body.appendChild(frame);

  try {
    await loadPromise;

    const frameDocument = frame.contentDocument;
    if (!frameDocument) {
      throw new Error("Could not access the prepared export document.");
    }

    frameDocument.documentElement.style.overflow = "visible";
    frameDocument.body.style.overflow = "visible";
    await frameDocument.fonts?.ready;
    await waitForImages(frameDocument);

    const { width, height } = measureDocument(frameDocument);
    frame.style.height = `${height}px`;

    const canvas = await html2canvas(frameDocument.body, {
      allowTaint: false,
      backgroundColor: null,
      height,
      logging: false,
      scale: getExportScale(width, height),
      scrollX: 0,
      scrollY: 0,
      useCORS: true,
      width,
      windowHeight: height,
      windowWidth: width
    });
    const blob = await toPngBlob(canvas);
    downloadBlob(blob, options.filename);
  } finally {
    frame.remove();
  }
}
