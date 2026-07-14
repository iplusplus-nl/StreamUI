import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ArtifactSelection } from "../../core/artifactSelection";
import type { ImageAttachment } from "../../core/imageAttachments";
import {
  getArtifactEditSubmissionError,
  submitComposerMessage,
  type ComposerSubmissionPorts
} from "./composerSubmissionController";

const selection: ArtifactSelection = {
  id: "selection-1",
  messageId: "assistant-1",
  createdAt: 1,
  kind: "element",
  key: "hero",
  selector: "#hero",
  label: "Hero",
  preview: "Hero"
};

const attachment: ImageAttachment = {
  id: "image-1",
  name: "reference.png",
  mimeType: "image/png",
  size: 4,
  dataUrl: "data:image/png;base64,AAAA"
};

function harness(started = true) {
  const calls: string[] = [];
  const ports: ComposerSubmissionPorts = {
    getSelections: () => [selection],
    runSourceEdit: async () => {
      calls.push("source-edit");
      return "completed";
    },
    startArtifactGeneration: () => {
      calls.push("artifact-generation");
      return started;
    },
    sendChat: async () => {
      calls.push("chat");
    }
  };
  return {
    calls,
    ports
  };
}

describe("composer submission routing", () => {
  it("routes a selected artifact with an image through multimodal generation", async () => {
    const test = harness();

    assert.deepEqual(
      await submitComposerMessage("Match this reference", [attachment], test.ports),
      { kind: "artifact-generation" }
    );
    assert.deepEqual(test.calls, ["artifact-generation"]);
  });

  it("falls back to a chat request when a selected artifact is stale", async () => {
    const test = harness(false);

    assert.deepEqual(
      await submitComposerMessage("Keep the image", [attachment], test.ports),
      { kind: "chat" }
    );
    assert.deepEqual(test.calls, ["artifact-generation", "chat"]);
  });

  it("falls back when generation reports an asynchronous preflight refusal", async () => {
    const test = harness();
    test.ports.startArtifactGeneration = async () => {
      test.calls.push("artifact-generation");
      await Promise.resolve();
      return false;
    };

    assert.deepEqual(
      await submitComposerMessage("Keep the image", [attachment], test.ports),
      { kind: "chat" }
    );
    assert.deepEqual(test.calls, ["artifact-generation", "chat"]);
  });

  it("keeps attachment-free artifact edits on the source-edit path", async () => {
    const test = harness();

    assert.deepEqual(
      await submitComposerMessage("Change the heading", [], test.ports),
      { kind: "artifact-edit", editOutcome: "completed" }
    );
    assert.deepEqual(test.calls, ["source-edit"]);
  });

  it("surfaces rejected source edits so the composer can restore its draft", async () => {
    const test = harness();
    test.ports.runSourceEdit = async () => {
      test.calls.push("source-edit");
      return "busy";
    };

    const outcome = await submitComposerMessage(
      "Change the heading",
      [],
      test.ports
    );
    assert.deepEqual(outcome, { kind: "artifact-edit", editOutcome: "busy" });
    assert.equal(outcome.kind, "artifact-edit");
    if (outcome.kind !== "artifact-edit") {
      assert.fail("expected an artifact-edit outcome");
    }
    const message = getArtifactEditSubmissionError(outcome.editOutcome);
    assert.notEqual(message, null);
    assert.match(message ?? "", /draft was restored/i);
    assert.equal(getArtifactEditSubmissionError("completed"), null);
  });
});
