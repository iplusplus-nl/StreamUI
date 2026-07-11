const EXPORT_ASSET_SETTLE_TIMEOUT_MS = 4_000;
import { apiUrl } from "../api/appUrl";

const EXPORT_RESOURCE_ENDPOINT = apiUrl("/export-resource");
const CSS_URL_PATTERN =
  /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']+))\s*\)/gi;

type ExportResourceDataUrlCache = Map<string, Promise<string | undefined>>;
type CssResourceReplacement = {
  end: number;
  start: number;
  value: string;
};

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

function getFirstSrcsetUrl(srcset: string | null): string | undefined {
  return srcset
    ?.split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .find(Boolean);
}

function getImageResourceSource(image: HTMLImageElement): string | undefined {
  return (
    image.currentSrc ||
    image.src ||
    image.getAttribute("src") ||
    getFirstSrcsetUrl(image.getAttribute("srcset")) ||
    getFirstSrcsetUrl(
      image.closest("picture")?.querySelector("source[srcset]")?.getAttribute(
        "srcset"
      ) ?? null
    )
  );
}

export function resolveExportResourceUrl(
  value: string | undefined,
  baseUrl: string
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function getExportResourceProtocol(url: string): string | undefined {
  try {
    return new URL(url).protocol;
  } catch {
    return undefined;
  }
}

export function shouldInlineExportResource(url: string): boolean {
  const protocol = getExportResourceProtocol(url);
  return protocol === "http:" || protocol === "https:" || protocol === "blob:";
}

export function getExportResourceFetchUrl(url: string): string {
  const protocol = getExportResourceProtocol(url);
  if (protocol === "http:" || protocol === "https:") {
    return `${EXPORT_RESOURCE_ENDPOINT}?url=${encodeURIComponent(url)}`;
  }

  return url;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "load",
      () => {
        if (typeof reader.result === "string") {
          resolve(reader.result);
          return;
        }
        reject(new Error("Could not encode export resource."));
      },
      { once: true }
    );
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("Could not read export resource.")),
      { once: true }
    );
    reader.readAsDataURL(blob);
  });
}

async function fetchExportResourceAsDataUrl(
  url: string,
  cache: ExportResourceDataUrlCache
): Promise<string | undefined> {
  const cached = cache.get(url);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const response = await withTimeout(
      fetch(getExportResourceFetchUrl(url), { credentials: "same-origin" }),
      EXPORT_ASSET_SETTLE_TIMEOUT_MS,
      "Timed out while fetching export resource."
    );
    if (!response.ok) {
      return undefined;
    }

    const blob = await withTimeout(
      response.blob(),
      EXPORT_ASSET_SETTLE_TIMEOUT_MS,
      "Timed out while reading export resource."
    );

    return blobToDataUrl(blob);
  })().catch(() => undefined);

  cache.set(url, promise);
  return promise;
}

async function inlineImageResources(
  root: Element,
  baseUrl: string,
  cache: ExportResourceDataUrlCache
): Promise<void> {
  const images = Array.from(root.querySelectorAll("img"));

  await Promise.all(
    images.map(async (image) => {
      const source = getImageResourceSource(image);
      const url = resolveExportResourceUrl(source ?? undefined, baseUrl);
      if (!url || !shouldInlineExportResource(url)) {
        return;
      }

      const dataUrl = await fetchExportResourceAsDataUrl(url, cache);
      if (!dataUrl) {
        return;
      }

      image.setAttribute("src", dataUrl);
      image.removeAttribute("srcset");
      image.removeAttribute("sizes");
      image.removeAttribute("crossorigin");
      image.closest("picture")?.querySelectorAll("source").forEach((source) => {
        source.removeAttribute("srcset");
        source.removeAttribute("sizes");
      });
    })
  );
}

async function inlineSvgImageResources(
  root: Element,
  baseUrl: string,
  cache: ExportResourceDataUrlCache
): Promise<void> {
  const images = Array.from(root.querySelectorAll("image"));

  await Promise.all(
    images.map(async (image) => {
      const source =
        image.getAttribute("href") || image.getAttribute("xlink:href");
      const url = resolveExportResourceUrl(source ?? undefined, baseUrl);
      if (!url || !shouldInlineExportResource(url)) {
        return;
      }

      const dataUrl = await fetchExportResourceAsDataUrl(url, cache);
      if (!dataUrl) {
        return;
      }

      image.setAttribute("href", dataUrl);
      image.removeAttribute("xlink:href");
    })
  );
}

export async function inlineCssResourceUrls(
  cssText: string,
  baseUrl: string,
  cache: ExportResourceDataUrlCache
): Promise<string> {
  const matches = Array.from(cssText.matchAll(CSS_URL_PATTERN));
  if (!matches.length) {
    return cssText;
  }

  const replacements = (
    await Promise.all(
      matches.map(async (match): Promise<CssResourceReplacement | undefined> => {
        const rawUrl = match[1] ?? match[2] ?? match[3] ?? "";
        const url = resolveExportResourceUrl(rawUrl, baseUrl);
        if (
          match.index === undefined ||
          !url ||
          !shouldInlineExportResource(url)
        ) {
          return undefined;
        }

        const dataUrl = await fetchExportResourceAsDataUrl(url, cache);
        if (!dataUrl) {
          return undefined;
        }

        return {
          end: match.index + match[0].length,
          start: match.index,
          value: `url("${dataUrl}")`
        };
      })
    )
  )
    .filter(
      (replacement): replacement is CssResourceReplacement =>
        replacement !== undefined
    )
    .sort((a, b) => a.start - b.start);

  if (!replacements.length) {
    return cssText;
  }

  let output = "";
  let cursor = 0;
  for (const replacement of replacements) {
    output += cssText.slice(cursor, replacement.start);
    output += replacement.value;
    cursor = replacement.end;
  }
  output += cssText.slice(cursor);
  return output;
}

async function inlineStyleResources(
  root: Element,
  baseUrl: string,
  cache: ExportResourceDataUrlCache
): Promise<void> {
  const styleElements = Array.from(root.querySelectorAll("style"));
  await Promise.all(
    styleElements.map(async (style) => {
      const text = style.textContent;
      if (!text) {
        return;
      }
      style.textContent = await inlineCssResourceUrls(text, baseUrl, cache);
    })
  );

  const styledElements = [
    ...(root.hasAttribute("style") ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>("[style]"))
  ];
  await Promise.all(
    styledElements.map(async (element) => {
      const style = element.getAttribute("style");
      if (!style) {
        return;
      }
      element.setAttribute(
        "style",
        await inlineCssResourceUrls(style, baseUrl, cache)
      );
    })
  );
}

export async function inlineExternalSnapshotResources(
  root: Element,
  baseUrl: string
): Promise<void> {
  const cache: ExportResourceDataUrlCache = new Map();
  await inlineImageResources(root, baseUrl, cache);
  await inlineSvgImageResources(root, baseUrl, cache);
  await inlineStyleResources(root, baseUrl, cache);
}
