import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ArtifactEdit, ClientMessage } from "../../domain/chat/sessionModel";
import {
  applyPendingArtifactEditOperation,
  cancelArtifactEditOperation,
  completeArtifactEditOperation,
  failArtifactEditOperation,
  prepareArtifactSourceEdit,
  selectArtifactEditVersion
} from "./artifactEditOperationModel";
import {
  assistant,
  completeEdit,
  editedRaw,
  originalRaw,
  reference,
  regeneratedRaw
} from "./artifactEditOperationTestFixtures";

describe("artifact edit version selection", () => {
  it("rebuilds original and completed edit projections", () => {
    const original = selectArtifactEditVersion(assistant(), undefined, "day");
    assert.equal(original.selected, true);
    assert.equal(original.message.rawStream, originalRaw);
    assert.equal(original.message.content, "Original");
    assert.equal(original.message.activeArtifactEditId, undefined);
    assert.equal(original.message.snapshot?.raw, "<main>Original artifact</main>");
    assert.match(original.message.snapshot?.iframeDocument ?? "", /data-page-theme="day"/);

    const edited = selectArtifactEditVersion(
      original.message,
      "edit-1",
      "night"
    );
    assert.equal(edited.selected, true);
    assert.equal(edited.message.rawStream, editedRaw);
    assert.equal(edited.message.content, "Edited");
    assert.equal(edited.message.activeArtifactEditId, "edit-1");
    assert.match(edited.message.snapshot?.iframeDocument ?? "", /data-page-theme="night"/);
  });

  it("shows a failed edit's parent source while retaining its retry identity", () => {
    const parent = completeEdit("parent", editedRaw);
    const failed: ArtifactEdit = {
      id: "failed",
      parentId: parent.id,
      createdAt: 2,
      prompt: "Broken edit",
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
    const result = selectArtifactEditVersion(
      assistant({ artifactEdits: [parent, failed] }),
      failed.id,
      "night"
    );

    assert.equal(result.selected, true);
    assert.equal(result.message.rawStream, editedRaw);
    assert.equal(result.message.activeArtifactEditId, failed.id);
  });

  it("does not select missing, pending, or user versions", () => {
    const current = assistant();
    const missing = selectArtifactEditVersion(current, "missing", "night");
    assert.equal(missing.selected, false);
    assert.equal(missing.message, current);

    const pendingEdit: ArtifactEdit = {
      id: "pending",
      createdAt: 2,
      prompt: "Pending edit",
      references: [],
      activeVariantId: "pending-variant",
      variants: [
        {
          id: "pending-variant",
          createdAt: 2,
          status: "pending"
        }
      ],
      status: "pending"
    };
    const pendingMessage = assistant({ artifactEdits: [pendingEdit] });
    const pending = selectArtifactEditVersion(
      pendingMessage,
      pendingEdit.id,
      "night"
    );
    assert.equal(pending.selected, false);
    assert.equal(pending.message, pendingMessage);

    const user: ClientMessage = {
      id: "user-1",
      role: "user",
      content: "hello"
    };
    const userResult = selectArtifactEditVersion(user, undefined, "night");
    assert.equal(userResult.selected, false);
    assert.equal(userResult.message, user);
  });

  it("clears stale artifact projection fields for a text-only version", () => {
    const current = assistant({
      artifactEditBaseRawStream: "<chat>Text-only original</chat>",
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
        textSummary: "stale",
        sourceChars: 5,
        styleSummary: "stale",
        structureSummary: "stale",
        editableSummary: "stale"
      }
    });
    const result = selectArtifactEditVersion(current, undefined, "night");

    assert.equal(result.selected, true);
    assert.equal(result.message.content, "Text-only original");
    assert.equal(result.message.hasStreamUi, false);
    assert.equal(result.message.snapshot, undefined);
    assert.equal(result.message.artifactContext, undefined);
  });
});

describe("artifact source edit operations", () => {
  it("creates, completes, fails, and cancels a first source edit immutably", () => {
    const current = assistant({
      content: "Original",
      rawStream: originalRaw,
      artifactEditBaseRawStream: undefined,
      artifactEdits: undefined,
      activeArtifactEditId: undefined
    });
    const before = structuredClone(current);
    const operation = prepareArtifactSourceEdit(current, {
      prompt: "  Make the hero larger  ",
      references: [reference],
      editId: "source-edit",
      variantId: "source-variant",
      operationId: "source-operation",
      createdAt: 10
    });
    assert.ok(operation);
    assert.deepEqual(current, before);
    assert.equal(operation.kind, "source");
    assert.equal(operation.source, originalRaw);
    assert.equal(operation.previousActiveEditId, undefined);
    assert.equal(operation.prompt, "Make the hero larger");
    assert.equal(operation.pendingEdit.parentId, undefined);
    assert.equal(operation.pendingEdit.references, operation.references);

    const pending = applyPendingArtifactEditOperation(
      current,
      operation,
      "night"
    );
    assert.equal(pending.rawStream, originalRaw);
    assert.equal(pending.artifactEditBaseRawStream, originalRaw);
    assert.equal(pending.artifactEdits?.length, 1);
    assert.equal(pending.artifactEdits?.[0].status, "pending");
    assert.equal(pending.activeArtifactEditId, operation.editId);
    assert.deepEqual(current, before);

    const completed = completeArtifactEditOperation(
      pending,
      operation,
      {
        rawStream: editedRaw,
        summary: "Made the hero larger",
        editCount: 2
      },
      "day"
    );
    assert.equal(completed.rawStream, editedRaw);
    assert.equal(completed.content, "Edited");
    assert.equal(completed.activeArtifactEditId, operation.editId);
    assert.equal(completed.artifactEdits?.[0].status, "complete");
    assert.equal(
      completed.artifactEdits?.[0].variants[0].summary,
      "Made the hero larger"
    );
    assert.equal(completed.artifactEdits?.[0].variants[0].editCount, 2);

    const failed = failArtifactEditOperation(pending, operation, "Edit failed");
    assert.equal(failed.rawStream, originalRaw);
    assert.equal(failed.artifactEdits?.[0].status, "error");
    assert.equal(failed.artifactEdits?.[0].variants[0].error, "Edit failed");

    const cancelled = cancelArtifactEditOperation(
      pending,
      operation,
      "night"
    );
    assert.equal(cancelled.rawStream, originalRaw);
    assert.equal(cancelled.artifactEditBaseRawStream, undefined);
    assert.equal(cancelled.artifactEdits, undefined);
    assert.equal(cancelled.activeArtifactEditId, undefined);
  });

  it("chains a source edit from the active completed version", () => {
    const current = assistant();
    const operation = prepareArtifactSourceEdit(current, {
      prompt: "Change the footer",
      references: [reference],
      editId: "child-edit",
      variantId: "child-variant",
      operationId: "child-operation",
      createdAt: 20
    });
    assert.ok(operation);
    assert.equal(operation.source, editedRaw);
    assert.equal(operation.baseRawStream, originalRaw);
    assert.equal(operation.previousActiveEditId, "edit-1");
    assert.equal(operation.pendingEdit.parentId, "edit-1");

    const latestWithoutBase = {
      ...current,
      artifactEditBaseRawStream: undefined
    };
    const pending = applyPendingArtifactEditOperation(
      latestWithoutBase,
      operation,
      "night"
    );
    assert.equal(pending.artifactEditBaseRawStream, originalRaw);
    assert.deepEqual(
      pending.artifactEdits?.map((edit) => edit.id),
      ["edit-1", "child-edit"]
    );
    const completed = completeArtifactEditOperation(
      pending,
      operation,
      { rawStream: regeneratedRaw },
      "night"
    );
    assert.equal(completed.artifactEditBaseRawStream, originalRaw);
  });

  it("rejects user, blank prompt, and missing source inputs", () => {
    const input = {
      prompt: "Edit",
      references: [reference],
      editId: "edit",
      variantId: "variant",
      operationId: "operation",
      createdAt: 1
    };
    assert.equal(
      prepareArtifactSourceEdit(
        { id: "user", role: "user", content: "hello" },
        input
      ),
      undefined
    );
    assert.equal(
      prepareArtifactSourceEdit(assistant(), { ...input, prompt: " " }),
      undefined
    );
    assert.equal(
      prepareArtifactSourceEdit(
        assistant({
          rawStream: "",
          artifactEditBaseRawStream: undefined,
          artifactEdits: undefined,
          activeArtifactEditId: undefined
        }),
        input
      ),
      undefined
    );
  });

  it("ignores late terminal results after cancel or another completion", () => {
    const current = assistant({
      rawStream: originalRaw,
      artifactEditBaseRawStream: undefined,
      artifactEdits: undefined,
      activeArtifactEditId: undefined
    });
    const operation = prepareArtifactSourceEdit(current, {
      prompt: "Edit",
      references: [],
      editId: "late-edit",
      variantId: "late-variant",
      operationId: "late-operation",
      createdAt: 1
    });
    assert.ok(operation);
    const pending = applyPendingArtifactEditOperation(
      current,
      operation,
      "night"
    );

    const cancelled = cancelArtifactEditOperation(
      pending,
      operation,
      "night"
    );
    assert.equal(
      completeArtifactEditOperation(
        cancelled,
        operation,
        { rawStream: editedRaw },
        "night"
      ),
      cancelled
    );
    assert.equal(
      failArtifactEditOperation(cancelled, operation, "late failure"),
      cancelled
    );

    const completed = completeArtifactEditOperation(
      pending,
      operation,
      { rawStream: editedRaw },
      "night"
    );
    assert.equal(
      cancelArtifactEditOperation(completed, operation, "night"),
      completed
    );
    assert.equal(
      failArtifactEditOperation(completed, operation, "late failure"),
      completed
    );
  });
});
