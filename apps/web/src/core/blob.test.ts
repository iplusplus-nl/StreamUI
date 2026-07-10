import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blobToDataUrl,
  type BlobDataUrlReader
} from "./blob";

function reader({
  result = null,
  error = null,
  event = "load"
}: {
  result?: BlobDataUrlReader["result"];
  error?: Error | null;
  event?: "load" | "error";
}): BlobDataUrlReader & { readBlob?: Blob } {
  const listeners: Partial<Record<"load" | "error", () => void>> = {};
  return {
    result,
    error,
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    readAsDataURL(blob) {
      this.readBlob = blob;
      listeners[event]?.();
    }
  };
}

describe("blob data URL conversion", () => {
  it("resolves the encoded reader result", async () => {
    const blob = new Blob(["image"]);
    const fakeReader = reader({ result: "data:image/png;base64,aW1hZ2U=" });

    assert.equal(
      await blobToDataUrl(blob, () => fakeReader),
      "data:image/png;base64,aW1hZ2U="
    );
    assert.equal(fakeReader.readBlob, blob);
  });

  it("rejects a successful read without a string result", async () => {
    await assert.rejects(
      blobToDataUrl(new Blob(), () => reader({ result: new ArrayBuffer(1) })),
      /Could not encode the rendered screenshot\./
    );
  });

  it("preserves reader errors and supplies a fallback", async () => {
    const failure = new Error("reader failed");
    await assert.rejects(
      blobToDataUrl(new Blob(), () =>
        reader({ event: "error", error: failure })
      ),
      failure
    );
    await assert.rejects(
      blobToDataUrl(new Blob(), () => reader({ event: "error" })),
      /Could not read the rendered screenshot\./
    );
  });
});
