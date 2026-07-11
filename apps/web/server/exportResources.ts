import type { Request, Response } from "express";
import {
  fetchWithValidatedRedirects,
  type RetrievalHttpDependencies
} from "./retrievalHttpClient.js";
import { RetrievalUrlPolicyError } from "./retrievalUrlPolicy.js";

export const EXPORT_RESOURCE_MAX_BYTES = 10 * 1024 * 1024;
const EXPORT_RESOURCE_TIMEOUT_MS = 10_000;
const EXPORT_RESOURCE_USER_AGENT =
  "ChatHTML-Export/0.1 (+https://localhost; local artifact export service)";
const EXPORT_RESOURCE_URL_POLICY = { allowPrivateUrls: false } as const;
const EXPORTABLE_IMAGE_CONTENT_TYPES = new Set([
  "image/apng",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

export class ExportResourceError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

type ExportResource = {
  body: Buffer;
  contentType: string;
  finalUrl: string;
};

const MEDIA_IMAGE_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const MEDIA_IMAGE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type CachedMediaImage = ExportResource & {
  expiresAt: number;
};

export type ExportResourceFetchDependencies = Pick<
  RetrievalHttpDependencies,
  "fetchImpl" | "lookup" | "maxRedirects" | "pinnedFetchImpl"
>;

function getSingleQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0];
  }
  return undefined;
}

export function normalizeExportResourceUrl(value: unknown): string | undefined {
  const raw = getSingleQueryValue(value)?.trim();
  if (!raw) {
    return undefined;
  }

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function isExportableImageContentType(value: string | null): boolean {
  return normalizeExportableImageContentType(value) !== undefined;
}

function normalizeExportableImageContentType(
  value: string | null
): string | undefined {
  const contentType = value?.split(";")[0]?.trim().toLowerCase();
  return contentType && EXPORTABLE_IMAGE_CONTENT_TYPES.has(contentType)
    ? contentType
    : undefined;
}

function getContentLength(response: globalThis.Response): number | undefined {
  const value = response.headers.get("content-length");
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readLimitedBody(response: globalThis.Response): Promise<Buffer> {
  const contentLength = getContentLength(response);
  if (
    contentLength !== undefined &&
    contentLength > EXPORT_RESOURCE_MAX_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new ExportResourceError(413, "Export resource is too large.");
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return Buffer.concat(chunks, received);
    }

    if (received + value.byteLength > EXPORT_RESOURCE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ExportResourceError(413, "Export resource is too large.");
    }

    chunks.push(value);
    received += value.byteLength;
  }
}

async function cancelResponseBody(response: globalThis.Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export async function fetchExportResource(
  url: string,
  dependencies: ExportResourceFetchDependencies = {}
): Promise<ExportResource> {
  const { response, finalUrl } = await fetchWithValidatedRedirects(
    url,
    {
      signal: AbortSignal.timeout(EXPORT_RESOURCE_TIMEOUT_MS),
      headers: {
        Accept:
          "image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
        "User-Agent": EXPORT_RESOURCE_USER_AGENT
      }
    },
    EXPORT_RESOURCE_URL_POLICY,
    dependencies
  );
  const responseContentType = response.headers.get("content-type");

  if (!response.ok) {
    await cancelResponseBody(response);
    throw new ExportResourceError(
      502,
      `Export resource fetch failed with HTTP ${response.status}.`
    );
  }

  const contentType = normalizeExportableImageContentType(responseContentType);
  if (!contentType) {
    await cancelResponseBody(response);
    throw new ExportResourceError(
      415,
      "Export resource is not a supported raster image."
    );
  }

  return {
    body: await readLimitedBody(response),
    contentType,
    finalUrl
  };
}

function getErrorStatus(error: unknown): number {
  if (error instanceof ExportResourceError) {
    return error.status;
  }
  if (error instanceof RetrievalUrlPolicyError) {
    return 400;
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return 504;
  }
  return 502;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof RetrievalUrlPolicyError) {
    return "Export resource URL is not allowed.";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "Could not fetch export resource.";
}

export function createExportResourceRequestHandler(
  dependencies: ExportResourceFetchDependencies = {}
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    const url = normalizeExportResourceUrl(req.query.url);
    if (!url) {
      res.status(400).json({ error: "A valid http or https URL is required." });
      return;
    }

    try {
      const resource = await fetchExportResource(url, dependencies);
      res.status(200);
      res.setHeader("Cache-Control", "private, max-age=86400");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="export-resource"'
      );
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Content-Type", resource.contentType);
      res.setHeader("Content-Length", String(resource.body.byteLength));
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Export-Resource-Url", resource.finalUrl);
      res.send(resource.body);
    } catch (error) {
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  };
}

export const handleExportResourceRequest = createExportResourceRequestHandler();

export function createMediaImageRequestHandler(
  dependencies: ExportResourceFetchDependencies = {}
): (req: Request, res: Response) => Promise<void> {
  const cache = new Map<string, CachedMediaImage>();
  let cachedBytes = 0;

  const remember = (url: string, resource: ExportResource): void => {
    if (resource.body.byteLength > MEDIA_IMAGE_CACHE_MAX_BYTES) {
      return;
    }
    while (
      cache.size > 0 &&
      cachedBytes + resource.body.byteLength > MEDIA_IMAGE_CACHE_MAX_BYTES
    ) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      cachedBytes -= oldest?.body.byteLength ?? 0;
    }
    cache.set(url, {
      ...resource,
      expiresAt: Date.now() + MEDIA_IMAGE_CACHE_TTL_MS
    });
    cachedBytes += resource.body.byteLength;
  };

  return async (req, res) => {
    const url = normalizeExportResourceUrl(req.query.url);
    if (!url) {
      res.status(400).json({ error: "A valid http or https URL is required." });
      return;
    }

    try {
      const existing = cache.get(url);
      if (existing && existing.expiresAt <= Date.now()) {
        cache.delete(url);
        cachedBytes -= existing.body.byteLength;
      }
      const cached = cache.get(url);
      const resource = cached ?? (await fetchExportResource(url, dependencies));
      if (!cached) {
        remember(url, resource);
      }

      res.status(200);
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.setHeader("Content-Disposition", 'inline; filename="media-image"');
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Content-Type", resource.contentType);
      res.setHeader("Content-Length", String(resource.body.byteLength));
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(resource.body);
    } catch (error) {
      res.status(getErrorStatus(error)).json({ error: getErrorMessage(error) });
    }
  };
}

export const handleMediaImageRequest = createMediaImageRequestHandler();
