import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ImageAttachment } from "../../core/imageAttachments";
import type { SessionFile } from "../../domain/chat/sessionModel";
import {
  createSessionAttachmentFileService,
  initialAttachmentGateState,
  reduceAttachmentGate,
  summarizeAttachmentGate,
  type AttachmentGateEvent,
  type AttachmentGateState
} from "./sessionAttachmentController";

function apply(
  events: AttachmentGateEvent[],
  initial: AttachmentGateState = initialAttachmentGateState
): AttachmentGateState {
  return events.reduce(reduceAttachmentGate, initial);
}

function image(): ImageAttachment {
  return {
    id: "image-1",
    name: "diagram.png",
    mimeType: "image/png",
    size: 16,
    dataUrl: "data:image/png;base64,AAAA",
    width: 640,
    height: 480
  };
}

function uploaded(kind: SessionFile["kind"] = "image"): SessionFile {
  return {
    id: "file-1",
    kind,
    name: "diagram.png",
    mimeType: "image/png",
    size: 12,
    createdAt: 10,
    draft: true
  } as SessionFile;
}

describe("session attachment gate", () => {
  it("tracks multiple uploads and derives blocking state", () => {
    const initial = initialAttachmentGateState;
    const state = apply([
      { type: "start", attachmentId: "a", sessionId: "session-1" },
      { type: "start", attachmentId: "b", sessionId: "session-1" },
      { type: "complete", attachmentId: "b" },
      { type: "fail", attachmentId: "a" }
    ]);

    assert.deepEqual(summarizeAttachmentGate(state), {
      inFlightCount: 0,
      removingCount: 0,
      failedAttachmentIds: ["a"],
      isSendBlocked: true,
      hasComposerDrafts: true
    });
    assert.equal(state.records.a?.status, "failed");
    assert.equal(state.records.b?.status, "ready");
    assert.deepEqual(initial, { records: {} });
  });

  it("makes duplicate starts and terminal callbacks idempotent", () => {
    const started = apply([
      { type: "start", attachmentId: "a", sessionId: "session-1" }
    ]);
    assert.equal(
      reduceAttachmentGate(started, {
        type: "start",
        attachmentId: "a",
        sessionId: "session-1"
      }),
      started
    );

    const completed = reduceAttachmentGate(started, {
      type: "complete",
      attachmentId: "a"
    });
    assert.equal(
      reduceAttachmentGate(completed, {
        type: "complete",
        attachmentId: "a"
      }),
      completed
    );
    assert.equal(
      reduceAttachmentGate(completed, {
        type: "fail",
        attachmentId: "a"
      }),
      completed
    );
  });

  it("ignores unknown and late callbacks without reviving removed records", () => {
    assert.equal(
      reduceAttachmentGate(initialAttachmentGateState, {
        type: "complete",
        attachmentId: "missing"
      }),
      initialAttachmentGateState
    );

    const started = apply([
      { type: "start", attachmentId: "a", sessionId: "session-1" }
    ]);
    const removing = reduceAttachmentGate(started, {
      type: "remove-start",
      attachmentId: "a"
    });
    assert.deepEqual(summarizeAttachmentGate(removing), {
      inFlightCount: 0,
      removingCount: 1,
      failedAttachmentIds: [],
      isSendBlocked: true,
      hasComposerDrafts: true
    });
    const removed = reduceAttachmentGate(removing, {
      type: "remove-complete",
      attachmentId: "a"
    });
    assert.deepEqual(removed, { records: {} });
    assert.equal(
      reduceAttachmentGate(removed, {
        type: "fail",
        attachmentId: "a"
      }),
      removed
    );
    assert.equal(
      reduceAttachmentGate(removed, {
        type: "complete",
        attachmentId: "a"
      }),
      removed
    );
  });

  it("clears failures on retry and consumes ready attachments", () => {
    const failed = apply([
      { type: "start", attachmentId: "a", sessionId: "session-1" },
      { type: "fail", attachmentId: "a" }
    ]);
    const retried = reduceAttachmentGate(failed, {
      type: "start",
      attachmentId: "a",
      sessionId: "session-2"
    });
    assert.deepEqual(retried.records.a, {
      sessionId: "session-2",
      status: "uploading"
    });

    const ready = reduceAttachmentGate(retried, {
      type: "complete",
      attachmentId: "a"
    });
    const consumed = reduceAttachmentGate(ready, {
      type: "consume",
      attachmentId: "a"
    });
    assert.deepEqual(summarizeAttachmentGate(consumed), {
      inFlightCount: 0,
      removingCount: 0,
      failedAttachmentIds: [],
      isSendBlocked: false,
      hasComposerDrafts: false
    });
  });
});

describe("session attachment file service", () => {
  it("uploads a draft image with the latest client id", async () => {
    let clientId = "client-a";
    const calls: unknown[][] = [];
    const service = createSessionAttachmentFileService(
      () => clientId,
      {
        uploadFile: async (...args) => {
          calls.push(args);
          return uploaded();
        }
      }
    );

    clientId = "client-b";
    const result = await service.uploadImage("session-1", image());

    assert.equal(result.id, "file-1");
    assert.deepEqual(calls, [
      [
        "session-1",
        {
          kind: "image",
          name: "diagram.png",
          mimeType: "image/png",
          sourceMessageId: undefined,
          dataUrl: "data:image/png;base64,AAAA",
          width: 640,
          height: 480,
          summary: "Uploaded image diagram.png",
          draft: true
        },
        "client-b"
      ]
    ]);
  });

  it("rejects a non-image response and forwards deletes", async () => {
    const deletes: string[][] = [];
    const service = createSessionAttachmentFileService(
      () => "client-1",
      {
        uploadFile: async () => uploaded("text"),
        deleteFile: async (...args) => {
          deletes.push(args);
        }
      }
    );

    await assert.rejects(
      service.uploadImage("session-1", image()),
      /non-image file/
    );
    await service.deleteFile("session-owner", "file-1");
    assert.deepEqual(deletes, [["session-owner", "file-1", "client-1"]]);
  });
});
