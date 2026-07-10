import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canCaptureArtifactSelection } from "./artifactSelection";

describe("artifactSelection", () => {
  it("keeps text references available when direct editing is disabled", () => {
    assert.equal(canCaptureArtifactSelection("text", false), true);
  });

  it("requires direct editing for element selections", () => {
    assert.equal(canCaptureArtifactSelection("element", false), false);
    assert.equal(canCaptureArtifactSelection("element", true), true);
  });
});
