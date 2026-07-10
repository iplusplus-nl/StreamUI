import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ImageAttachment } from "../../core/imageAttachments";
import type { RenderSnapshot } from "../../runtime/streamui/types";
import {
  commitUploadedImageFile,
  createArtifactFileUpload,
  imageAttachmentToFileUpload
} from "./sessionFileModel";

function image(overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id: "image-1",
    name: "diagram.png",
    mimeType: "image/png",
    size: 12,
    dataUrl: "data:image/png;base64,AAAA",
    width: 640,
    height: 480,
    ...overrides
  };
}

function snapshot(overrides: Partial<RenderSnapshot> = {}): RenderSnapshot {
  return {
    raw: "snapshot raw",
    completedHtml: "<main>snapshot html</main>",
    iframeDocument: "<html></html>",
    errors: [],
    status: "complete",
    ...overrides
  };
}

describe("session file model", () => {
  it("maps image attachments to draft upload inputs", () => {
    assert.deepEqual(
      imageAttachmentToFileUpload(image(), "message-1", true),
      {
        kind: "image",
        name: "diagram.png",
        mimeType: "image/png",
        sourceMessageId: "message-1",
        dataUrl: "data:image/png;base64,AAAA",
        width: 640,
        height: 480,
        summary: "Uploaded image diagram.png",
        draft: true
      }
    );
  });

  it("chooses artifact source in raw, snapshot raw, then completed order", () => {
    assert.equal(
      createArtifactFileUpload("assistant-1", "direct raw", snapshot(), "Summary")
        ?.text,
      "direct raw"
    );
    assert.equal(
      createArtifactFileUpload("assistant-1", "", snapshot(), undefined)?.text,
      "snapshot raw"
    );
    assert.equal(
      createArtifactFileUpload(
        "assistant-1",
        "",
        snapshot({ raw: "" }),
        undefined
      )?.text,
      "<main>snapshot html</main>"
    );
  });

  it("builds artifact metadata and rejects blank sources", () => {
    assert.deepEqual(
      createArtifactFileUpload("assistant-1", "<streamui />", undefined, ""),
      {
        kind: "artifact",
        name: "assistant-1.chathtml.html",
        mimeType: "text/html",
        sourceMessageId: "assistant-1",
        text: "<streamui />",
        summary: "ChatHTML artifact raw source"
      }
    );
    assert.equal(
      createArtifactFileUpload(
        "assistant-1",
        "  ",
        snapshot({ raw: "snapshot fallback", completedHtml: "html fallback" }),
        undefined
      ),
      null
    );
  });

  it("commits uploaded image metadata and strips the draft marker", () => {
    const committed = commitUploadedImageFile(
      image({
        sessionFile: {
          id: "file-1",
          kind: "image",
          name: "stored.png",
          mimeType: "image/png",
          size: 10,
          createdAt: 2,
          draft: true
        }
      }),
      "user-1"
    );

    assert.deepEqual(committed, {
      id: "file-1",
      kind: "image",
      name: "stored.png",
      mimeType: "image/png",
      size: 10,
      createdAt: 2,
      sourceMessageId: "user-1",
      dataUrl: "data:image/png;base64,AAAA",
      width: 640,
      height: 480
    });
    assert.equal("draft" in (committed ?? {}), false);
  });

  it("keeps storage-backed files lean and prefers stored dimensions", () => {
    const committed = commitUploadedImageFile(
      image({
        sessionFile: {
          id: "file-1",
          kind: "image",
          name: "stored.png",
          mimeType: "image/png",
          size: 10,
          createdAt: 2,
          storageKey: "images/file-1",
          width: 320,
          height: 200
        }
      }),
      "user-1"
    );

    assert.equal(committed?.dataUrl, undefined);
    assert.equal(committed?.width, 320);
    assert.equal(committed?.height, 200);
    assert.equal(commitUploadedImageFile(image(), "user-1"), null);
  });
});
