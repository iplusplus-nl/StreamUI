import assert from "node:assert/strict";
import test from "node:test";
import {
  createStoredFileId,
  deleteStoredFile,
  putStoredFile
} from "../../server/fileStore.js";
import {
  buildSessionFilesContext,
  createSessionFileToolStats,
  listFilesToolOutput,
  normalizeSessionFiles,
  readFileToolResult,
  readFileToolOutput
} from "../../server/sessionFileTools.js";

test("normalizes session files and drops invalid entries", () => {
  const files = normalizeSessionFiles([
    {
      id: "image-1",
      kind: "image",
      name: "photo.png",
      mimeType: "image/png",
      size: 12,
      createdAt: 1,
      dataUrl: "data:image/png;base64,aaaa"
    },
    {
      id: "draft-image",
      kind: "image",
      name: "draft.png",
      mimeType: "image/png",
      size: 12,
      createdAt: 2,
      dataUrl: "data:image/png;base64,bbbb",
      draft: true
    },
    {
      id: "empty-image",
      kind: "image",
      name: "broken.png"
    }
  ]);

  assert.equal(files.length, 1);
  assert.equal(files[0].id, "image-1");
});

test("listFiles returns metadata without file content", () => {
  const stats = createSessionFileToolStats();
  const output = listFilesToolOutput(
    [
      {
        id: "artifact-1",
        kind: "artifact",
        name: "artifact.html",
        mimeType: "text/html",
        size: 20,
        createdAt: 1,
        text: "<section>Hello</section>",
        summary: "Hello"
      }
    ],
    stats
  );

  assert.equal(stats.lists, 1);
  assert.match(output, /artifact-1/);
  assert.doesNotMatch(output, /<section>Hello<\/section>/);
});

test("readFile returns raw artifact text", async () => {
  const output = await readFileToolOutput(
    [
      {
        id: "artifact-1",
        kind: "artifact",
        name: "artifact.html",
        mimeType: "text/html",
        size: 20,
        createdAt: 1,
        text: "<section>Hello</section>"
      }
    ],
    { id: "artifact-1" }
  );

  assert.equal(typeof output, "string");
  assert.match(output as string, /<section>Hello<\/section>/);
});

test("readFile returns image metadata and separate multimodal follow-up content", async () => {
  const result = await readFileToolResult(
    [
      {
        id: "image-1",
        kind: "image",
        name: "photo.png",
        mimeType: "image/png",
        size: 12,
        createdAt: 1,
        dataUrl: "data:image/png;base64,aaaa"
      }
    ],
    { id: "image-1" }
  );

  assert.equal(typeof result.output, "string");
  assert.match(result.output as string, /follow_up_multimodal_message/);
  assert.deepEqual(result.followUpContent, [
    {
      type: "input_text",
      text: `Image content returned by readFile for session file image-1. Treat this image as the bytes for that session file. Metadata:\n${JSON.stringify(
        {
          file: {
            id: "image-1",
            kind: "image",
            name: "photo.png",
            mimeType: "image/png",
            size: 12,
            createdAt: 1
          }
        },
        null,
        2
      )}`
    },
    {
      type: "input_image",
      image_url: "data:image/png;base64,aaaa"
    }
  ]);
});

test("readFile omits image follow-up content when image input is unavailable", async () => {
  const result = await readFileToolResult(
    [
      {
        id: "image-1",
        kind: "image",
        name: "photo.png",
        mimeType: "image/png",
        size: 12,
        createdAt: 1,
        dataUrl: "data:image/png;base64,aaaa"
      }
    ],
    { id: "image-1" },
    undefined,
    { allowImageInput: false }
  );

  assert.equal(typeof result.output, "string");
  assert.match(result.output as string, /metadata_only/);
  assert.equal(result.followUpContent, undefined);
});

test("readFile prefers storage bytes over stale inline image data", async () => {
  const fileId = createStoredFileId("image");
  const imageDataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  const stored = await putStoredFile(fileId, {
    kind: "image",
    sessionId: "session-test",
    name: "stored.png",
    mimeType: "image/png",
    dataUrl: imageDataUrl
  });

  try {
    const result = await readFileToolResult(
      [
        {
          id: fileId,
          kind: "image",
          name: "stored.png",
          mimeType: stored.mimeType,
          size: stored.size,
          createdAt: 1,
          storageKey: stored.storageKey,
          contentHash: stored.contentHash,
          dataUrl: "data:image/png;base64,this-is-stale-and-invalid"
        }
      ],
      { id: fileId }
    );

    assert.equal(result.followUpContent?.[1]?.type, "input_image");
    assert.equal(
      result.followUpContent?.[1]?.type === "input_image"
        ? result.followUpContent[1].image_url
        : "",
      imageDataUrl
    );
  } finally {
    await deleteStoredFile(stored.storageKey);
  }
});

test("readFile loads storage-backed artifact content", async () => {
  const fileId = createStoredFileId("artifact");
  const stored = await putStoredFile(fileId, {
    kind: "artifact",
    sessionId: "session-test",
    name: "stored.html",
    mimeType: "text/html",
    text: "<section>Stored artifact</section>"
  });

  try {
    const output = await readFileToolOutput(
      [
        {
          id: fileId,
          kind: "artifact",
          name: "stored.html",
          mimeType: stored.mimeType,
          size: stored.size,
          createdAt: 1,
          storageKey: stored.storageKey,
          contentHash: stored.contentHash,
          embedUrl: "http://127.0.0.1:8787/api/files/example/content?token=t"
        }
      ],
      { id: fileId }
    );

    assert.equal(typeof output, "string");
    assert.match(output as string, /Stored artifact/);
    assert.match(output as string, /embedUrl/);
  } finally {
    await deleteStoredFile(stored.storageKey);
  }
});

test("buildSessionFilesContext points the model to file tools", () => {
  const context = buildSessionFilesContext([
    {
      id: "image-1",
      kind: "image",
      name: "photo.png",
      mimeType: "image/png",
      size: 12,
      createdAt: 1,
      dataUrl: "data:image/png;base64,aaaa"
    }
  ]);

  assert.match(context, /listFiles/);
  assert.match(context, /readFile/);
  assert.match(context, /\[image-1\] image photo\.png/);
});
