import assert from "node:assert/strict";
import test from "node:test";
import {
  createRetrievalTools,
  createRetrievalToolStats
} from "./retrievalTool.js";

test("retrieval tool propagates run cancellation through a blocked page fetch", async () => {
  const originalFetch = globalThis.fetch;
  const originalAllowPrivateUrls =
    process.env.STREAMUI_RETRIEVAL_ALLOW_PRIVATE_URLS;
  const controller = new AbortController();
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  try {
    process.env.STREAMUI_RETRIEVAL_ALLOW_PRIVATE_URLS = "true";
    globalThis.fetch = (async (
      _input: string | URL | globalThis.Request,
      init?: RequestInit
    ) => {
      const signal = init?.signal;
      assert.ok(signal);
      markStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        const rejectFromSignal = () => reject(signal.reason);
        if (signal.aborted) {
          rejectFromSignal();
          return;
        }
        signal.addEventListener("abort", rejectFromSignal, { once: true });
      });
    }) as typeof fetch;

    const stats = createRetrievalToolStats();
    const retrieve = createRetrievalTools({
      messages: [{ role: "user", content: "Fetch the supplied page." }],
      searchSettings: {
        enabled: true,
        provider: "none",
        fetchMaxPages: 1,
        browserEngine: "fetch"
      },
      stats,
      signal: controller.signal
    }).retrieve;
    assert.ok(retrieve.execute);

    const pending = retrieve.execute(
      {
        url: "http://127.0.0.1:8787/blocked",
        mode: "fetch"
      },
      { toolCallId: "retrieve-1", messages: [] }
    );
    await started;
    controller.abort();

    await assert.rejects(
      Promise.resolve(pending),
      (error) => error instanceof Error && error.name === "AbortError"
    );
    assert.equal(stats.calls, 1);
    assert.equal(stats.errors, 0);
    assert.equal(stats.contexts.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalAllowPrivateUrls === undefined) {
      delete process.env.STREAMUI_RETRIEVAL_ALLOW_PRIVATE_URLS;
    } else {
      process.env.STREAMUI_RETRIEVAL_ALLOW_PRIVATE_URLS =
        originalAllowPrivateUrls;
    }
  }
});

test("retrieval tool keeps visual intent when the model supplies a terse query", async () => {
  const stats = createRetrievalToolStats();
  const retrieve = createRetrievalTools({
    messages: [
      {
        role: "user",
        content:
          "Create a gallery of videos and photos of North Harbor Festival 2026. I like night photography."
      }
    ],
    searchSettings: {
      enabled: true,
      provider: "none",
      fetchMaxPages: 0
    },
    stats
  }).retrieve;
  assert.ok(retrieve.execute);

  await retrieve.execute(
    {
      query: "North Harbor Festival 2026 night photography",
      mode: "search"
    },
    { toolCallId: "retrieve-visual", messages: [] }
  );

  assert.equal(stats.contexts.length, 1);
  assert.equal(stats.contexts[0].searchProvider, undefined);
  assert.ok(
    stats.contexts[0].queries.includes(
      "videos and photos of North Harbor Festival 2026"
    )
  );
  assert.match(
    stats.contexts[0].notes.join("\n"),
    /Recent-event visual search prioritized current web and social sources/
  );
});
