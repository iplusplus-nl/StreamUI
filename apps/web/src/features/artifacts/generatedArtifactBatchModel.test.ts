import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ArtifactEdit,
  ClientMessage,
  SessionState
} from "../../domain/chat/sessionModel";
import {
  interruptStaleArtifactEditsInSessionState,
  normalizeStoredMessage
} from "../../domain/chat/sessionModel";
import {
  applyPendingGeneratedArtifactBatch,
  finalizePersistedGeneratedArtifactBatch,
  finalizePersistedGeneratedArtifactBatches,
  prepareGeneratedArtifactBatch,
  reduceGeneratedArtifactBatchPatch,
  restoreGeneratedArtifactBatchOperation
} from "./generatedArtifactBatchModel";
import { getActiveArtifactEditChain } from "./artifactEditModel";
import { prepareArtifactEditRegeneration } from "./artifactEditOperationModel";
import {
  completeEdit,
  editedRaw,
  originalRaw,
  regeneratedRaw
} from "./artifactEditOperationTestFixtures";

function originalAssistant(
  overrides: Partial<ClientMessage> = {}
): ClientMessage {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "Original",
    reasoning: "Original reasoning",
    sessionTitle: "Original title",
    rawStream: originalRaw,
    hasStreamUi: true,
    streamUiComplete: true,
    status: "complete",
    repairOfMessageId: "repair-root",
    repairAttempt: 2,
    ...overrides
  };
}

function operationFor(
  message: ClientMessage,
  suffix = "a"
) {
  const operation = prepareGeneratedArtifactBatch(message, {
    sessionId: "session-1",
    assistantId: message.id,
    sourceUserMessageId: "user-1",
    prompt: "  Regenerate this artifact  ",
    runId: `run-${suffix}`,
    operationId: `operation-${suffix}`,
    editId: `edit-${suffix}`,
    variantId: `variant-${suffix}`,
    createdAt: suffix === "a" ? 10 : 20
  });
  assert.ok(operation);
  return operation;
}

function pendingMessage(message: ClientMessage, suffix = "a") {
  const operation = operationFor(message, suffix);
  const pending = applyPendingGeneratedArtifactBatch(
    message,
    operation,
    "night"
  );
  assert.notEqual(pending, message);
  return {
    operation,
    message: {
      ...pending,
      generationRunId: operation.runId,
      content: "",
      rawStream: "",
      reasoning: "Thinking",
      status: "streaming" as const
    }
  };
}

describe("generated artifact batch model", () => {
  it("prepares a tokenized hidden edit without mutating the source", () => {
    const current = originalAssistant();
    const before = structuredClone(current);
    const operation = operationFor(current);

    assert.deepEqual(current, before);
    assert.equal(operation.prompt, "Regenerate this artifact");
    assert.equal(operation.runId, "run-a");
    assert.equal(operation.pendingEdit.origin, "chat-run");
    assert.equal(operation.pendingEdit.promptBubble, false);
    assert.equal(
      operation.pendingEdit.variants[0].operationId,
      "operation-a"
    );
    assert.equal(operation.pendingEdit.variants[0].createdAt, 10);
    assert.deepEqual(operation.pendingEdit.rollback, {
      reasoning: "Original reasoning",
      sessionTitle: "Original title",
      repairOfMessageId: "repair-root",
      repairAttempt: 2
    });
  });

  it("rejects invalid targets, blank sources, and concurrent pending edits", () => {
    const base = originalAssistant();
    const input = {
      sessionId: "session-1",
      assistantId: base.id,
      sourceUserMessageId: "user-1",
      prompt: "Regenerate",
      runId: "run",
      operationId: "operation",
      editId: "edit",
      variantId: "variant",
      createdAt: 1
    };
    assert.equal(
      prepareGeneratedArtifactBatch(
        { id: "user-1", role: "user", content: "hello" },
        input
      ),
      undefined
    );
    assert.equal(
      prepareGeneratedArtifactBatch(base, { ...input, assistantId: "other" }),
      undefined
    );
    assert.equal(
      prepareGeneratedArtifactBatch(base, { ...input, prompt: " " }),
      undefined
    );
    assert.equal(
      prepareGeneratedArtifactBatch(
        originalAssistant({ rawStream: "" }),
        input
      ),
      undefined
    );

    const pending = pendingMessage(base).message;
    assert.equal(prepareGeneratedArtifactBatch(pending, input), undefined);
  });

  it("applies matching stream patches while preserving operation metadata", () => {
    const { message, operation } = pendingMessage(originalAssistant());
    const editBefore = message.artifactEdits?.[0];
    const streamed = reduceGeneratedArtifactBatchPatch(
      message,
      operation,
      {
        rawStream: "<streamui><main>Partial",
        content: "Partial",
        generationRunId: "foreign"
      },
      "streaming",
      "night"
    );

    assert.equal(streamed.rawStream, "<streamui><main>Partial");
    assert.equal(streamed.content, "Partial");
    assert.equal(streamed.generationRunId, operation.runId);
    assert.equal(streamed.artifactEdits?.[0], editBefore);
    assert.equal(streamed.activeArtifactEditId, operation.editId);
  });

  it("completes a matching batch and clears stale visual fields for text-only output", () => {
    const staleSnapshot = {
      raw: "<main>partial</main>",
      completedHtml: "<main>partial</main>",
      iframeDocument: "partial",
      errors: [],
      status: "streaming" as const
    };
    const { message, operation } = pendingMessage(
      originalAssistant({ snapshot: staleSnapshot })
    );
    const completed = reduceGeneratedArtifactBatchPatch(
      { ...message, snapshot: staleSnapshot },
      operation,
      { rawStream: "<chat>Text only result</chat>", status: "complete" },
      "complete",
      "day"
    );

    assert.equal(completed.content, "Text only result");
    assert.equal(completed.rawStream, "<chat>Text only result</chat>");
    assert.equal(completed.snapshot, undefined);
    assert.equal(completed.artifactContext, undefined);
    assert.equal(completed.runtimeErrors, undefined);
    assert.equal(completed.artifactEdits?.[0].status, "complete");
    assert.equal(
      completed.artifactEdits?.[0].variants[0].rawStream,
      "<chat>Text only result</chat>"
    );
  });

  it("turns an empty live completion into a rollback error", () => {
    const { message, operation } = pendingMessage(originalAssistant());
    const failed = reduceGeneratedArtifactBatchPatch(
      message,
      operation,
      { rawStream: "", status: "complete" },
      "complete",
      "night"
    );

    assert.equal(failed.status, "error");
    assert.equal(
      failed.error,
      "The artifact regeneration completed without output."
    );
    assert.equal(failed.rawStream, originalRaw);
    assert.equal(failed.artifactEdits?.[0].status, "error");
    assert.equal(failed.activeArtifactEditId, undefined);
  });

  it("restores the parent presentation and metadata on error", () => {
    const { message, operation } = pendingMessage(originalAssistant());
    const failed = reduceGeneratedArtifactBatchPatch(
      {
        ...message,
        rawStream: "<streamui><main>Broken",
        reasoning: "Partial new reasoning",
        repairOfMessageId: "new-repair",
        repairAttempt: 3
      },
      operation,
      {
        rawStream: "<streamui><main>Broken",
        error: "Provider failed",
        status: "error"
      },
      "error",
      "night"
    );

    assert.equal(failed.rawStream, originalRaw);
    assert.equal(failed.content, "Original");
    assert.equal(failed.snapshot?.raw, "<main>Original artifact</main>");
    assert.equal(failed.reasoning, "Original reasoning");
    assert.equal(failed.repairOfMessageId, "repair-root");
    assert.equal(failed.repairAttempt, 2);
    assert.equal(failed.status, "error");
    assert.equal(failed.error, "Provider failed");
    assert.equal(failed.artifactEdits?.[0].status, "error");
    assert.equal(failed.activeArtifactEditId, undefined);

    const retry = operationFor(failed, "b");
    assert.equal(retry.source, originalRaw);
    assert.equal(retry.previousActiveEditId, undefined);
  });

  it("fully rolls back cancellation and makes all late callbacks no-ops", () => {
    const { message, operation } = pendingMessage(originalAssistant());
    const cancelled = reduceGeneratedArtifactBatchPatch(
      {
        ...message,
        rawStream: "<streamui><main>Partial",
        reasoning: "Partial reasoning"
      },
      operation,
      { status: "complete" },
      "cancelled",
      "night"
    );

    assert.equal(cancelled.rawStream, originalRaw);
    assert.equal(cancelled.content, "Original");
    assert.equal(cancelled.reasoning, "Original reasoning");
    assert.equal(cancelled.artifactEditBaseRawStream, undefined);
    assert.equal(cancelled.artifactEdits, undefined);
    assert.equal(cancelled.activeArtifactEditId, undefined);
    assert.equal(cancelled.status, "complete");
    assert.equal(cancelled.error, undefined);
    assert.equal(
      reduceGeneratedArtifactBatchPatch(
        cancelled,
        operation,
        { rawStream: regeneratedRaw, status: "complete" },
        "complete",
        "night"
      ),
      cancelled
    );
    assert.equal(
      reduceGeneratedArtifactBatchPatch(
        cancelled,
        operation,
        { rawStream: "late" },
        "streaming",
        "night"
      ),
      cancelled
    );
  });

  it("keeps an existing parent edit and restores it when a child is cancelled", () => {
    const parent = completeEdit("parent", editedRaw);
    const current = originalAssistant({
      content: "Edited",
      rawStream: editedRaw,
      artifactEditBaseRawStream: originalRaw,
      artifactEdits: [parent],
      activeArtifactEditId: parent.id
    });
    const { message, operation } = pendingMessage(current);
    const cancelled = reduceGeneratedArtifactBatchPatch(
      message,
      operation,
      {},
      "cancelled",
      "night"
    );

    assert.equal(cancelled.rawStream, editedRaw);
    assert.deepEqual(
      cancelled.artifactEdits?.map((edit) => edit.id),
      [parent.id]
    );
    assert.equal(cancelled.artifactEditBaseRawStream, originalRaw);
    assert.equal(cancelled.activeArtifactEditId, parent.id);
  });

  it("restores the explicit base selection after rehydration when history exists", () => {
    const historyEdit = completeEdit("history", editedRaw);
    const current = originalAssistant({
      artifactEditBaseRawStream: originalRaw,
      artifactEdits: [historyEdit],
      activeArtifactEditId: undefined,
      rawStream: originalRaw,
      content: "Original"
    });
    const pending = pendingMessage(current);
    assert.equal(pending.operation.previousActiveEditId, undefined);
    assert.equal(pending.operation.pendingEdit.parentId, undefined);

    const restored = restoreGeneratedArtifactBatchOperation(
      "session-1",
      structuredClone(pending.message)
    );
    assert.ok(restored);
    assert.equal(restored.previousActiveEditId, undefined);
    const cancelled = reduceGeneratedArtifactBatchPatch(
      pending.message,
      restored,
      {},
      "cancelled",
      "night"
    );
    assert.equal(cancelled.rawStream, originalRaw);
    assert.equal(cancelled.activeArtifactEditId, undefined);
    assert.deepEqual(
      cancelled.artifactEdits?.map((edit) => edit.id),
      [historyEdit.id]
    );

    const completed = reduceGeneratedArtifactBatchPatch(
      pending.message,
      pending.operation,
      { rawStream: regeneratedRaw, status: "complete" },
      "complete",
      "night"
    );
    assert.deepEqual(
      getActiveArtifactEditChain(completed).map((edit) => edit.id),
      [pending.operation.editId]
    );
    const regeneration = prepareArtifactEditRegeneration(
      completed,
      pending.operation.editId,
      undefined,
      {
        createEditId: () => "retry-edit",
        createVariantId: () => "retry-variant",
        createOperationId: () => "retry-operation",
        now: () => 30
      }
    );
    assert.equal(regeneration.status, "ready");
    if (regeneration.status === "ready") {
      assert.equal(regeneration.operation.source, originalRaw);
      assert.equal(regeneration.operation.pendingEdit.parentId, undefined);
    }
  });

  it("uses run and operation tokens to isolate cancel-A/start-B races", () => {
    const first = pendingMessage(originalAssistant(), "a");
    const cancelledA = reduceGeneratedArtifactBatchPatch(
      first.message,
      first.operation,
      {},
      "cancelled",
      "night"
    );
    const second = pendingMessage(cancelledA, "b");

    assert.equal(
      reduceGeneratedArtifactBatchPatch(
        second.message,
        first.operation,
        { rawStream: regeneratedRaw, status: "complete" },
        "complete",
        "night"
      ),
      second.message
    );

    const tokenTampered = structuredClone(second.message);
    const activeVariant = tokenTampered.artifactEdits?.at(-1)?.variants[0];
    assert.ok(activeVariant);
    activeVariant.operationId = "old-operation";
    assert.equal(
      reduceGeneratedArtifactBatchPatch(
        tokenTampered,
        second.operation,
        { rawStream: regeneratedRaw },
        "complete",
        "night"
      ),
      tokenTampered
    );
  });

  it("rehydrates a pending operation and applies server terminal metadata", () => {
    const { message, operation } = pendingMessage(originalAssistant());
    const restored = restoreGeneratedArtifactBatchOperation(
      "session-1",
      structuredClone(message)
    );
    assert.ok(restored);
    assert.equal(restored.runId, operation.runId);
    assert.equal(restored.operationId, operation.operationId);
    assert.equal(restored.source, originalRaw);

    const serverEdit = structuredClone(restored.pendingEdit);
    serverEdit.status = "complete";
    serverEdit.variants[0].status = "complete";
    serverEdit.variants[0].rawStream = regeneratedRaw;
    const completed = reduceGeneratedArtifactBatchPatch(
      message,
      restored,
      {
        rawStream: regeneratedRaw,
        artifactEdits: [serverEdit],
        activeArtifactEditId: serverEdit.id,
        status: "complete"
      },
      "complete",
      "night"
    );
    assert.equal(completed.rawStream, regeneratedRaw);
    assert.equal(completed.artifactEdits?.[0].status, "complete");

    const cancelledByServer = reduceGeneratedArtifactBatchPatch(
      message,
      restored,
      {
        rawStream: originalRaw,
        artifactEdits: undefined,
        activeArtifactEditId: undefined,
        status: "complete"
      },
      "complete",
      "night"
    );
    assert.equal(cancelledByServer.artifactEdits, undefined);
    assert.equal(cancelledByServer.rawStream, originalRaw);
  });

  it("rejects server artifact metadata with a mismatched operation token", () => {
    const { message, operation } = pendingMessage(originalAssistant());
    const wrongOperation = structuredClone(operation.pendingEdit);
    wrongOperation.status = "complete";
    wrongOperation.variants[0] = {
      ...wrongOperation.variants[0],
      operationId: "old-operation",
      status: "complete",
      rawStream: regeneratedRaw
    };
    assert.equal(
      reduceGeneratedArtifactBatchPatch(
        message,
        operation,
        {
          rawStream: regeneratedRaw,
          artifactEdits: [wrongOperation],
          status: "complete"
        },
        "complete",
        "night"
      ),
      message
    );

    const wrongCreatedAt = structuredClone(wrongOperation);
    wrongCreatedAt.variants[0].operationId = operation.operationId;
    wrongCreatedAt.variants[0].createdAt += 1;
    assert.equal(
      reduceGeneratedArtifactBatchPatch(
        message,
        operation,
        {
          rawStream: regeneratedRaw,
          artifactEdits: [wrongCreatedAt],
          status: "complete"
        },
        "complete",
        "night"
      ),
      message
    );
  });

  it("preserves chat-run origin, rollback metadata, and operation tokens through storage normalization", () => {
    const { message } = pendingMessage(originalAssistant());
    const normalized = normalizeStoredMessage(structuredClone(message), {
      rebuildSnapshots: false
    });
    assert.ok(normalized);
    const edit = normalized.artifactEdits?.[0];
    assert.equal(edit?.origin, "chat-run");
    assert.equal(edit?.variants[0].operationId, "operation-a");
    assert.equal(edit?.variants[0].createdAt, 10);
    assert.deepEqual(edit?.rollback, {
      reasoning: "Original reasoning",
      sessionTitle: "Original title",
      repairOfMessageId: "repair-root",
      repairAttempt: 2
    });

    const invalidOrigin = normalizeStoredMessage(
      {
        ...message,
        artifactEdits: message.artifactEdits?.map((candidate) => ({
          ...candidate,
          origin: "foreign"
        }))
      },
      {
        rebuildSnapshots: false,
        interruptPendingArtifactEdits: true
      }
    );
    assert.equal(invalidOrigin?.artifactEdits?.[0].origin, undefined);
  });

  it("migrates legacy generated batches without misclassifying idle local edits", () => {
    const { message } = pendingMessage(originalAssistant());
    const legacyEdit = structuredClone(message.artifactEdits![0]);
    delete legacyEdit.origin;
    delete legacyEdit.rollback;
    delete legacyEdit.variants[0].operationId;

    const legacyTerminal = normalizeStoredMessage(
      {
        ...message,
        content: "Regenerated",
        rawStream: regeneratedRaw,
        status: "complete",
        artifactEdits: [legacyEdit]
      },
      {
        rebuildSnapshots: false,
        interruptPendingArtifactEdits: true
      }
    );
    assert.ok(legacyTerminal);
    assert.equal(legacyTerminal.artifactEdits?.[0].origin, "chat-run");
    assert.match(
      legacyTerminal.artifactEdits?.[0].variants[0].operationId ?? "",
      /^legacy-chat-run:/
    );
    assert.equal(
      finalizePersistedGeneratedArtifactBatch(
        "session-1",
        legacyTerminal,
        "night"
      ).artifactEdits?.[0].status,
      "complete"
    );

    const idleLocal = normalizeStoredMessage(
      {
        ...message,
        content: "Original",
        rawStream: originalRaw,
        status: "complete",
        artifactEdits: [legacyEdit]
      },
      {
        rebuildSnapshots: false,
        interruptPendingArtifactEdits: true
      }
    );
    assert.equal(idleLocal?.artifactEdits?.[0].origin, undefined);

    const history = completeEdit("history", editedRaw);
    const legacyBaseCancel = normalizeStoredMessage(
      {
        ...message,
        content: "Generation stopped.",
        rawStream: "",
        artifactEditBaseRawStream: originalRaw,
        artifactEdits: [history, legacyEdit],
        activeArtifactEditId: legacyEdit.id,
        status: "complete"
      },
      {
        rebuildSnapshots: false,
        interruptPendingArtifactEdits: true
      }
    );
    assert.ok(legacyBaseCancel);
    const cancelled = finalizePersistedGeneratedArtifactBatch(
      "session-1",
      legacyBaseCancel,
      "night"
    );
    assert.equal(cancelled.rawStream, originalRaw);
    assert.equal(cancelled.activeArtifactEditId, undefined);
    assert.deepEqual(
      cancelled.artifactEdits?.map((edit) => edit.id),
      [history.id]
    );

    const legacyError = normalizeStoredMessage(
      {
        ...message,
        content: "Partial failure",
        rawStream: "<streamui><main>Partial",
        status: "error",
        error: "Provider failed",
        artifactEdits: [legacyEdit]
      },
      {
        rebuildSnapshots: false,
        interruptPendingArtifactEdits: true
      }
    );
    assert.equal(legacyError?.artifactEdits?.[0].origin, "chat-run");
    const failed = finalizePersistedGeneratedArtifactBatch(
      "session-1",
      legacyError!,
      "night"
    );
    assert.equal(failed.status, "error");
    assert.equal(failed.error, "Provider failed");
    assert.equal(failed.rawStream, originalRaw);
    assert.equal(failed.activeArtifactEditId, undefined);
  });

  it("keeps old chat-run metadata resumable or terminally finalizable", () => {
    const { message } = pendingMessage(originalAssistant());
    const resumable = normalizeStoredMessage(
      { ...message, status: "streaming", generationRunId: "run-a" },
      {
        rebuildSnapshots: false,
        interruptPendingArtifactEdits: true
      }
    );
    assert.equal(resumable?.artifactEdits?.[0].status, "pending");
    assert.equal(resumable?.artifactEdits?.[0].variants[0].status, "pending");

    const abandoned = normalizeStoredMessage(
      { ...message, status: "complete", generationRunId: "run-a" },
      {
        rebuildSnapshots: false,
        interruptPendingArtifactEdits: true
      }
    );
    assert.equal(abandoned?.artifactEdits?.[0].status, "pending");
    assert.equal(abandoned?.artifactEdits?.[0].variants[0].status, "pending");
    const finalizedAbandoned = finalizePersistedGeneratedArtifactBatch(
      "session-1",
      abandoned!,
      "night"
    );
    assert.equal(finalizedAbandoned.artifactEdits?.[0].status, "error");
    assert.equal(finalizedAbandoned.rawStream, originalRaw);

    const activeState: SessionState = {
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          title: "Active",
          createdAt: 1,
          updatedAt: 1,
          messages: [resumable!],
          files: []
        }
      ]
    };
    assert.equal(
      interruptStaleArtifactEditsInSessionState(
        activeState,
        Date.now() + 60 * 60 * 1000
      ),
      activeState
    );
  });

  it("finalizes legacy persisted terminal messages and preserves exact no-ops", () => {
    const { message } = pendingMessage(originalAssistant());
    const completed = finalizePersistedGeneratedArtifactBatch(
      "session-1",
      { ...message, rawStream: regeneratedRaw, status: "complete" },
      "night"
    );
    assert.equal(completed.artifactEdits?.[0].status, "complete");
    assert.equal(completed.rawStream, regeneratedRaw);

    const cancelled = finalizePersistedGeneratedArtifactBatch(
      "session-1",
      { ...message, content: "Generation stopped.", status: "complete" },
      "night"
    );
    assert.equal(cancelled.artifactEdits, undefined);
    assert.equal(cancelled.rawStream, originalRaw);

    const empty = finalizePersistedGeneratedArtifactBatch(
      "session-1",
      { ...message, content: "", rawStream: "", status: "complete" },
      "night"
    );
    assert.equal(empty.rawStream, originalRaw);
    assert.equal(empty.status, "error");
    assert.equal(
      empty.error,
      "The artifact regeneration completed without output."
    );
    assert.equal(empty.artifactEdits?.[0].status, "error");
    assert.equal(empty.activeArtifactEditId, undefined);

    const stable = originalAssistant();
    assert.equal(
      finalizePersistedGeneratedArtifactBatch("session-1", stable, "night"),
      stable
    );
  });

  it("finalizes only matching state entries and can skip locally cancelling runs", () => {
    const pending = pendingMessage(originalAssistant()).message;
    const duplicate = originalAssistant({ id: pending.id });
    const state: SessionState = {
      activeSessionId: "session-1",
      sessions: [
        {
          id: "session-1",
          title: "One",
          createdAt: 1,
          updatedAt: 1,
          messages: [{ ...pending, status: "complete", rawStream: regeneratedRaw }],
          files: []
        },
        {
          id: "session-2",
          title: "Two",
          createdAt: 2,
          updatedAt: 2,
          messages: [duplicate],
          files: []
        }
      ]
    };

    const skipped = finalizePersistedGeneratedArtifactBatches(
      state,
      "night",
      50,
      new Set(["run-a"])
    );
    assert.equal(skipped, state);

    const finalized = finalizePersistedGeneratedArtifactBatches(
      state,
      "night",
      50
    );
    const one = finalized.sessions.find((session) => session.id === "session-1");
    const two = finalized.sessions.find((session) => session.id === "session-2");
    assert.equal(one?.messages[0].artifactEdits?.[0].status, "complete");
    assert.equal(one?.updatedAt, 50);
    assert.equal(two, state.sessions[1]);
  });
});
