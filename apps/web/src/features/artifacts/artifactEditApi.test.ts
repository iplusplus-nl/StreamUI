import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  didArtifactEditChangeSource,
  normalizeArtifactEditResponse,
  requestArtifactEdit
} from "./artifactEditApi";

const source = "<chat></chat><streamui><p>Before</p></streamui>";
const updated = "<chat></chat><streamui><p>After</p></streamui>";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe("artifact edit API", () => {
  it("normalizes responses and caps summaries", () => {
    assert.deepEqual(
      normalizeArtifactEditResponse({
        rawStream: updated,
        summary: `  ${"x".repeat(600)}  `,
        edits: [{ occurrence: 1 }]
      }),
      {
        rawStream: updated,
        summary: "x".repeat(500),
        edits: [{ occurrence: 1 }]
      }
    );
    assert.throws(() => normalizeArtifactEditResponse(null), /response was empty/);
    assert.throws(
      () => normalizeArtifactEditResponse({ rawStream: "  " }),
      /did not return updated source/
    );
  });

  it("compares source after trimming transport whitespace", () => {
    assert.equal(didArtifactEditChangeSource(source, `  ${source}\n`), false);
    assert.equal(didArtifactEditChangeSource(source, updated), true);
  });

  it("posts an edit request and returns the validated result", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return Response.json({
        rawStream: updated,
        summary: "Changed copy",
        edits: [{ occurrence: 1 }]
      });
    };
    const controller = new AbortController();
    const request = {
      source,
      prompt: "Change the copy",
      references: [],
      apiSettings: { model: "test/model" }
    };

    assert.deepEqual(
      await requestArtifactEdit(
        request,
        "client-1",
        controller.signal,
        fetchImpl
      ),
      {
        rawStream: updated,
        summary: "Changed copy",
        edits: [{ occurrence: 1 }]
      }
    );
    assert.equal(calls[0].input, "/api/artifact-edits");
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.signal, controller.signal);
    assert.deepEqual(calls[0].init?.headers, {
      "Content-Type": "application/json",
      "X-ChatHTML-Client-Id": "client-1"
    });
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), request);
  });

  it("rejects unchanged source and sanitized HTTP failures", async () => {
    const unchangedFetch: typeof fetch = async () =>
      Response.json({ rawStream: ` ${source} ` });
    await assert.rejects(
      requestArtifactEdit(
        { source, prompt: "No-op", references: [], apiSettings: {} },
        "client-1",
        new AbortController().signal,
        unchangedFetch
      ),
      /did not change the source/
    );

    const failedFetch: typeof fetch = async () =>
      Response.json({ error: "Provider unavailable" }, { status: 502 });
    await assert.rejects(
      requestArtifactEdit(
        { source, prompt: "Change", references: [], apiSettings: {} },
        "client-1",
        new AbortController().signal,
        failedFetch
      ),
      /HTTP 502.*Provider unavailable/
    );
  });

  it("rejects an abort that arrives while the response body is pending", async () => {
    const body = deferred<unknown>();
    const fetchImpl: typeof fetch = async () =>
      ({
        ok: true,
        json: () => body.promise
      }) as Response;
    const controller = new AbortController();
    const pending = requestArtifactEdit(
      { source, prompt: "Change", references: [], apiSettings: {} },
      "client-1",
      controller.signal,
      fetchImpl
    );

    await Promise.resolve();
    controller.abort();
    body.resolve({ rawStream: updated });

    await assert.rejects(pending, (error: unknown) => {
      assert.equal((error as { name?: unknown }).name, "AbortError");
      return true;
    });
  });
});
