import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ImageAttachment } from "../../core/imageAttachments";
import type { SessionFile } from "../../domain/chat/sessionModel";
import {
  getChatRunRequestFiles,
  getChatRunSessionFiles,
  getEphemeralChatRunFileIds,
  prepareChatRunAttachmentFiles
} from "./chatRunAttachmentFiles";

function storedAttachment(draft = true): ImageAttachment {
  return {
    id: "local-image",
    name: "render.png",
    mimeType: "image/png",
    size: 12,
    dataUrl: "data:image/png;base64,AAAA",
    ownerSessionId: "session-1",
    sessionFile: {
      id: "uploaded-image",
      kind: "image",
      name: "render.png",
      mimeType: "image/png",
      size: 12,
      createdAt: 10,
      storageKey: "session-1/uploaded-image/blob.png",
      draft
    }
  };
}

const existing: SessionFile[] = [
  {
    id: "existing",
    kind: "text",
    name: "notes.txt",
    mimeType: "text/plain",
    size: 5,
    createdAt: 1
  }
];

describe("chat run attachment file preparation", () => {
  it("keeps ephemeral files out of session state but includes them in the request", () => {
    const prepared = prepareChatRunAttachmentFiles(
      [storedAttachment()],
      "synthetic-user",
      true
    );

    assert.equal(prepared.allAttachmentsCommitted, true);
    assert.equal("draft" in prepared.uploadedFiles[0], false);
    assert.deepEqual(getChatRunSessionFiles(existing, prepared), existing);
    assert.deepEqual(
      getChatRunRequestFiles(existing, prepared).map((file) => file.id),
      ["existing", "uploaded-image"]
    );
    assert.deepEqual(getEphemeralChatRunFileIds(prepared), ["uploaded-image"]);
  });

  it("commits ordinary attachments to both state and request persistence", () => {
    const prepared = prepareChatRunAttachmentFiles(
      [storedAttachment()],
      "user-1",
      false
    );

    assert.deepEqual(
      getChatRunSessionFiles(existing, prepared).map((file) => file.id),
      ["existing", "uploaded-image"]
    );
    assert.deepEqual(
      getChatRunRequestFiles(existing, prepared).map((file) => file.id),
      ["existing", "uploaded-image"]
    );
    assert.equal(getEphemeralChatRunFileIds(prepared), undefined);
  });

  it("reports incomplete attachment uploads without inventing files", () => {
    const prepared = prepareChatRunAttachmentFiles(
      [{ ...storedAttachment(), sessionFile: undefined }],
      "user-1",
      false
    );

    assert.equal(prepared.allAttachmentsCommitted, false);
    assert.deepEqual(prepared.uploadedFiles, []);
  });
});
