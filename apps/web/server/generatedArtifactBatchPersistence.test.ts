import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  SessionMessageInput,
  SessionMessagePatch
} from "./sessions.js";
import {
  CHAT_RUN_CANCELLED_MESSAGE,
  buildAssistantPresentationPatch,
  finalizeGeneratedArtifactBatchPatch
} from "./generatedArtifactBatchPersistence.js";

const baseRaw =
  "<chat>Original explanation</chat><streamui><main>Original</main></streamui>";
const parentRaw =
  "<chat>Parent explanation</chat><streamui><main>Parent</main></streamui>";
const completedRaw =
  "<chat>Updated explanation</chat><streamui><main>Updated</main></streamui>";

function completeEdit(id: string, rawStream: string) {
  return {
    id,
    origin: "source-edit",
    createdAt: 1,
    prompt: "Earlier edit",
    references: [],
    activeVariantId: `${id}-variant`,
    variants: [
      {
        id: `${id}-variant`,
        createdAt: 1,
        status: "complete",
        rawStream
      }
    ],
    status: "complete"
  };
}

function pendingChatEdit(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: "generated-edit",
    origin: "chat-run",
    createdAt: 20,
    prompt: "Regenerate this artifact",
    references: [],
    activeVariantId: "generated-variant",
    variants: [
      {
        id: "generated-variant",
        operationId: "operation-1",
        createdAt: 20,
        status: "pending"
      }
    ],
    status: "pending",
    ...overrides
  };
}

function assistant(
  edits: Record<string, unknown>[],
  overrides: Partial<SessionMessageInput> = {}
): SessionMessageInput {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "Original explanation",
    rawStream: baseRaw,
    hasStreamUi: true,
    streamUiComplete: true,
    artifactEditBaseRawStream: baseRaw,
    artifactEdits: edits,
    activeArtifactEditId: "generated-edit",
    status: "streaming",
    ...overrides
  };
}

function terminalPatch(
  overrides: SessionMessagePatch = {}
): SessionMessagePatch {
  return {
    content: "Updated explanation",
    rawStream: completedRaw,
    hasStreamUi: true,
    streamUiComplete: true,
    generationRunId: "run-1",
    streamSequence: 17,
    status: "complete",
    ...overrides
  };
}

describe("generated artifact batch terminal persistence", () => {
  it("completes only the active chat-run edit and stores terminal raw", () => {
    const unrelated = completeEdit("earlier-edit", parentRaw);
    const pending = pendingChatEdit({ parentId: "earlier-edit" });
    const message = assistant([unrelated, pending]);
    const patch = terminalPatch();

    const result = finalizeGeneratedArtifactBatchPatch({
      assistantMessage: message,
      patch,
      status: "complete"
    });

    assert.notEqual(result, patch);
    assert.equal(result.status, "complete");
    assert.equal(result.error, undefined);
    assert.equal(result.rawStream, completedRaw);
    assert.equal(result.activeArtifactEditId, "generated-edit");
    assert.equal(result.artifactEditBaseRawStream, baseRaw);
    const edits = result.artifactEdits as Record<string, unknown>[];
    assert.equal(edits[0], unrelated);
    assert.equal(edits[1].status, "complete");
    assert.equal(edits[1].error, undefined);
    const variants = edits[1].variants as Record<string, unknown>[];
    assert.equal(variants[0].status, "complete");
    assert.equal(variants[0].rawStream, completedRaw);
    assert.equal(variants[0].operationId, "operation-1");
    assert.equal(variants[0].createdAt, 20);
  });

  it("fails an empty successful terminal instead of storing an empty version", () => {
    const message = assistant([pendingChatEdit()]);
    const result = finalizeGeneratedArtifactBatchPatch({
      assistantMessage: message,
      patch: terminalPatch({ content: "", rawStream: "" }),
      status: "complete"
    });

    assert.equal(result.status, "error");
    assert.equal(
      result.error,
      "The artifact regeneration completed without output."
    );
    assert.equal(result.rawStream, baseRaw);
    assert.equal(result.activeArtifactEditId, undefined);
    assert.equal(
      (result.artifactEdits as Record<string, unknown>[])[0].status,
      "error"
    );
  });

  it("marks a failed edit and restores its parent presentation and rollback metadata", () => {
    const parent = completeEdit("parent-edit", parentRaw);
    const pending = pendingChatEdit({
      parentId: "parent-edit",
      rollback: {
        reasoning: "Earlier reasoning",
        sessionTitle: "Earlier title",
        repairOfMessageId: "repair-source",
        repairAttempt: 2
      }
    });
    const message = assistant([parent, pending]);
    const patch = terminalPatch({
      content: "partial failure text",
      rawStream: "<chat>partial failure text",
      reasoning: "New partial reasoning",
      status: "error",
      error: "Provider failed"
    });

    const result = finalizeGeneratedArtifactBatchPatch({
      assistantMessage: message,
      patch,
      status: "error",
      error: "Provider failed"
    });

    assert.equal(result.status, "error");
    assert.equal(result.error, "Provider failed");
    assert.equal(result.rawStream, parentRaw);
    assert.equal(result.content, "Parent explanation");
    assert.equal(result.hasStreamUi, true);
    assert.equal(result.streamUiComplete, true);
    assert.equal(result.reasoning, "Earlier reasoning");
    assert.equal(result.sessionTitle, "Earlier title");
    assert.equal(result.repairOfMessageId, "repair-source");
    assert.equal(result.repairAttempt, 2);
    assert.equal(result.activeArtifactEditId, "parent-edit");
    const edits = result.artifactEdits as Record<string, unknown>[];
    assert.equal(edits[0], parent);
    assert.equal(edits[1].status, "error");
    assert.equal(edits[1].error, "Provider failed");
    const variants = edits[1].variants as Record<string, unknown>[];
    assert.equal(variants[0].status, "error");
    assert.equal(variants[0].error, "Provider failed");
    assert.equal(variants[0].rawStream, undefined);
  });

  it("cancels by removing the pending edit and restoring the parent version", () => {
    const parent = completeEdit("parent-edit", parentRaw);
    const unrelated = completeEdit("unrelated-edit", completedRaw);
    const pending = pendingChatEdit({
      parentId: "parent-edit",
      rollback: {}
    });
    const message = assistant([parent, unrelated, pending]);
    const patch = terminalPatch({
      content: CHAT_RUN_CANCELLED_MESSAGE,
      rawStream: "",
      reasoning: "Temporary reasoning"
    });

    const result = finalizeGeneratedArtifactBatchPatch({
      assistantMessage: message,
      patch,
      status: "complete",
      error: CHAT_RUN_CANCELLED_MESSAGE
    });

    assert.equal(result.status, "complete");
    assert.equal(result.error, undefined);
    assert.equal(result.rawStream, parentRaw);
    assert.equal(result.content, "Parent explanation");
    assert.equal(result.reasoning, undefined);
    assert.equal(result.repairOfMessageId, undefined);
    assert.equal(result.repairAttempt, undefined);
    assert.equal(result.activeArtifactEditId, "parent-edit");
    assert.equal(result.artifactEditBaseRawStream, baseRaw);
    assert.deepEqual(
      (result.artifactEdits as Record<string, unknown>[]).map((edit) => edit.id),
      ["parent-edit", "unrelated-edit"]
    );
    assert.equal((result.artifactEdits as Record<string, unknown>[])[0], parent);
    assert.equal((result.artifactEdits as Record<string, unknown>[])[1], unrelated);
  });

  it("treats an absent parentId as an explicit base-version parent", () => {
    const preceding = completeEdit("preceding-edit", parentRaw);
    const message = assistant([preceding, pendingChatEdit()]);

    const result = finalizeGeneratedArtifactBatchPatch({
      assistantMessage: message,
      patch: terminalPatch({ rawStream: "", content: CHAT_RUN_CANCELLED_MESSAGE }),
      status: "complete",
      error: CHAT_RUN_CANCELLED_MESSAGE
    });

    assert.equal(result.activeArtifactEditId, undefined);
    assert.equal(result.rawStream, baseRaw);
  });

  it("restores a text-only base and explicitly clears the last edit and base", () => {
    const textOnlyRaw = "<chat>Text-only baseline</chat>";
    const message = assistant([pendingChatEdit()], {
      content: "Text-only baseline",
      rawStream: textOnlyRaw,
      hasStreamUi: false,
      streamUiComplete: false,
      artifactEditBaseRawStream: textOnlyRaw
    });

    const result = finalizeGeneratedArtifactBatchPatch({
      assistantMessage: message,
      patch: terminalPatch({ rawStream: "", content: CHAT_RUN_CANCELLED_MESSAGE }),
      status: "complete",
      error: CHAT_RUN_CANCELLED_MESSAGE
    });

    assert.equal(result.content, "Text-only baseline");
    assert.equal(result.rawStream, textOnlyRaw);
    assert.equal(result.hasStreamUi, false);
    assert.equal(result.streamUiComplete, false);
    assert.ok(Object.prototype.hasOwnProperty.call(result, "artifactEdits"));
    assert.equal(result.artifactEdits, undefined);
    assert.ok(
      Object.prototype.hasOwnProperty.call(result, "artifactEditBaseRawStream")
    );
    assert.equal(result.artifactEditBaseRawStream, undefined);
    assert.ok(Object.prototype.hasOwnProperty.call(result, "activeArtifactEditId"));
    assert.equal(result.activeArtifactEditId, undefined);
  });

  it("leaves streaming, non-chat, non-pending, and invalid-token edits alone", () => {
    const cases: Array<{
      message: SessionMessageInput;
      status: "streaming" | "complete";
    }> = [
      {
        message: assistant([pendingChatEdit()]),
        status: "streaming"
      },
      {
        message: assistant([pendingChatEdit({ origin: "source-edit" })]),
        status: "complete"
      },
      {
        message: assistant([pendingChatEdit({ status: "complete" })]),
        status: "complete"
      },
      {
        message: assistant([
          pendingChatEdit({
            variants: [
              {
                id: "generated-variant",
                createdAt: 20,
                status: "pending"
              }
            ]
          })
        ]),
        status: "complete"
      }
    ];

    for (const entry of cases) {
      const patch = terminalPatch();
      const result = finalizeGeneratedArtifactBatchPatch({
        assistantMessage: entry.message,
        patch,
        status: entry.status
      });
      assert.equal(result, patch);
    }
  });

  it("does not mutate the assistant message or terminal patch", () => {
    const message = assistant([
      completeEdit("parent-edit", parentRaw),
      pendingChatEdit({ parentId: "parent-edit" })
    ]);
    const patch = terminalPatch({ status: "error", error: "Failed" });
    const originalMessage = structuredClone(message);
    const originalPatch = structuredClone(patch);

    finalizeGeneratedArtifactBatchPatch({
      assistantMessage: message,
      patch,
      status: "error",
      error: "Failed"
    });

    assert.deepEqual(message, originalMessage);
    assert.deepEqual(patch, originalPatch);
  });
});

describe("assistant presentation projection", () => {
  it("projects bare text without inventing StreamUI state", () => {
    assert.deepEqual(buildAssistantPresentationPatch(" Plain response "), {
      content: "Plain response",
      rawStream: " Plain response ",
      hasStreamUi: false,
      streamUiComplete: false
    });
  });
});
