import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildVisualRepairPrompt,
  clipVisualRepairDiagnostics,
  MAX_VISUAL_REPAIR_DIAGNOSTICS_CHARS
} from "./visualRepair";

describe("visual repair prompt", () => {
  it("preserves diagnostics within the limit", () => {
    const diagnostics = "layout is clipped";
    assert.equal(clipVisualRepairDiagnostics(diagnostics), diagnostics);
  });

  it("clips oversized diagnostics with an actionable suffix", () => {
    const clipped = clipVisualRepairDiagnostics(
      "x".repeat(MAX_VISUAL_REPAIR_DIAGNOSTICS_CHARS + 1)
    );

    assert.equal(
      clipped.endsWith(
        "[Diagnostics truncated; prioritize fixing layout, scale, overlap, clipping, and blur.]"
      ),
      true
    );
    assert.equal(clipped.length <= MAX_VISUAL_REPAIR_DIAGNOSTICS_CHARS, true);
  });

  it("builds screenshot-aware prompts and rounds the viewport width", () => {
    const prompt = buildVisualRepairPrompt({
      diagnostics: "overlapping labels",
      hasScreenshot: true,
      width: 719.6
    });

    assert.match(prompt, /attached rendering screenshot/);
    assert.match(prompt, /about 720px wide/);
    assert.match(prompt, /Render diagnostics and artifact source:/);
    assert.match(prompt, /overlapping labels/);
  });

  it("explains the text-only fallback without inventing diagnostics", () => {
    const prompt = buildVisualRepairPrompt({
      hasScreenshot: false,
      width: 500.2
    });

    assert.match(prompt, /cannot inspect image inputs/);
    assert.match(prompt, /about 500px wide/);
    assert.doesNotMatch(prompt, /Render diagnostics and artifact source:/);
  });
});
