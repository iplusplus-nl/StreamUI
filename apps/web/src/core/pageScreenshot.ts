const MAX_CANVAS_DIMENSION = 16_384;
const MAX_CANVAS_PIXELS = 32_000_000;
const SCREENSHOT_TIMEOUT_MS = 8_000;
const SVG_MIME_TYPE = "image/svg+xml;charset=utf-8";

type IframeOverlay = {
  cleanup(): void;
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
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function createCaptureArea(
  document: Document,
  x: number,
  y: number,
  width: number,
  height: number
): DOMRectReadOnly {
  const FrameDomRect = document.defaultView?.DOMRect ?? DOMRect;
  return new FrameDomRect(x, y, width, height);
}

function getScreenshotScale(width: number, height: number): number {
  const deviceScale = Math.min(window.devicePixelRatio || 1, 2);
  const dimensionScale = Math.min(
    MAX_CANVAS_DIMENSION / width,
    MAX_CANVAS_DIMENSION / height
  );
  const pixelScale = Math.sqrt(MAX_CANVAS_PIXELS / (width * height));
  return Math.min(deviceScale, dimensionScale, pixelScale, 2);
}

function serializeSvgDocument(svgDocument: XMLDocument): string {
  return new XMLSerializer().serializeToString(svgDocument.documentElement);
}

async function inlineSvgResourcesBestEffort(svgDocument: XMLDocument): Promise<void> {
  const { inlineResources } = await import("dom-to-svg");
  await withTimeout(
    inlineResources(svgDocument.documentElement),
    SCREENSHOT_TIMEOUT_MS,
    "Timed out while inlining screenshot resources."
  ).catch((error) => {
    console.warn("Could not inline every screenshot resource.", error);
  });
}

async function renderElementToSvgString(
  element: Element,
  captureArea: DOMRectReadOnly
): Promise<string> {
  const { elementToSVG } = await import("dom-to-svg");
  const svgDocument = elementToSVG(element, {
    captureArea,
    keepLinks: false
  });
  await inlineSvgResourcesBestEffort(svgDocument);
  return serializeSvgDocument(svgDocument);
}

function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  return withTimeout(
    new Promise<HTMLImageElement>((resolve, reject) => {
      image.addEventListener("load", () => resolve(image), { once: true });
      image.addEventListener(
        "error",
        () => reject(new Error("Could not load the screenshot SVG.")),
        { once: true }
      );
      image.decoding = "async";
      image.src = url;
    }),
    SCREENSHOT_TIMEOUT_MS,
    "Timed out while loading the screenshot SVG."
  );
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return withTimeout(
    new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
          return;
        }

        reject(new Error("Could not encode the screenshot PNG."));
      }, "image/png");
    }),
    SCREENSHOT_TIMEOUT_MS,
    "Timed out while encoding the screenshot PNG."
  );
}

async function rasterizeSvgToPngBlob(
  svg: string,
  width: number,
  height: number,
  scale: number
): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: SVG_MIME_TYPE }));
  try {
    const image = await loadImageFromUrl(url);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(width * scale));
    canvas.height = Math.max(1, Math.ceil(height * scale));

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create a canvas for the screenshot.");
    }

    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.drawImage(image, 0, 0, width, height);
    return await canvasToPngBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function renderDocumentAreaToDataUrl(
  document: Document,
  x: number,
  y: number,
  width: number,
  height: number
): Promise<string> {
  const captureArea = createCaptureArea(document, x, y, width, height);
  const svg = await renderElementToSvgString(document.documentElement, captureArea);
  const scale = getScreenshotScale(width, height);
  const blob = await rasterizeSvgToPngBlob(svg, width, height, scale);

  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Could not encode the iframe screenshot."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Could not read the iframe screenshot."));
    });
    reader.readAsDataURL(blob);
  });
}

function rectIntersectsViewport(rect: DOMRect): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight
  );
}

async function createIframeOverlay(iframe: HTMLIFrameElement): Promise<IframeOverlay | null> {
  const frameDocument = iframe.contentDocument;
  const frameWindow = iframe.contentWindow;
  if (!frameDocument || !frameWindow) {
    return null;
  }

  const rect = iframe.getBoundingClientRect();
  if (!rectIntersectsViewport(rect)) {
    return null;
  }

  const visibleLeft = Math.max(0, rect.left);
  const visibleTop = Math.max(0, rect.top);
  const visibleRight = Math.min(window.innerWidth, rect.right);
  const visibleBottom = Math.min(window.innerHeight, rect.bottom);
  const visibleWidth = Math.max(1, Math.round(visibleRight - visibleLeft));
  const visibleHeight = Math.max(1, Math.round(visibleBottom - visibleTop));
  const frameX = Math.max(0, visibleLeft - rect.left) + frameWindow.scrollX;
  const frameY = Math.max(0, visibleTop - rect.top) + frameWindow.scrollY;
  const dataUrl = await renderDocumentAreaToDataUrl(
    frameDocument,
    frameX,
    frameY,
    visibleWidth,
    visibleHeight
  );

  const overlay = document.createElement("img");
  overlay.src = dataUrl;
  overlay.alt = "";
  overlay.setAttribute("aria-hidden", "true");
  overlay.style.position = "fixed";
  overlay.style.left = `${visibleLeft}px`;
  overlay.style.top = `${visibleTop}px`;
  overlay.style.width = `${visibleWidth}px`;
  overlay.style.height = `${visibleHeight}px`;
  overlay.style.objectFit = "fill";
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "2147483000";
  overlay.style.margin = "0";
  overlay.style.border = "0";
  overlay.style.maxWidth = "none";
  overlay.style.maxHeight = "none";

  const previousVisibility = iframe.style.visibility;
  iframe.style.visibility = "hidden";
  document.body.appendChild(overlay);

  return {
    cleanup() {
      iframe.style.visibility = previousVisibility;
      overlay.remove();
    }
  };
}

async function createVisibleIframeOverlays(): Promise<IframeOverlay[]> {
  const overlays: IframeOverlay[] = [];
  const iframes = Array.from(document.querySelectorAll("iframe"));
  for (const iframe of iframes) {
    try {
      const overlay = await createIframeOverlay(iframe);
      if (overlay) {
        overlays.push(overlay);
      }
    } catch (error) {
      console.warn("Could not include an iframe in the screenshot.", error);
    }
  }
  return overlays;
}

export async function captureCurrentPageScreenshotBlob(): Promise<Blob> {
  await settleWithin(document.fonts?.ready, 2_000);
  const overlays = await createVisibleIframeOverlays();
  try {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const width = Math.max(1, Math.round(window.innerWidth));
    const height = Math.max(1, Math.round(window.innerHeight));
    const captureArea = createCaptureArea(document, 0, 0, width, height);
    const svg = await renderElementToSvgString(
      document.documentElement,
      captureArea
    );
    const scale = getScreenshotScale(width, height);
    return await rasterizeSvgToPngBlob(svg, width, height, scale);
  } finally {
    overlays.forEach((overlay) => overlay.cleanup());
  }
}
