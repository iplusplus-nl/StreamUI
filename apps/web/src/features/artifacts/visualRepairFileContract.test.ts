import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeEphemeralFileIds,
  selectDurableSessionFiles,
  selectEphemeralSessionFileIdentities
} from "../../../server/sessionFileUploadSafety.js";
import { normalizeSessionFiles } from "../../../server/sessionFileTools.js";
import type { ImageAttachment } from "../../core/imageAttachments";
import { commitUploadedImageFile } from "../sessions/sessionFileModel";
import { createEphemeralVisualRepairFile } from "./visualRepairFile";

describe("visual repair ephemeral file transport contract", () => {
  it("keeps the screenshot request-local while exposing a non-draft run view", () => {
    const captured: ImageAttachment = {
      id: "local-render",
      name: "assistant-1-render.png",
      mimeType: "image/png",
      size: 12,
      dataUrl: "data:image/png;base64,AAAA",
      ownerSessionId: "session-1"
    };
    const attachment: ImageAttachment = {
      ...captured,
      sessionFile: createEphemeralVisualRepairFile(
        captured,
        "assistant-1",
        10
      )
    };

    const requestFile = commitUploadedImageFile(attachment, "synthetic-user");
    assert.ok(requestFile);
    assert.equal("draft" in requestFile, false);
    assert.equal(attachment.sessionFile?.draft, true);
    assert.equal(attachment.sessionFile?.storageKey, undefined);
    assert.equal(attachment.sessionFile?.dataUrl, captured.dataUrl);

    const normalizedRunFiles = normalizeSessionFiles([requestFile]);
    const ephemeralIds = normalizeEphemeralFileIds([requestFile.id]);
    assert.equal(normalizedRunFiles.length, 1);
    assert.equal(normalizedRunFiles[0].id, "local-render");
    assert.deepEqual(
      selectDurableSessionFiles(normalizedRunFiles, ephemeralIds),
      []
    );
    assert.deepEqual(
      selectEphemeralSessionFileIdentities(normalizedRunFiles, ephemeralIds),
      []
    );
  });

  it("does not let arbitrary draft files bypass the server normalizer", () => {
    assert.deepEqual(
      normalizeSessionFiles([
        {
          id: "uncommitted-draft",
          kind: "image",
          name: "draft.png",
          mimeType: "image/png",
          size: 12,
          createdAt: 10,
          storageKey: "session-1/uncommitted-draft/blob.png",
          draft: true
        }
      ]),
      []
    );
  });
});
