import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ChatSession,
  ClientMessage,
  SessionState
} from "../../domain/chat/sessionModel";
import type {
  SendStreamUiRequestOptions
} from "../chat/chatRunRequest";
import {
  createGeneratedArtifactBatchController,
  type GeneratedArtifactBatchControllerPorts
} from "./generatedArtifactBatchController";
import { originalRaw, regeneratedRaw } from "./artifactEditOperationTestFixtures";

function messages(): ClientMessage[] {
  return [
    { id: "intro", role: "user", content: "Intro" },
    {
      id: "intro-assistant",
      role: "assistant",
      content: "Hello",
      status: "complete"
    },
    { id: "user-1", role: "user", content: "Generate an artifact" },
    {
      id: "assistant-1",
      role: "assistant",
      content: "Original",
      rawStream: originalRaw,
      reasoning: "Original reasoning",
      status: "complete"
    }
  ];
}

function session(id = "session-1"): ChatSession {
  return {
    id,
    title: id,
    createdAt: 1,
    updatedAt: 1,
    messages: messages(),
    files: []
  };
}

function input() {
  return {
    sessionId: "session-1",
    assistantId: "assistant-1",
    sourceUserMessageId: "user-1",
    prompt: "Regenerate the artifact"
  };
}

function harness(overrides: Partial<GeneratedArtifactBatchControllerPorts> = {}) {
  let state: SessionState = {
    sessions: [session("session-1"), session("session-2")],
    activeSessionId: "session-1"
  };
  let busy = false;
  let saveCount = 0;
  let id = 0;
  const requests: Array<{
    text: string;
    attachments: unknown[];
    options: SendStreamUiRequestOptions;
  }> = [];
  const warnings: Array<{ message: string; error: unknown }> = [];
  const ports: GeneratedArtifactBatchControllerPorts = {
    getState: () => state,
    isBusy: () => busy,
    sendRequest: async (text, attachments = [], options = {}) => {
      requests.push({ text, attachments, options });
    },
    saveNow: () => {
      saveCount += 1;
    },
    themeMode: "night",
    createId: (prefix) => `${prefix}-${++id}`,
    now: () => 100,
    warn: (message, error) => warnings.push({ message, error }),
    ...overrides
  };
  const controller = createGeneratedArtifactBatchController(ports);

  return {
    controller,
    requests,
    warnings,
    get state() {
      return state;
    },
    set state(next: SessionState) {
      state = next;
    },
    set busy(value: boolean) {
      busy = value;
    },
    get saveCount() {
      return saveCount;
    }
  };
}

describe("generated artifact batch controller", () => {
  it("builds an exact, tokenized request from live state", () => {
    const test = harness();
    const result = test.controller.start(input());

    assert.equal(result.status, "started");
    assert.equal(test.requests.length, 1);
    const request = test.requests[0];
    assert.equal(request.text, "Regenerate the artifact");
    assert.equal(request.options.targetSessionId, "session-1");
    assert.equal(request.options.assistantMessageId, "assistant-1");
    assert.equal(request.options.generationRunId, "run-1");
    assert.equal(request.options.appendUserMessage, false);
    assert.equal(
      request.options.assistantPatch?.artifactEdits?.[0].origin,
      "chat-run"
    );
    assert.equal(
      request.options.assistantPatch?.artifactEdits?.[0].variants[0]
        .operationId,
      "artifact-edit-operation-2"
    );
    assert.equal(
      request.options.validateRequestSession?.(test.state.sessions[0]),
      true
    );
    assert.equal(
      request.options.validateRequestSession?.(test.state.sessions[1]),
      false
    );
  });

  it("rebuilds history from replay-time messages instead of a stale snapshot", () => {
    const test = harness();
    test.controller.start(input());
    const options = test.requests[0].options;
    assert.equal(typeof options.requestHistory, "function");
    const liveMessages = [
      { id: "new-user", role: "user" as const, content: "New" },
      ...messages()
    ];
    const syntheticUser: ClientMessage = {
      id: "synthetic",
      role: "user",
      content: "Regenerate"
    };
    const history = (
      options.requestHistory as Exclude<
        SendStreamUiRequestOptions["requestHistory"],
        ClientMessage[] | undefined
      >
    )(liveMessages, syntheticUser, liveMessages.at(-1)!);

    assert.deepEqual(
      history.map((message) => message.id),
      ["new-user", "intro", "intro-assistant", "synthetic"]
    );

    const visual = harness();
    visual.controller.start({
      ...input(),
      historyMode: "through-target-assistant"
    });
    const visualHistory = (
      visual.requests[0].options.requestHistory as Exclude<
        SendStreamUiRequestOptions["requestHistory"],
        ClientMessage[] | undefined
      >
    )(liveMessages, syntheticUser, liveMessages.at(-1)!);
    assert.deepEqual(
      visualHistory.map((message) => message.id),
      [
        "new-user",
        "intro",
        "intro-assistant",
        "user-1",
        "assistant-1",
        "synthetic"
      ]
    );
  });

  it("revalidates target identity and source before managed-auth replay", () => {
    const test = harness();
    test.controller.start(input());
    const validate = test.requests[0].options.validateRequestSession;
    assert.ok(validate);

    const deleted = {
      ...test.state.sessions[0],
      messages: test.state.sessions[0].messages.filter(
        (message) => message.id !== "assistant-1"
      )
    };
    assert.equal(validate(deleted), false);

    const changed = {
      ...test.state.sessions[0],
      messages: test.state.sessions[0].messages.map((message) =>
        message.id === "assistant-1"
          ? { ...message, rawStream: regeneratedRaw }
          : message
      )
    };
    assert.equal(validate(changed), false);
  });

  it("inserts and reduces only the exact target operation", async () => {
    const test = harness();
    const result = test.controller.start(input());
    assert.equal(result.status, "started");
    if (result.status !== "started") {
      return;
    }
    const options = test.requests[0].options;
    const assistantMessage: ClientMessage = {
      ...options.assistantPatch,
      id: "assistant-1",
      role: "assistant",
      content: "",
      rawStream: "",
      generationRunId: options.generationRunId,
      status: "streaming"
    };
    const withDuplicateInOneSession = [
      ...messages(),
      {
        id: "assistant-1",
        role: "assistant" as const,
        content: "Duplicate",
        rawStream: "duplicate",
        status: "complete" as const
      }
    ];
    const inserted = options.insertMessages?.(
      withDuplicateInOneSession,
      { id: "synthetic", role: "user", content: "prompt" },
      assistantMessage
    );
    assert.ok(inserted);
    assert.equal(inserted[3].generationRunId, options.generationRunId);
    assert.equal(inserted[4], withDuplicateInOneSession[4]);

    const streamed = options.reduceAssistantPatch?.(
      inserted[3],
      { rawStream: "partial", content: "Partial" },
      "streaming"
    );
    assert.equal(streamed?.rawStream, "partial");
    assert.equal(streamed?.artifactEdits?.[0].status, "pending");

    const completed = options.reduceAssistantPatch?.(
      streamed!,
      { rawStream: regeneratedRaw, status: "complete" },
      "complete"
    );
    assert.equal(completed?.rawStream, regeneratedRaw);
    assert.equal(completed?.artifactEdits?.[0].status, "complete");

    options.onAssistantPhaseApplied?.("streaming");
    assert.equal(test.saveCount, 0);
    options.onAssistantPhaseApplied?.("complete");
    await Promise.resolve();
    assert.equal(test.saveCount, 1);

    const duplicateSessionMessage = test.state.sessions[1].messages[3];
    assert.equal(
      options.reduceAssistantPatch?.(
        duplicateSessionMessage,
        { rawStream: "foreign" },
        "streaming"
      ),
      duplicateSessionMessage
    );
  });

  it("returns busy, missing, and invalid without sending", () => {
    const busy = harness();
    busy.busy = true;
    assert.deepEqual(busy.controller.start(input()), { status: "busy" });
    assert.equal(busy.requests.length, 0);

    const missing = harness();
    assert.deepEqual(
      missing.controller.start({ ...input(), sessionId: "missing" }),
      { status: "missing" }
    );
    assert.deepEqual(
      missing.controller.start({ ...input(), assistantId: "missing" }),
      { status: "missing" }
    );
    assert.deepEqual(
      missing.controller.start({ ...input(), sourceUserMessageId: "missing" }),
      { status: "missing" }
    );
    assert.equal(missing.requests.length, 0);

    const invalid = harness();
    assert.deepEqual(
      invalid.controller.start({ ...input(), prompt: " " }),
      { status: "invalid" }
    );
    invalid.state = {
      ...invalid.state,
      sessions: invalid.state.sessions.map((candidate, index) =>
        index === 0
          ? {
              ...candidate,
              messages: candidate.messages.map((message) =>
                message.id === "assistant-1"
                  ? { ...message, rawStream: "" }
                  : message
              )
            }
          : candidate
      )
    };
    assert.deepEqual(invalid.controller.start(input()), { status: "invalid" });
    assert.equal(invalid.requests.length, 0);
  });

  it("serializes same-tick starts through the shared busy source", () => {
    let busy = false;
    let requestCount = 0;
    const test = harness({
      isBusy: () => busy,
      sendRequest: async () => {
        requestCount += 1;
        busy = true;
      }
    });

    assert.equal(test.controller.start(input()).status, "started");
    assert.equal(test.controller.start(input()).status, "busy");
    assert.equal(requestCount, 1);
  });

  it("forwards a pre-acquired chat lease and visual request ownership hooks", async () => {
    const test = harness();
    test.busy = true;
    const lease = { release() {} };
    let accepted = false;
    const result = test.controller.start({
      ...input(),
      runId: " visual-run ",
      chatActivityLease: lease,
      ephemeralAttachments: true,
      onRunAccepted: () => {
        accepted = true;
      }
    });

    assert.equal(result.status, "started");
    if (result.status !== "started") {
      return;
    }
    assert.equal(result.operation.runId, "visual-run");
    assert.equal(test.requests[0].options.generationRunId, "visual-run");
    assert.equal(test.requests[0].options.chatActivityLease, lease);
    assert.equal(test.requests[0].options.ephemeralAttachments, true);
    test.requests[0].options.onRunAccepted?.();
    assert.equal(accepted, true);
    assert.deepEqual(await result.completion, { status: "fulfilled" });
  });

  it("contains asynchronous request failures and reports them once", async () => {
    const failure = new Error("request failed");
    const test = harness({
      sendRequest: async () => {
        throw failure;
      }
    });
    const result = test.controller.start(input());
    assert.equal(result.status, "started");
    if (result.status !== "started") {
      return;
    }
    assert.deepEqual(await result.completion, {
      status: "rejected",
      error: failure
    });

    assert.deepEqual(test.warnings, [
      { message: "Could not run generated artifact batch.", error: failure }
    ]);
  });

  it("contains synchronous request and terminal-save failures", () => {
    const requestFailure = new Error("sync request failure");
    const request = harness({
      sendRequest: (() => {
        throw requestFailure;
      }) as GeneratedArtifactBatchControllerPorts["sendRequest"]
    });
    assert.deepEqual(request.controller.start(input()), { status: "failed" });
    assert.deepEqual(request.warnings, [
      {
        message: "Could not run generated artifact batch.",
        error: requestFailure
      }
    ]);

    const saveFailure = new Error("sync save failure");
    const save = harness({
      saveNow: () => {
        throw saveFailure;
      }
    });
    assert.equal(save.controller.start(input()).status, "started");
    assert.doesNotThrow(() =>
      save.requests[0].options.onAssistantPhaseApplied?.("complete")
    );
    assert.deepEqual(save.warnings, [
      {
        message: "Could not save generated artifact batch state.",
        error: saveFailure
      }
    ]);
  });
});
