import assert from "node:assert/strict";
import test from "node:test";
import {
  createArtifactSharePageHtml,
  createOrUpdateArtifactShareRecord,
  getArtifactSharePath,
  getArtifactSharePublicUrl,
  reuseArtifactShareRecord
} from "../../server/artifactShares.js";

test("artifact share page embeds the document safely", () => {
  const html = createArtifactSharePageHtml({
    id: "share-example-123456",
    title: "Demo <Artifact>",
    createdAt: "2026-07-06T00:00:00.000Z",
    themeMode: "night",
    document: "<!doctype html><script>window.__ok = true;</script>",
    sourceMessageId: "message-1"
  });

  assert.match(html, /ChatHTML/);
  assert.match(html, /Demo &lt;Artifact&gt;/);
  assert.doesNotMatch(html, /<script>window\.__ok = true;<\/script>/);
  assert.doesNotMatch(html, /\|\| """"/);
  assert.match(html, /JSON\.parse\(documentPayload\.textContent \|\| '""'\)/);
  assert.match(html, /\\u003cscript>window\.__ok = true;\\u003c\/script>/);
  assert.match(html, /sandbox="allow-scripts allow-forms/);
  assert.doesNotMatch(html, /allow-same-origin/);
  assert.match(html, /data\.source === "streamui-runtime"/);
  assert.match(html, /data\.kind === "resize"/);
  assert.doesNotMatch(html, /contentDocument/);
});

test("artifact share public URLs use the stable artifact path", () => {
  assert.equal(
    getArtifactSharePath("share-example-123456"),
    "/artifacts/share-example-123456"
  );
  assert.equal(
    getArtifactSharePublicUrl("share-example-123456", "https://chathtml.test/"),
    "https://chathtml.test/artifacts/share-example-123456"
  );
});

test("artifact share records accept html as the public payload field", async () => {
  const { record } = await createOrUpdateArtifactShareRecord({
    html: "<!doctype html><p>Hello</p>",
    title: "HTML payload"
  });

  assert.equal(record.document, "<!doctype html><p>Hello</p>");
  assert.equal(record.title, "HTML payload");
});

test("artifact share reuse preserves the original link id", () => {
  const existing = {
    id: "share-existing-123456",
    title: "Old artifact",
    createdAt: "2026-07-06T00:00:00.000Z",
    themeMode: "night" as const,
    document: "<!doctype html>old",
    sourceMessageId: "message-1"
  };
  const next = {
    id: "share-new-123456",
    title: "Updated artifact",
    createdAt: "2026-07-06T00:01:00.000Z",
    themeMode: "day" as const,
    document: "<!doctype html>new",
    sourceMessageId: "message-1"
  };

  const reused = reuseArtifactShareRecord(next, existing);

  assert.equal(reused.id, existing.id);
  assert.equal(reused.createdAt, existing.createdAt);
  assert.equal(reused.updatedAt, next.createdAt);
  assert.equal(reused.title, next.title);
  assert.equal(reused.document, next.document);
  assert.equal(reused.themeMode, next.themeMode);
});
