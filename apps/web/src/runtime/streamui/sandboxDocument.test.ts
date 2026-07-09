import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildIframeBodyHtml,
  buildIframeDocument,
  getIframeThemeTokens
} from "./sandboxDocument";

describe("sandboxDocument", () => {
  it("creates day and night theme tokens", () => {
    assert.equal(getIframeThemeTokens("day").colorScheme, "light");
    assert.equal(getIframeThemeTokens("night").colorScheme, "dark");
  });

  it("wraps completed html in the sandbox document", () => {
    const document = buildIframeDocument("<p>Hello</p>", "day");

    assert.match(document, /^<!doctype html>/);
    assert.match(document, /Content-Security-Policy/);
    assert.match(document, /data-page-theme="day"/);
    assert.match(document, /<p>Hello<\/p>/);
    assert.match(document, /source: "streamui-runtime"/);
  });

  it("includes lazy MathJax rendering for TeX formulas", () => {
    const document = buildIframeDocument("<p>\\(x + 1\\)</p>");

    assert.match(document, /MathJax/);
    assert.match(document, /tex-chtml\.js/);
    assert.match(document, /inlineMath/);
    assert.match(document, /scheduleMathTypeset/);
    assert.match(document, /isPreviewComplete/);
    assert.match(document, /!isPreviewComplete\(\)/);
    assert.match(document, /streamuiTypesetMath/);
  });

  it("builds the same body html used by the live preview patcher", () => {
    const body = buildIframeBodyHtml("<p>Hello</p>");
    const document = buildIframeDocument("<p>Hello</p>");

    assert.match(body, /<p>Hello<\/p>/);
    assert.match(body, /streamui-performance-guard/);
    assert.match(document, new RegExp(body.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("includes the prompt action bridge", () => {
    const document = buildIframeDocument(
      '<button data-streamui-prompt="Continue">Continue</button>'
    );

    assert.match(document, /data-streamui-prompt/);
    assert.match(document, /actionType: "prompt"/);
    assert.match(document, /post\("action"/);
  });

  it("can disable host actions until the artifact is complete", () => {
    const document = buildIframeDocument(
      '<button data-streamui-prompt="Continue">Continue</button>',
      "night",
      false
    );

    assert.match(document, /data-streamui-actions-enabled="false"/);
    assert.match(document, /body\[data-streamui-actions-enabled="false"\]/);
    assert.match(document, /animation: none !important/);
    assert.match(document, /transition: none !important/);
    assert.match(document, /areHostActionsEnabled/);
  });

  it("includes the artifact selection bridge", () => {
    const document = buildIframeDocument("<section><h1>Hello</h1></section>");

    assert.match(document, /streamui-selection-hover/);
    assert.match(document, /data\.kind === "selection-mode"/);
    assert.match(document, /data\.kind === "selection-targets"/);
    assert.match(document, /post\("selection"/);
    assert.match(document, /streamui-text-selection-toolbar/);
    assert.match(document, /Reference/);
    assert.doesNotMatch(
      document,
      /<button type="button" data-selection-kind="element">Element<\/button>/
    );
    assert.match(document, /coversIframeViewport/);
    assert.match(document, /OVERSIZED_SELECTION_EDGE_TOLERANCE/);
    assert.match(document, /isOversizedSelectionTarget/);
    assert.match(document, /exitSelectionMode/);
    assert.match(document, /return part;/);
    assert.match(document, /legacyIdSelector/);
  });

  it("includes the local capability action bridge", () => {
    const document = buildIframeDocument(
      '<button data-streamui-copy-target="#code">Copy</button><code id="code">x</code>'
    );

    assert.match(document, /data-streamui-copy/);
    assert.match(document, /data-streamui-download/);
    assert.match(document, /data-streamui-open-url/);
    assert.match(document, /actionType: "copy"/);
    assert.match(document, /actionType: "download"/);
    assert.match(document, /actionType: "open-url"/);
  });

  it("bridges clipboard writes through the host", () => {
    const document = buildIframeDocument(
      "<button>Copy</button><script>navigator.clipboard.writeText('x')</script>"
    );

    assert.match(document, /installClipboardBridge/);
    assert.match(document, /bridgedClipboardWriteText/);
    assert.match(document, /capability-result/);
  });

  it("measures content bounds instead of the previous iframe viewport height", () => {
    const document = buildIframeDocument(
      "<details open><summary>More</summary><p>Text</p></details>"
    );

    assert.match(document, /getBoundingClientRect/);
    assert.match(document, /HEIGHT_SAFETY_PADDING/);
    assert.match(document, /SHRINK_SETTLE_MS/);
    assert.match(document, /isViewportOverlay/);
    assert.match(document, /hasPositionedAncestor/);
    assert.match(document, /data\.kind === "measure"/);
    assert.doesNotMatch(document, /scrollHeight \|\| 0/);
    assert.doesNotMatch(document, /offsetHeight \|\| 0/);
    assert.doesNotMatch(document, /offsetParent/);
    assert.doesNotMatch(document, /offsetTop/);
  });

  it("ignores top-level absolute viewport overlays when measuring", () => {
    const document = buildIframeDocument(
      '<section><div class="scan"></div><p>Body</p></section><style>.scan{position:absolute;inset:0;pointer-events:none}</style>'
    );

    assert.match(document, /style\.position === "fixed"/);
    assert.match(document, /style\.position !== "absolute"/);
    assert.match(document, /!hasPositionedAncestor\(element, body\)/);
  });
});
