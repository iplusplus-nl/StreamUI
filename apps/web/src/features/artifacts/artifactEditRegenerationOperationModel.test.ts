import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ArtifactEdit } from "../../domain/chat/sessionModel";
import {
  applyPendingArtifactEditOperation,
  cancelArtifactEditOperation,
  completeArtifactEditOperation,
  failArtifactEditOperation,
  prepareArtifactEditRegeneration
} from "./artifactEditOperationModel";
import {
  assistant,
  completeEdit,
  editedRaw,
  originalRaw,
  reference,
  regeneratedRaw
} from "./artifactEditOperationTestFixtures";

describe("artifact regeneration operations", () => {
  function factories() {
    return {
      createEditId: () => "regenerated-edit",
      createVariantId: () => "regenerated-variant",
      createOperationId: () => "regenerated-operation",
      now: () => 30
    };
  }

  it("creates a hidden sibling regeneration and restores the active version on cancel", () => {
    const current = assistant();
    const prepared = prepareArtifactEditRegeneration(
      current,
      "edit-1",
      undefined,
      factories()
    );
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") {
      return;
    }

    const operation = prepared.operation;
    assert.equal(operation.kind, "regeneration");
    assert.equal(operation.source, originalRaw);
    assert.equal(operation.previousActiveEditId, "edit-1");
    assert.equal(operation.pendingEdit.parentId, undefined);
    assert.equal(operation.pendingEdit.promptBubble, false);

    const pending = applyPendingArtifactEditOperation(current, operation, "night");
    assert.equal(pending.rawStream, originalRaw);
    assert.deepEqual(
      pending.artifactEdits?.map((edit) => edit.id),
      ["edit-1", "regenerated-edit"]
    );
    assert.equal(pending.activeArtifactEditId, "regenerated-edit");

    const cancelled = cancelArtifactEditOperation(
      pending,
      operation,
      "night"
    );
    assert.equal(cancelled.rawStream, editedRaw);
    assert.deepEqual(
      cancelled.artifactEdits?.map((edit) => edit.id),
      ["edit-1"]
    );
    assert.equal(cancelled.activeArtifactEditId, "edit-1");
  });

  it("creates a visible sibling when editing a completed prompt", () => {
    const prepared = prepareArtifactEditRegeneration(
      assistant(),
      "edit-1",
      "  Revised edit prompt  ",
      factories()
    );
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") {
      return;
    }
    assert.equal(prepared.operation.prompt, "Revised edit prompt");
    assert.equal(prepared.operation.pendingEdit.promptBubble, undefined);
  });

  it("retries a failed edit in place and restores the exact failed node on cancel", () => {
    const parent = completeEdit("parent", editedRaw);
    const failed: ArtifactEdit = {
      id: "failed",
      parentId: parent.id,
      createdAt: 2,
      prompt: "Try yellow",
      references: [reference],
      activeVariantId: "failed-variant",
      variants: [
        {
          id: "failed-variant",
          createdAt: 2,
          status: "error",
          rawStream: "stale",
          summary: "stale",
          error: "failed",
          editCount: 4
        }
      ],
      status: "error",
      error: "failed"
    };
    const current = assistant({
      rawStream: editedRaw,
      artifactEdits: [parent, failed],
      activeArtifactEditId: failed.id
    });
    const prepared = prepareArtifactEditRegeneration(
      current,
      failed.id,
      undefined,
      factories()
    );
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") {
      return;
    }

    const operation = prepared.operation;
    assert.equal(operation.editId, failed.id);
    assert.equal(operation.variantId, "failed-variant");
    assert.equal(operation.retryOriginalEdit, failed);
    const pending = applyPendingArtifactEditOperation(current, operation, "night");
    const pendingFailed = pending.artifactEdits?.find(
      (edit) => edit.id === failed.id
    );
    assert.equal(pendingFailed?.status, "pending");
    assert.equal(pendingFailed?.error, undefined);
    assert.deepEqual(pendingFailed?.variants[0], {
      id: "failed-variant",
      operationId: "regenerated-operation",
      createdAt: 30,
      status: "pending",
      rawStream: undefined,
      summary: undefined,
      error: undefined,
      editCount: undefined
    });

    const pendingWithLatestParent = {
      ...pending,
      artifactEdits: pending.artifactEdits?.map((item) =>
        item.id === parent.id
          ? {
              ...item,
              variants: item.variants.map((variant) => ({
                ...variant,
                rawStream: regeneratedRaw
              }))
            }
          : item
      )
    };
    const cancelled = cancelArtifactEditOperation(
      pendingWithLatestParent,
      operation,
      "night"
    );
    const restored = cancelled.artifactEdits?.find(
      (edit) => edit.id === failed.id
    );
    assert.equal(restored, failed);
    assert.equal(cancelled.rawStream, regeneratedRaw);
    assert.equal(cancelled.activeArtifactEditId, failed.id);
  });

  it("allocates a variant for an in-place retry that has no active variant", () => {
    const failed: ArtifactEdit = {
      id: "failed",
      createdAt: 2,
      prompt: "Retry",
      references: [],
      variants: [],
      status: "error",
      error: "failed"
    };
    let editIds = 0;
    let variantIds = 0;
    const prepared = prepareArtifactEditRegeneration(
      assistant({
        artifactEdits: [failed],
        activeArtifactEditId: failed.id,
        rawStream: originalRaw
      }),
      failed.id,
      undefined,
      {
        createEditId: () => {
          editIds += 1;
          return "unused-edit";
        },
        createVariantId: () => {
          variantIds += 1;
          return "new-variant";
        },
        createOperationId: () => "retry-operation",
        now: () => 40
      }
    );
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") {
      return;
    }
    assert.equal(prepared.operation.editId, failed.id);
    assert.equal(prepared.operation.variantId, "new-variant");
    assert.equal(editIds, 0);
    assert.equal(variantIds, 1);
  });

  it("completes and fails the exact regeneration variant", () => {
    const prepared = prepareArtifactEditRegeneration(
      assistant(),
      "edit-1",
      undefined,
      factories()
    );
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") {
      return;
    }
    const pending = applyPendingArtifactEditOperation(
      assistant(),
      prepared.operation,
      "night"
    );
    const completed = completeArtifactEditOperation(
      pending,
      prepared.operation,
      { rawStream: regeneratedRaw, summary: "Regenerated", editCount: 3 },
      "day"
    );
    const completedEdit = completed.artifactEdits?.find(
      (edit) => edit.id === prepared.operation.editId
    );
    assert.equal(completed.rawStream, regeneratedRaw);
    assert.equal(completedEdit?.status, "complete");
    assert.equal(completedEdit?.variants[0].summary, "Regenerated");

    const failed = failArtifactEditOperation(
      pending,
      prepared.operation,
      "Regeneration failed"
    );
    const failedEdit = failed.artifactEdits?.find(
      (edit) => edit.id === prepared.operation.editId
    );
    assert.equal(failed.rawStream, originalRaw);
    assert.equal(failedEdit?.status, "error");
    assert.equal(failedEdit?.variants[0].error, "Regeneration failed");
  });

  it("validates missing, pending, and blank operations before allocating ids", () => {
    let allocations = 0;
    const guardedFactories = {
      createEditId: () => {
        allocations += 1;
        return "edit";
      },
      createVariantId: () => {
        allocations += 1;
        return "variant";
      },
      createOperationId: () => {
        allocations += 1;
        return "operation";
      },
      now: () => {
        allocations += 1;
        return 1;
      }
    };
    assert.deepEqual(
      prepareArtifactEditRegeneration(
        assistant(),
        "missing",
        undefined,
        guardedFactories
      ),
      { status: "missing" }
    );
    const pendingEdit: ArtifactEdit = {
      id: "pending",
      createdAt: 2,
      prompt: "pending",
      references: [],
      activeVariantId: "pending-variant",
      variants: [
        { id: "pending-variant", createdAt: 2, status: "pending" }
      ],
      status: "pending"
    };
    assert.deepEqual(
      prepareArtifactEditRegeneration(
        assistant({ artifactEdits: [completeEdit("edit-1", editedRaw), pendingEdit] }),
        "edit-1",
        undefined,
        guardedFactories
      ),
      { status: "pending" }
    );
    assert.deepEqual(
      prepareArtifactEditRegeneration(
        assistant(),
        "edit-1",
        "  ",
        guardedFactories
      ),
      { status: "invalid" }
    );
    assert.equal(allocations, 0);
  });

  it("does not start a prepared regeneration after its target disappears", () => {
    const current = assistant();
    const prepared = prepareArtifactEditRegeneration(
      current,
      "edit-1",
      undefined,
      factories()
    );
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") {
      return;
    }
    const withoutTarget = assistant({
      artifactEdits: [],
      activeArtifactEditId: undefined,
      rawStream: originalRaw
    });

    assert.equal(
      applyPendingArtifactEditOperation(
        withoutTarget,
        prepared.operation,
        "night"
      ),
      withoutTarget
    );
  });

  it("does not let a late retry cancel roll back a server-completed retry", () => {
    const failed: ArtifactEdit = {
      id: "failed",
      createdAt: 2,
      prompt: "Retry",
      references: [],
      activeVariantId: "failed-variant",
      variants: [
        {
          id: "failed-variant",
          createdAt: 2,
          status: "error",
          error: "failed"
        }
      ],
      status: "error",
      error: "failed"
    };
    const current = assistant({
      artifactEdits: [failed],
      activeArtifactEditId: failed.id,
      rawStream: originalRaw
    });
    const prepared = prepareArtifactEditRegeneration(
      current,
      failed.id,
      undefined,
      factories()
    );
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") {
      return;
    }
    const pending = applyPendingArtifactEditOperation(
      current,
      prepared.operation,
      "night"
    );
    const serverCompleted = completeArtifactEditOperation(
      pending,
      prepared.operation,
      { rawStream: regeneratedRaw },
      "night"
    );

    assert.equal(
      cancelArtifactEditOperation(
        serverCompleted,
        prepared.operation,
        "night"
      ),
      serverCompleted
    );
    assert.equal(serverCompleted.rawStream, regeneratedRaw);
    assert.equal(serverCompleted.artifactEdits?.[0].status, "complete");
  });

  it("rejects stale terminals when another retry reuses the edit and variant ids", () => {
    const failed: ArtifactEdit = {
      id: "failed",
      createdAt: 2,
      prompt: "Retry",
      references: [],
      activeVariantId: "failed-variant",
      variants: [
        {
          id: "failed-variant",
          createdAt: 2,
          status: "error",
          error: "failed"
        }
      ],
      status: "error",
      error: "failed"
    };
    const current = assistant({
      artifactEdits: [failed],
      activeArtifactEditId: failed.id,
      rawStream: originalRaw
    });
    const first = prepareArtifactEditRegeneration(
      current,
      failed.id,
      undefined,
      {
        createEditId: () => "unused",
        createVariantId: () => "unused",
        createOperationId: () => "operation-a",
        now: () => 10
      }
    );
    assert.equal(first.status, "ready");
    if (first.status !== "ready") {
      return;
    }
    const pendingA = applyPendingArtifactEditOperation(
      current,
      first.operation,
      "night"
    );
    const restored = cancelArtifactEditOperation(
      pendingA,
      first.operation,
      "night"
    );
    const second = prepareArtifactEditRegeneration(
      restored,
      failed.id,
      undefined,
      {
        createEditId: () => "unused",
        createVariantId: () => "unused",
        createOperationId: () => "operation-b",
        now: () => 20
      }
    );
    assert.equal(second.status, "ready");
    if (second.status !== "ready") {
      return;
    }
    const pendingB = applyPendingArtifactEditOperation(
      restored,
      second.operation,
      "night"
    );
    assert.equal(first.operation.editId, second.operation.editId);
    assert.equal(first.operation.variantId, second.operation.variantId);

    assert.equal(
      completeArtifactEditOperation(
        pendingB,
        first.operation,
        { rawStream: editedRaw },
        "night"
      ),
      pendingB
    );
    assert.equal(
      failArtifactEditOperation(pendingB, first.operation, "stale"),
      pendingB
    );
    assert.equal(
      cancelArtifactEditOperation(pendingB, first.operation, "night"),
      pendingB
    );
  });

  it("restores the latest failed-version display when cancelling another regeneration", () => {
    const baseText = "<chat>Base text</chat>";
    const parentText = "<chat>Latest parent text</chat>";
    const parent = completeEdit("parent", parentText);
    const failed: ArtifactEdit = {
      id: "failed-child",
      parentId: parent.id,
      createdAt: 2,
      prompt: "Failed child",
      references: [],
      activeVariantId: "failed-child-variant",
      variants: [
        {
          id: "failed-child-variant",
          createdAt: 2,
          status: "error",
          error: "failed"
        }
      ],
      status: "error",
      error: "failed"
    };
    const current = assistant({
      content: "Latest parent text",
      rawStream: parentText,
      artifactEditBaseRawStream: baseText,
      artifactEdits: [parent, failed],
      activeArtifactEditId: failed.id,
      snapshot: {
        raw: "<main>stale</main>",
        completedHtml: "<main>stale</main>",
        iframeDocument: "stale",
        errors: [],
        status: "complete"
      },
      artifactContext: {
        id: "stale",
        sourceHash: "stale",
        sourceChars: 5,
        textSummary: "stale",
        styleSummary: "stale",
        structureSummary: "stale",
        editableSummary: "stale"
      }
    });
    const prepared = prepareArtifactEditRegeneration(
      current,
      parent.id,
      undefined,
      factories()
    );
    assert.equal(prepared.status, "ready");
    if (prepared.status !== "ready") {
      return;
    }
    const pending = applyPendingArtifactEditOperation(
      current,
      prepared.operation,
      "night"
    );
    assert.equal(pending.rawStream, baseText);

    const cancelled = cancelArtifactEditOperation(
      pending,
      prepared.operation,
      "night"
    );
    assert.equal(cancelled.rawStream, parentText);
    assert.equal(cancelled.content, "Latest parent text");
    assert.equal(cancelled.activeArtifactEditId, failed.id);
    assert.equal(cancelled.snapshot, undefined);
    assert.equal(cancelled.artifactContext, undefined);
  });
});
