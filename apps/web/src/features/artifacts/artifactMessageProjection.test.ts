import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ArtifactSelection } from "../../core/artifactSelection";
import {
  artifactSelectionToReference,
  buildArtifactActionMessage,
  buildCompletedAssistantPatchFromRawStream
} from "./artifactMessageProjection";

describe("artifact message projection", () => {
  it("copies only editable selection reference fields without mutation", () => {
    const selection: ArtifactSelection = {
      id: "selection-1",
      messageId: "assistant-1",
      createdAt: 10,
      kind: "element",
      key: "hero",
      selector: "#hero",
      label: "Hero",
      preview: "Welcome",
      tagName: "section",
      text: "Welcome",
      html: "<section>Welcome</section>"
    };
    const before = structuredClone(selection);

    assert.deepEqual(artifactSelectionToReference(selection), {
      kind: "element",
      key: "hero",
      selector: "#hero",
      label: "Hero",
      preview: "Welcome",
      tagName: "section",
      text: "Welcome",
      html: "<section>Welcome</section>"
    });
    assert.deepEqual(selection, before);
  });

  it("projects completed chat and visible StreamUI into a final snapshot", () => {
    const raw =
      "<chat>Here is the artifact.</chat><streamui><main><h1>Demo</h1></main></streamui>";
    const patch = buildCompletedAssistantPatchFromRawStream(raw, "day");

    assert.equal(patch.content, "Here is the artifact.");
    assert.equal(patch.rawStream, raw);
    assert.equal(patch.hasStreamUi, true);
    assert.equal(patch.streamUiComplete, true);
    assert.equal(patch.status, "complete");
    assert.equal(patch.runtimeErrors, undefined);
    assert.equal(patch.error, undefined);
    assert.equal(patch.snapshot?.status, "complete");
    assert.equal(patch.snapshot?.raw, "<main><h1>Demo</h1></main>");
    assert.match(
      patch.snapshot?.iframeDocument ?? "",
      /data-page-theme="day"/
    );
    assert.equal(
      patch.artifactContext?.sourceChars,
      "<main><h1>Demo</h1></main>".length
    );
  });

  it("uses chat or fallback text when no visible artifact exists", () => {
    const chatPatch = buildCompletedAssistantPatchFromRawStream(
      "<chat>Text only</chat>",
      "night"
    );
    const fallbackPatch = buildCompletedAssistantPatchFromRawStream(
      "Plain fallback",
      "night"
    );

    assert.equal(chatPatch.content, "Text only");
    assert.equal(chatPatch.hasStreamUi, false);
    assert.equal(chatPatch.snapshot, undefined);
    assert.equal(chatPatch.artifactContext, undefined);
    assert.equal(fallbackPatch.content, "Plain fallback");
  });

  it("projects and clears protocol session titles with the selected version", () => {
    const titled = buildCompletedAssistantPatchFromRawStream(
      "<sessiontitle>Revised title</sessiontitle><chat>Done</chat>",
      "night"
    );
    const untitled = buildCompletedAssistantPatchFromRawStream(
      "<chat>Done</chat>",
      "night"
    );

    assert.equal(titled.sessionTitle, "Revised title");
    assert.equal(untitled.sessionTitle, undefined);
  });

  it("clears stale snapshot and context when a projected version has no artifact", () => {
    const previous = {
      snapshot: { status: "complete" },
      artifactContext: { textSummary: "stale" }
    };
    const projected = {
      ...previous,
      ...buildCompletedAssistantPatchFromRawStream(
        "<chat>Text-only version</chat>",
        "night"
      )
    };

    assert.equal(projected.snapshot, undefined);
    assert.equal(projected.artifactContext, undefined);
  });

  it("keeps an incomplete StreamUI protocol marker in the final patch", () => {
    const patch = buildCompletedAssistantPatchFromRawStream(
      "<chat>Partial</chat><streamui><section>Loading",
      "night"
    );

    assert.equal(patch.hasStreamUi, true);
    assert.equal(patch.streamUiComplete, false);
    assert.equal(patch.snapshot?.status, "complete");
  });

  it("accepts only bounded prompt actions as chat messages", () => {
    assert.equal(
      buildArtifactActionMessage({ type: "prompt", prompt: "  repair this  " }),
      "repair this"
    );
    assert.equal(
      buildArtifactActionMessage({ type: "prompt", prompt: "x".repeat(2001) })
        .length,
      2000
    );
    assert.equal(
      buildArtifactActionMessage({ type: "copy", text: "copy me" }),
      ""
    );
    assert.equal(
      buildArtifactActionMessage({
        type: "download",
        text: "download",
        filename: "artifact.html"
      }),
      ""
    );
    assert.equal(
      buildArtifactActionMessage({ type: "open-url", url: "https://example.com" }),
      ""
    );
  });
});
