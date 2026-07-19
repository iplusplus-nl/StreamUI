import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeApiSettings } from "../../core/apiSettings";
import {
  fetchBrowserDirectModelCatalog,
  requestBrowserDirectText,
  startBrowserDirectChatRun,
  usesBrowserDirectProvider
} from "./browserDirectProvider";

function manualSettings(overrides: Record<string, unknown> = {}) {
  return normalizeApiSettings({
    providerId: "openrouter",
    providerName: "OpenRouter",
    baseUrl: "https://provider.example/v1",
    modelsEndpoint: "https://provider.example/v1/models",
    apiKeySource: "manual",
    apiKey: "sk-private-browser-key",
    model: "vendor/model",
    reasoningEffort: "none",
    ...overrides
  });
}

describe("browser-direct provider transport", () => {
  it("recognizes manual keys as browser-direct only", () => {
    assert.equal(usesBrowserDirectProvider(manualSettings()), true);
    assert.equal(
      usesBrowserDirectProvider(
        normalizeApiSettings({
          ...manualSettings(),
          apiKeySource: "environment"
        })
      ),
      false
    );
  });

  it("streams chat from the provider without putting the key in the body", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(
        [
          'data: {"type":"response.output_text.delta","delta":"<chat>Hello"}',
          "",
          'data: {"type":"response.output_text.delta","delta":"</chat>"}',
          "",
          'data: {"type":"response.completed","response":{"output":[]}}',
          ""
        ].join("\n"),
        { headers: { "Content-Type": "text/event-stream" } }
      );
    };

    const response = await startBrowserDirectChatRun(
      {
        runId: "run-direct",
        messages: [{ role: "user", content: "Hello" }],
        files: [],
        apiSettings: manualSettings()
      },
      "client-ignored",
      new AbortController().signal,
      fetchImpl
    );

    assert.equal(calls.length, 1);
    assert.equal(String(calls[0].input), "https://provider.example/v1/responses");
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.credentials, "omit");
    assert.equal(calls[0].init?.redirect, "error");
    assert.equal(calls[0].init?.referrerPolicy, "no-referrer");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk-private-browser-key");
    const body = String(calls[0].init?.body);
    assert.doesNotMatch(body, /sk-private-browser-key/);
    assert.match(body, /vendor\/model/);

    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(
      events.map((event) => [event.type, event.text, event.status]),
      [
        ["content", "<chat>Hello", undefined],
        ["content", "</chat>", undefined],
        ["done", undefined, "complete"]
      ]
    );
    assert.equal(events.every((event) => event.runId === "run-direct"), true);
  });

  it("streams chat through the Chat Completions API when selected", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const response = await startBrowserDirectChatRun(
      {
        runId: "run-completions",
        messages: [{ role: "user", content: "Hello" }],
        apiSettings: manualSettings({ apiStyle: "chat-completions" })
      },
      "client",
      new AbortController().signal,
      async (input, init) => {
        calls.push({ input, init });
        return new Response(
          [
            'data: {"choices":[{"delta":{"content":"<chat>Hello"},"finish_reason":null}]}',
            "",
            'data: {"choices":[{"delta":{"content":"</chat>"},"finish_reason":"stop"}]}',
            "",
            "data: [DONE]",
            ""
          ].join("\n")
        );
      }
    );

    assert.equal(
      String(calls[0].input),
      "https://provider.example/v1/chat/completions"
    );
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    assert.equal("messages" in body, true);
    assert.equal("input" in body, false);
    assert.equal(body.max_tokens, 16_000);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; text?: string; status?: string });
    assert.deepEqual(
      events.map((event) => [event.type, event.text, event.status]),
      [
        ["content", "<chat>Hello", undefined],
        ["content", "</chat>", undefined],
        ["done", undefined, "complete"]
      ]
    );
  });

  it("reads non-streaming Chat Completions text responses", async () => {
    const text = await requestBrowserDirectText(
      manualSettings({ apiStyle: "chat-completions" }),
      {
        instructions: "Return JSON.",
        input: [{ role: "user", content: "Edit this" }]
      },
      new AbortController().signal,
      async (input, init) => {
        assert.equal(
          String(input),
          "https://provider.example/v1/chat/completions"
        );
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal("messages" in body, true);
        return Response.json({
          choices: [{ message: { content: '{"edits":[]}' } }]
        });
      }
    );

    assert.equal(text, '{"edits":[]}');
  });

  it("fetches models directly with the key only in provider authorization", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const models = await fetchBrowserDirectModelCatalog(
      manualSettings(),
      async (input, init) => {
        calls.push({ input, init });
        return Response.json({
          data: [{ id: "vendor/a" }, { id: "vendor/b" }]
        });
      }
    );

    assert.deepEqual(models, ["vendor/a", "vendor/b"]);
    assert.equal(String(calls[0].input), "https://provider.example/v1/models");
    assert.equal(calls[0].init?.method, "GET");
    assert.equal(
      (calls[0].init?.headers as Record<string, string>).Authorization,
      "Bearer sk-private-browser-key"
    );
  });

  it("does not duplicate done-only provider text at completion", async () => {
    const response = await startBrowserDirectChatRun(
      {
        runId: "run-done-only",
        messages: [{ role: "user", content: "Hello" }],
        apiSettings: manualSettings()
      },
      "client",
      new AbortController().signal,
      async () =>
        new Response(
          [
            'data: {"type":"response.output_text.done","text":"Only once"}',
            "",
            'data: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"Only once"}]}]}}',
            ""
          ].join("\n")
        )
    );
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; text?: string });
    assert.deepEqual(
      events.filter((event) => event.type === "content").map((event) => event.text),
      ["Only once"]
    );
  });

  it("refuses to send a key over remote plain HTTP", async () => {
    let called = false;
    await assert.rejects(
      startBrowserDirectChatRun(
        {
          messages: [{ role: "user", content: "Hello" }],
          apiSettings: normalizeApiSettings({
            ...manualSettings(),
            baseUrl: "http://provider.example/v1"
          })
        },
        "client",
        new AbortController().signal,
        async () => {
          called = true;
          return Response.json({});
        }
      ),
      /must use HTTPS/
    );
    assert.equal(called, false);
  });
});
