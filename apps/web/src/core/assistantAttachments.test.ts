import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  CompleteAttachment,
  PendingAttachment
} from "@assistant-ui/react";
import type {
  ImageAttachment,
  UploadedSessionFile
} from "./imageAttachments";
import {
  completeAttachmentToImage,
  imageAttachmentToCompleteAttachment,
  StreamImageAttachmentAdapter,
  type StreamAttachmentMetadata
} from "./assistantAttachments";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function sourceFile(
  overrides: Partial<Pick<File, "name" | "type" | "size">> = {}
): File {
  return {
    name: "diagram.png",
    type: "image/png",
    size: 16,
    ...overrides
  } as File;
}

function image(overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id: "image-prepared",
    name: "diagram.png",
    mimeType: "image/png",
    size: 16,
    dataUrl: "data:image/png;base64,AAAA",
    width: 640,
    height: 480,
    ...overrides
  };
}

function uploaded(
  overrides: Partial<UploadedSessionFile> = {}
): UploadedSessionFile {
  return {
    id: "file-uploaded",
    kind: "image",
    name: "stored.png",
    mimeType: "image/png",
    size: 12,
    createdAt: 10,
    draft: true,
    width: 320,
    height: 240,
    ...overrides
  };
}

function pendingAttachment(
  overrides: Partial<PendingAttachment & StreamAttachmentMetadata> = {}
): PendingAttachment {
  return {
    id: "pending-direct",
    type: "image",
    name: "diagram.png",
    contentType: "image/png",
    file: sourceFile(),
    status: { type: "running", reason: "uploading", progress: 0 },
    ...overrides
  } as PendingAttachment;
}

describe("assistant image attachments", () => {
  it("round-trips the owner session through complete attachment metadata", () => {
    const complete = imageAttachmentToCompleteAttachment(
      image({ ownerSessionId: "session-owner" })
    );
    const metadata = complete as CompleteAttachment & StreamAttachmentMetadata;

    assert.equal(metadata.streamuiSessionId, "session-owner");
    assert.equal(metadata.streamuiImage?.ownerSessionId, "session-owner");
    assert.equal(
      completeAttachmentToImage(complete)?.ownerSessionId,
      "session-owner"
    );

    const topLevelOwner = {
      ...imageAttachmentToCompleteAttachment(image()),
      streamuiSessionId: "top-level-owner"
    } as CompleteAttachment & StreamAttachmentMetadata;
    assert.equal(
      completeAttachmentToImage(topLevelOwner)?.ownerSessionId,
      "top-level-owner"
    );
  });

  it("locks add, upload, send, and delete to the session captured at add start", async () => {
    let activeSessionId = "session-a";
    const prepared = deferred<ImageAttachment>();
    const prepareStarted = deferred<void>();
    const uploads: Array<[string, string]> = [];
    const deletes: Array<[string, string]> = [];
    const events: string[] = [];
    const adapter = new StreamImageAttachmentAdapter({
      getSessionId: () => activeSessionId,
      createPendingId: () => "pending-1",
      prepareImage: () => {
        prepareStarted.resolve();
        return prepared.promise;
      },
      uploadImage: async (sessionId, attachment) => {
        uploads.push([sessionId, attachment.id]);
        return uploaded();
      },
      deleteFile: async (sessionId, fileId) => {
        deletes.push([sessionId, fileId]);
      },
      onUploadStart: (id, sessionId) =>
        events.push(`start:${id}:${sessionId}`),
      onUploadComplete: (id) => events.push(`complete:${id}`),
      onUploadError: (id) => events.push(`error:${id}`),
      onSend: (id) => events.push(`send:${id}`),
      onRemoveStart: (id) => events.push(`remove-start:${id}`),
      onRemoveComplete: (id) => events.push(`remove-complete:${id}`)
    });

    const iterator = adapter.add({ file: sourceFile() });
    const first = await iterator.next();
    assert.equal(first.done, false);
    assert.equal(first.value?.id, "pending-1");
    assert.equal(
      (first.value as PendingAttachment & StreamAttachmentMetadata)
        .streamuiSessionId,
      "session-a"
    );

    activeSessionId = "session-b";
    const secondPromise = iterator.next();
    await prepareStarted.promise;
    activeSessionId = "session-c";
    prepared.resolve(image());
    const second = await secondPromise;
    assert.equal(second.done, false);
    assert.deepEqual(uploads, [["session-a", "image-prepared"]]);
    assert.equal(
      (second.value as PendingAttachment & StreamAttachmentMetadata)
        .streamuiSessionId,
      "session-a"
    );

    const complete = await adapter.send(second.value as PendingAttachment);
    assert.equal(complete.id, "file-uploaded");
    assert.equal(
      (complete as CompleteAttachment & StreamAttachmentMetadata)
        .streamuiSessionId,
      "session-a"
    );
    assert.equal(
      completeAttachmentToImage(complete)?.ownerSessionId,
      "session-a"
    );

    activeSessionId = "session-d";
    await adapter.remove(complete);
    assert.deepEqual(deletes, [["session-a", "file-uploaded"]]);
    assert.deepEqual(events, [
      "start:pending-1:session-a",
      "complete:pending-1",
      "send:pending-1",
      "remove-start:file-uploaded",
      "remove-complete:file-uploaded"
    ]);
  });

  it("captures the owner once for the direct send fallback", async () => {
    let activeSessionId = "session-a";
    const prepared = deferred<ImageAttachment>();
    const prepareStarted = deferred<void>();
    const uploads: string[] = [];
    const adapter = new StreamImageAttachmentAdapter({
      getSessionId: () => activeSessionId,
      prepareImage: () => {
        prepareStarted.resolve();
        return prepared.promise;
      },
      uploadImage: async (sessionId) => {
        uploads.push(sessionId);
        return uploaded();
      }
    });

    const sending = adapter.send(pendingAttachment());
    await prepareStarted.promise;
    activeSessionId = "session-b";
    prepared.resolve(image());
    const complete = await sending;

    assert.deepEqual(uploads, ["session-a"]);
    assert.equal(
      completeAttachmentToImage(complete)?.ownerSessionId,
      "session-a"
    );
  });

  it("marks an add failure and does not emit a completed attachment", async () => {
    const events: string[] = [];
    const adapter = new StreamImageAttachmentAdapter({
      getSessionId: () => "session-a",
      createPendingId: () => "pending-failure",
      prepareImage: async () => image(),
      uploadImage: async () => {
        throw new Error("upload failed");
      },
      onUploadStart: (id) => events.push(`start:${id}`),
      onUploadComplete: (id) => events.push(`complete:${id}`),
      onUploadError: (id) => events.push(`error:${id}`)
    });

    const iterator = adapter.add({ file: sourceFile() });
    assert.equal((await iterator.next()).done, false);
    await assert.rejects(iterator.next(), /upload failed/);
    assert.deepEqual(events, [
      "start:pending-failure",
      "error:pending-failure"
    ]);
  });

  it("cancels an in-flight add, deletes a late upload, and emits no ghost attachment", async () => {
    const upload = deferred<UploadedSessionFile>();
    const uploadStarted = deferred<void>();
    const deletes: Array<[string, string]> = [];
    const events: string[] = [];
    const adapter = new StreamImageAttachmentAdapter({
      getSessionId: () => "session-owner",
      createPendingId: () => "pending-cancelled",
      prepareImage: async () => image(),
      uploadImage: async () => {
        uploadStarted.resolve();
        return upload.promise;
      },
      deleteFile: async (sessionId, fileId) => {
        deletes.push([sessionId, fileId]);
      },
      onUploadStart: (id) => events.push(`upload-start:${id}`),
      onUploadComplete: (id) => events.push(`upload-complete:${id}`),
      onUploadError: (id) => events.push(`upload-error:${id}`),
      onRemoveStart: (id) => events.push(`remove-start:${id}`),
      onRemoveComplete: (id) => events.push(`remove-complete:${id}`)
    });

    const iterator = adapter.add({ file: sourceFile() });
    const running = await iterator.next();
    assert.equal(running.done, false);
    const finalYield = iterator.next();
    await uploadStarted.promise;

    const removing = adapter.remove(running.value as PendingAttachment);
    await Promise.resolve();
    assert.deepEqual(events, [
      "upload-start:pending-cancelled",
      "remove-start:pending-cancelled"
    ]);

    upload.resolve(uploaded({ id: "late-file" }));
    assert.deepEqual(await finalYield, { value: undefined, done: true });
    await removing;

    assert.deepEqual(deletes, [["session-owner", "late-file"]]);
    assert.deepEqual(events, [
      "upload-start:pending-cancelled",
      "remove-start:pending-cancelled",
      "remove-complete:pending-cancelled"
    ]);
  });

  it("suppresses a late upload error after the pending attachment was removed", async () => {
    const upload = deferred<UploadedSessionFile>();
    const uploadStarted = deferred<void>();
    const events: string[] = [];
    const adapter = new StreamImageAttachmentAdapter({
      getSessionId: () => "session-owner",
      createPendingId: () => "pending-cancelled-error",
      prepareImage: async () => image(),
      uploadImage: async () => {
        uploadStarted.resolve();
        return upload.promise;
      },
      onUploadStart: (id) => events.push(`upload-start:${id}`),
      onUploadError: (id) => events.push(`upload-error:${id}`),
      onRemoveStart: (id) => events.push(`remove-start:${id}`),
      onRemoveComplete: (id) => events.push(`remove-complete:${id}`)
    });

    const iterator = adapter.add({ file: sourceFile() });
    const running = await iterator.next();
    const finalYield = iterator.next();
    await uploadStarted.promise;
    const removing = adapter.remove(running.value as PendingAttachment);

    upload.reject(new Error("late upload failure"));
    assert.deepEqual(await finalYield, { value: undefined, done: true });
    await removing;
    assert.deepEqual(events, [
      "upload-start:pending-cancelled-error",
      "remove-start:pending-cancelled-error",
      "remove-complete:pending-cancelled-error"
    ]);
  });

  it("rejects invalid files before creating a gate record", async () => {
    let starts = 0;
    let prepares = 0;
    const adapter = new StreamImageAttachmentAdapter({
      getSessionId: () => "session-a",
      prepareImage: async () => {
        prepares += 1;
        return image();
      },
      uploadImage: async () => uploaded(),
      onUploadStart: () => {
        starts += 1;
      }
    });

    const iterator = adapter.add({
      file: sourceFile({ type: "text/plain" })
    });
    await assert.rejects(iterator.next(), /not a supported image type/);
    assert.equal(starts, 0);
    assert.equal(prepares, 0);
  });

  it("keeps removal active until the draft delete request settles", async () => {
    const deletion = deferred<void>();
    const deleteStarted = deferred<void>();
    const deletes: Array<[string, string]> = [];
    const events: string[] = [];
    const adapter = new StreamImageAttachmentAdapter({
      getSessionId: () => "current-session",
      prepareImage: async () => image(),
      uploadImage: async () => uploaded(),
      deleteFile: async (sessionId, fileId) => {
        deletes.push([sessionId, fileId]);
        deleteStarted.resolve();
        return deletion.promise;
      },
      onRemoveStart: (id) => events.push(`start:${id}`),
      onRemoveComplete: (id) => events.push(`complete:${id}`)
    });
    const pending = pendingAttachment({
      id: "pending-ready",
      status: { type: "requires-action", reason: "composer-send" },
      streamuiFile: uploaded(),
      streamuiSessionId: "owner-session"
    });

    const removing = adapter.remove(pending);
    await deleteStarted.promise;
    assert.deepEqual(events, ["start:pending-ready"]);
    assert.deepEqual(deletes, [["owner-session", "file-uploaded"]]);

    deletion.resolve();
    await removing;
    assert.deepEqual(events, [
      "start:pending-ready",
      "complete:pending-ready"
    ]);
  });

  it("removes the gate even when draft deletion fails and reports the error", async () => {
    const events: string[] = [];
    const warnings: Array<[string, unknown]> = [];
    const adapter = new StreamImageAttachmentAdapter({
      getSessionId: () => "current-session",
      prepareImage: async () => image(),
      uploadImage: async () => uploaded(),
      deleteFile: async () => {
        throw new Error("delete failed");
      },
      onRemoveStart: (id) => events.push(`start:${id}`),
      onRemoveComplete: (id) => events.push(`complete:${id}`),
      warn: (message, error) => warnings.push([message, error])
    });
    const complete = imageAttachmentToCompleteAttachment(
      image({
        sessionFile: uploaded(),
        ownerSessionId: "owner-session"
      })
    );

    await adapter.remove(complete);

    assert.deepEqual(events, [
      "start:image-prepared",
      "complete:image-prepared"
    ]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], "Could not delete draft image upload.");
    assert.match(String(warnings[0][1]), /delete failed/);
  });
});
