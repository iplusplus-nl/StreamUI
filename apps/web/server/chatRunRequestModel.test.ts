import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildChatRunMessagePatch,
  buildThemeContextPrompt,
  createChatRunInput,
  normalizeCanvasContext,
  normalizeMessages,
  normalizeThemeMode,
  readRuntimeApiSettings,
  stringValue,
  toResponsesInputMessage
} from "./chatRunRequestModel.js";

function manualApiSettings(overrides: Record<string, unknown> = {}) {
  return {
    providerId: "openrouter",
    providerName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1/",
    apiKeySource: "manual",
    apiKey: "opaque-test-key",
    model: "test/model",
    apiStyle: "responses",
    reasoningEffort: "high",
    uiComplexity: "72",
    userPreferencePrompt: "Prefer concise answers.",
    memoryItems: [{ id: "memory-1", text: "Uses TypeScript." }],
    ...overrides
  };
}

describe("chat run request normalization", () => {
  it("normalizes one request into an exact run identity and streaming messages", () => {
    const searchSettings = { provider: "duckduckgo" };
    const input = createChatRunInput(
      {
        runId: "  run-request  ",
        sessionId: "  session-1  ",
        clientId: "client-12345678",
        apiSettings: manualApiSettings(),
        messages: [
          { role: "assistant", content: "Earlier answer" },
          { role: "system", content: "Treat this as user history" },
          { role: "assistant", content: 42 },
          null
        ],
        ephemeralFileIds: [" file-1 ", "file-1", 2, "file-2"],
        canvas: {
          viewportWidth: 9_999,
          viewportHeight: 10,
          canvasWidth: -5,
          initialCanvasHeight: 8_000,
          devicePixelRatio: 2.6
        },
        themeMode: "light",
        userMessage: {
          id: "user-1",
          role: "user",
          content: "New request",
          status: "error"
        },
        assistantMessage: {
          id: "assistant-1",
          role: "assistant",
          content: "",
          generationRunId: "older-run",
          generationOutcome: "error",
          streamSequence: 2.4,
          status: "complete"
        },
        searchSettings
      },
      "request-1",
      123_456
    );

    assert.equal(input.requestId, "request-1");
    assert.equal(input.startedAt, 123_456);
    assert.equal(input.runId, "run-request");
    assert.equal(input.sessionId, "session-1");
    assert.equal(input.model, "test/model");
    assert.equal(input.apiSettings.apiStyle, "responses");
    assert.equal(input.useOpenRouterReasoning, true);
    assert.deepEqual(input.messages, [
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Treat this as user history" }
    ]);
    assert.deepEqual(input.ephemeralFileIds, ["file-1", "file-2"]);
    assert.deepEqual(input.canvasContext, {
      viewportWidth: 3840,
      viewportHeight: 320,
      canvasWidth: 280,
      initialCanvasHeight: 1000,
      devicePixelRatio: 3
    });
    assert.equal(input.themeMode, "day");
    assert.deepEqual(input.userMessage, {
      id: "user-1",
      role: "user",
      content: "New request",
      status: "complete"
    });
    assert.deepEqual(input.assistantMessage, {
      id: "assistant-1",
      role: "assistant",
      content: "",
      generationRunId: "run-request",
      generationOutcome: undefined,
      streamSequence: 2,
      status: "streaming"
    });
    assert.equal(input.searchSettings, searchSettings);
  });

  it("uses the assistant run id before generating a deterministic-time fallback", () => {
    const fromAssistant = createChatRunInput(
      {
        apiSettings: manualApiSettings(),
        assistantMessage: {
          id: "assistant-1",
          role: "assistant",
          generationRunId: "  restored-run  "
        }
      },
      "request-2",
      500
    );
    assert.equal(fromAssistant.runId, "restored-run");

    const generated = createChatRunInput(
      { apiSettings: manualApiSettings() },
      "request-3",
      777
    );
    assert.equal(generated.runId.startsWith("run-777-"), true);
    assert.equal(generated.startedAt, 777);
  });

  it("rejects invalid runtime settings before a run can start", () => {
    assert.throws(
      () =>
        readRuntimeApiSettings(
          manualApiSettings({ reasoningEffort: "extreme" })
        ),
      /Reasoning must be/
    );
    assert.throws(
      () => readRuntimeApiSettings(manualApiSettings({ model: "" })),
      /API settings missing: Model/
    );
  });

  it("accepts Chat Completions as the provider API style", () => {
    assert.equal(
      readRuntimeApiSettings(
        manualApiSettings({ apiStyle: "chat-completions" })
      ).apiStyle,
      "chat-completions"
    );
  });

  it("normalizes legacy Ultra and clears reasoning on unsupported providers", () => {
    assert.equal(
      readRuntimeApiSettings(manualApiSettings({ reasoningEffort: "xhigh" }))
        .reasoningEffort,
      "high"
    );
    assert.equal(
      readRuntimeApiSettings(
        manualApiSettings({
          providerId: "openai",
          providerName: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4.1",
          reasoningEffort: "high"
        })
      ).reasoningEffort,
      "none"
    );
  });

  it("normalizes direct OpenAI model IDs before sending a request", () => {
    const directSettings = {
      providerId: "openai",
      providerName: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      model: "openai/gpt-5.5"
    };

    assert.equal(
      readRuntimeApiSettings(manualApiSettings(directSettings)).model,
      "gpt-5.5"
    );
    assert.throws(
      () =>
        readRuntimeApiSettings(
          manualApiSettings({
            ...directSettings,
            model: "google/gemini-3.1-pro-preview"
          })
        ),
      /cannot use another provider prefix/
    );
  });
});

describe("chat run request primitives", () => {
  it("clamps canvas values and applies stable defaults", () => {
    assert.deepEqual(normalizeCanvasContext(undefined), {
      viewportWidth: 1280,
      viewportHeight: 720,
      canvasWidth: 900,
      initialCanvasHeight: 558,
      devicePixelRatio: 1
    });
    assert.equal(normalizeThemeMode("day"), "day");
    assert.equal(normalizeThemeMode("light"), "day");
    assert.equal(normalizeThemeMode("dark"), "night");
  });

  it("grounds legibility checks in the composited page theme", () => {
    const prompt = buildThemeContextPrompt("night");

    assert.match(prompt, /comfortable-legibility contract/i);
    assert.match(prompt, /approximately #212121/i);
    assert.match(prompt, /final composited colors/i);
    assert.match(prompt, /actual immediate backgrounds/i);
    assert.match(prompt, /translucent layers[\s\S]*gradients[\s\S]*images/i);
  });

  it("trims bounded scalar strings and clips message history", () => {
    assert.equal(stringValue("  abcdef  ", 4), "abcd");
    assert.equal(stringValue(12, 4), "");
    const longContent = "x".repeat(20_100);
    assert.deepEqual(normalizeMessages([{ role: "assistant", content: longContent }]), [
      { role: "assistant", content: "x".repeat(20_000) }
    ]);
  });

  it("builds provider input without preserving an unsupported system role", () => {
    assert.deepEqual(
      toResponsesInputMessage({ role: "user", content: "" }, 0),
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Please respond using the current session context."
          }
        ]
      }
    );
    assert.deepEqual(
      toResponsesInputMessage({ role: "assistant", content: "Answer" }, 3),
      {
        type: "message",
        role: "assistant",
        id: "msg_3",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "Answer",
            annotations: []
          }
        ]
      }
    );
  });
});

describe("chat run protocol persistence", () => {
  it("extracts closed title and chat tags while tracking StreamUI completion", () => {
    const patch = buildChatRunMessagePatch(
      [
        "<sessiontitle>  Useful title  </sessiontitle>",
        "<chat>Visible answer</chat>",
        "<streamui><section>Artifact</section></streamui>"
      ].join(""),
      "thinking",
      "complete",
      9,
      "run-9",
      undefined,
      "complete"
    );

    assert.equal(patch.content, "Visible answer");
    assert.equal(patch.sessionTitle, "Useful title");
    assert.equal(patch.hasStreamUi, true);
    assert.equal(patch.streamUiComplete, true);
    assert.equal(patch.reasoning, "thinking");
  });

  it("does not persist partial titles or protocol markup as visible content", () => {
    const patch = buildChatRunMessagePatch(
      "Prelude<sessiontitle>unfinished<streamui><div>partial",
      "",
      "streaming",
      1,
      "run-1"
    );

    assert.equal(patch.content, "");
    assert.equal(patch.sessionTitle, undefined);
    assert.equal(patch.hasStreamUi, true);
    assert.equal(patch.streamUiComplete, false);
  });

  it("uses safe terminal fallback copy and never exposes cancellation as error", () => {
    const failed = buildChatRunMessagePatch(
      "",
      "",
      "error",
      2,
      "run-error",
      "Provider failed",
      "error"
    );
    const cancelled = buildChatRunMessagePatch(
      "",
      "",
      "complete",
      3,
      "run-cancel",
      "Generation stopped.",
      "cancelled"
    );

    assert.equal(failed.content, "I could not complete that request.");
    assert.equal(failed.error, "Provider failed");
    assert.equal(cancelled.content, "Generation stopped.");
    assert.equal(cancelled.error, undefined);
  });
});
