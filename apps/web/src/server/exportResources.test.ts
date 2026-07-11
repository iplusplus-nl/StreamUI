import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPORT_RESOURCE_MAX_BYTES,
  ExportResourceError,
  createExportResourceRequestHandler,
  createMediaImageRequestHandler,
  fetchExportResource,
  isExportableImageContentType,
  normalizeExportResourceUrl,
  type ExportResourceFetchDependencies
} from "../../server/exportResources.js";
import { RetrievalUrlPolicyError } from "../../server/retrievalUrlPolicy.js";

const publicLookup = async () => [
  { address: "93.184.216.34", family: 4 as const }
];

function testFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>
): NonNullable<ExportResourceFetchDependencies["fetchImpl"]> {
  return (async (input, init) => {
    const url =
      input instanceof globalThis.Request ? input.url : input.toString();
    return handler(url, init ?? {});
  }) as NonNullable<ExportResourceFetchDependencies["fetchImpl"]>;
}

test("normalizes export resource urls", () => {
  assert.equal(
    normalizeExportResourceUrl(" https://example.com/image.png#preview "),
    "https://example.com/image.png"
  );
  assert.equal(
    normalizeExportResourceUrl(["http://127.0.0.1:8787/api/files/a/content"]),
    "http://127.0.0.1:8787/api/files/a/content"
  );
  assert.equal(normalizeExportResourceUrl("file:///tmp/image.png"), undefined);
  assert.equal(normalizeExportResourceUrl("data:image/png;base64,abc"), undefined);
});

test("allows image content types for export resources", () => {
  assert.equal(isExportableImageContentType("image/png"), true);
  assert.equal(isExportableImageContentType("image/avif"), true);
  assert.equal(isExportableImageContentType("image/svg+xml; charset=utf-8"), false);
  assert.equal(isExportableImageContentType("image/bmp"), false);
  assert.equal(isExportableImageContentType("text/html"), false);
  assert.equal(isExportableImageContentType(null), false);
});

test("blocks loopback export resources before issuing a request", async () => {
  let fetchCalls = 0;

  await assert.rejects(
    fetchExportResource("http://127.0.0.1:8787/api/private", {
      fetchImpl: testFetch(() => {
        fetchCalls += 1;
        return new Response("private", {
          headers: { "Content-Type": "image/png" }
        });
      })
    }),
    RetrievalUrlPolicyError
  );

  assert.equal(fetchCalls, 0);
});

test("blocks a public-to-private redirect before requesting the private hop", async () => {
  const requestedUrls: string[] = [];

  await assert.rejects(
    fetchExportResource("https://public.example/image", {
      lookup: publicLookup,
      fetchImpl: testFetch((url) => {
        requestedUrls.push(url);
        return new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data" }
        });
      })
    }),
    RetrievalUrlPolicyError
  );

  assert.deepEqual(requestedUrls, ["https://public.example/image"]);
});

test("returns a public raster image with non-executable response headers", async () => {
  const headers = new Map<string, string>();
  let statusCode: number | undefined;
  let sentBody: Buffer | undefined;
  const response = {
    status(status: number) {
      statusCode = status;
      return this;
    },
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    send(body: Buffer) {
      sentBody = body;
      return this;
    },
    json() {
      throw new Error("Expected a successful response.");
    }
  };

  await createExportResourceRequestHandler({
    lookup: publicLookup,
    fetchImpl: testFetch(() =>
      new Response("png-bytes", {
        headers: { "Content-Type": "image/png; ignored=parameter" }
      })
    )
  })(
    { query: { url: "https://public.example/image.png" } } as never,
    response as never
  );

  assert.equal(statusCode, 200);
  assert.equal(sentBody?.toString(), "png-bytes");
  assert.equal(headers.get("content-type"), "image/png");
  assert.equal(
    headers.get("content-disposition"),
    'attachment; filename="export-resource"'
  );
  assert.equal(
    headers.get("content-security-policy"),
    "default-src 'none'; sandbox"
  );
  assert.equal(headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
});

test("serves browser media inline and reuses the verified server response", async () => {
  const headers = new Map<string, string>();
  let fetchCalls = 0;
  const response = {
    status() {
      return this;
    },
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    send() {
      return this;
    },
    json() {
      throw new Error("Expected a successful response.");
    }
  };
  const handler = createMediaImageRequestHandler({
    lookup: publicLookup,
    fetchImpl: testFetch(() => {
      fetchCalls += 1;
      return new Response("photo", { headers: { "Content-Type": "image/jpeg" } });
    })
  });
  const request = {
    query: { url: "https://public.example/photo.jpg" }
  } as never;

  await handler(request, response as never);
  await handler(request, response as never);

  assert.equal(fetchCalls, 1);
  assert.equal(headers.get("content-disposition"), 'inline; filename="media-image"');
  assert.equal(headers.get("cache-control"), "public, max-age=86400, immutable");
  assert.equal(headers.get("cross-origin-resource-policy"), "same-origin");
});

test("rejects and cancels active SVG content", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("<svg><script /></svg>"));
    },
    cancel() {
      cancelled = true;
    }
  });

  await assert.rejects(
    fetchExportResource("https://public.example/image.svg", {
      lookup: publicLookup,
      fetchImpl: testFetch(() =>
        new Response(body, {
          headers: { "Content-Type": "image/svg+xml" }
        })
      )
    }),
    (error) =>
      error instanceof ExportResourceError &&
      error.status === 415 &&
      /raster image/.test(error.message)
  );

  assert.equal(cancelled, true);
});

test("rejects and cancels an image body that exceeds 10 MB", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(EXPORT_RESOURCE_MAX_BYTES));
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    }
  });

  await assert.rejects(
    fetchExportResource("https://public.example/large.png", {
      lookup: publicLookup,
      fetchImpl: testFetch(() =>
        new Response(body, { headers: { "Content-Type": "image/png" } })
      )
    }),
    (error) =>
      error instanceof ExportResourceError &&
      error.status === 413 &&
      /too large/.test(error.message)
  );

  assert.equal(cancelled, true);
});
