import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createArtifactFilename,
  getSnapshotDiagnostics,
  getSnapshotHtmlDocument,
  getSnapshotSourceCode,
  getSnapshotVisibleText,
  getArtifactExportScale,
  normalizeSvgMarkup
} from "./artifactExport";
import type { RenderSnapshot } from "../runtime/streamui/types";

function makeSnapshot(patch: Partial<RenderSnapshot>): RenderSnapshot {
  return {
    raw: "",
    completedHtml: "",
    iframeDocument: "<!doctype html>",
    errors: [],
    status: "complete",
    ...patch
  };
}

describe("artifactExport", () => {
  it("uses the raw artifact as copied source code when available", () => {
    const snapshot = makeSnapshot({
      raw: "<section><p>Raw source</p></section>",
      completedHtml: "<section><p>Completed source</p></section>"
    });

    assert.equal(
      getSnapshotSourceCode(snapshot),
      "<section><p>Raw source</p></section>\n"
    );
  });

  it("falls back to completed html for source code when raw is empty", () => {
    const snapshot = makeSnapshot({
      completedHtml: "<section><p>Completed source</p></section>"
    });

    assert.equal(
      getSnapshotSourceCode(snapshot),
      "<section><p>Completed source</p></section>\n"
    );
  });

  it("creates safe export filenames", () => {
    assert.equal(
      createArtifactFilename("assistant:one/two.svg", "png"),
      "assistant-one-two.png"
    );
    assert.equal(createArtifactFilename("   ", "svg"), "streamui-artifact.svg");
    assert.equal(
      createArtifactFilename("artifact report", "html"),
      "artifact-report.html"
    );
    assert.equal(
      createArtifactFilename("artifact report", "txt"),
      "artifact-report.txt"
    );
  });

  it("extracts visible text from completed html", () => {
    const snapshot = makeSnapshot({
      completedHtml:
        "<style>.x{}</style><section><h1>Hello</h1><p>Visible text</p><script>x()</script></section>"
    });

    assert.equal(getSnapshotVisibleText(snapshot), "Hello Visible text");
  });

  it("builds a complete themed html document", () => {
    const snapshot = makeSnapshot({
      completedHtml: "<section><p>Export me</p></section>"
    });
    const html = getSnapshotHtmlDocument(snapshot, "day");

    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /data-page-theme="day"/);
    assert.match(html, /<section><p>Export me<\/p><\/section>/);
  });

  it("writes artifact diagnostics", () => {
    const snapshot = makeSnapshot({
      raw: "<section><p>Raw</p></section>",
      completedHtml: "<section><p>Completed</p></section>",
      errors: [{ kind: "runtime", message: "boom", timestamp: 123 }]
    });
    const diagnostics = getSnapshotDiagnostics(snapshot, {
      exportWidth: 720,
      themeMode: "night"
    });

    assert.match(diagnostics, /StreamUI Artifact Diagnostics/);
    assert.match(diagnostics, /Requested export width: 720/);
    assert.match(diagnostics, /runtime: boom/);
    assert.match(diagnostics, /Visible text:/);
    assert.match(diagnostics, /Raw source:/);
  });

  it("scales very long png exports under canvas limits", () => {
    assert.ok(getArtifactExportScale(900, 80_000) < 1);
  });

  it("normalizes svg markup with a single xml declaration", () => {
    assert.equal(
      normalizeSvgMarkup("<svg></svg>"),
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg></svg>\n'
    );
    assert.equal(
      normalizeSvgMarkup('<?xml version="1.0"?><svg></svg>'),
      '<?xml version="1.0"?><svg></svg>\n'
    );
  });
});
