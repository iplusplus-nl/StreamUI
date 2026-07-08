import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completePartialHtml } from "./htmlCompletion";

describe("completePartialHtml", () => {
  it("removes a broken trailing tag and closes open elements", () => {
    const html = completePartialHtml("<section><p>Hello<spa");

    assert.equal(html, "<section><p>Hello</p></section>");
  });

  it("strips scripts while streaming and keeps them when complete", () => {
    const input = "<p>Hi</p><script>window.answer = 42;</script>";

    assert.equal(completePartialHtml(input), "<p>Hi</p>");
    assert.equal(
      completePartialHtml(input, { allowScripts: true }),
      "<p>Hi</p><script>window.answer = 42;</script>"
    );
  });

  it("removes unsafe inline handlers and javascript urls", () => {
    const html = completePartialHtml(
      '<a href="javascript:alert(1)" onclick="alert(2)">Open</a>'
    );

    assert.equal(html, '<a href="#">Open</a>');
  });

  it("handles incomplete style blocks according to streaming mode", () => {
    assert.equal(completePartialHtml("<style>.x { color: red"), "");
    assert.equal(
      completePartialHtml("<style>.x { color: red", {
        allowPartialStyles: true
      }),
      "<style>.x { color: red\n</style>"
    );
  });

  it("neutralizes expensive css declarations", () => {
    const html = completePartialHtml(
      '<div style="backdrop-filter: blur(8px); background-attachment: fixed;">x</div>'
    );

    assert.equal(
      html,
      '<div style=" background-attachment: scroll;">x</div>'
    );
  });

  it("caps blur filters instead of making clone layers clear", () => {
    const html = completePartialHtml(
      '<style>.lens-blur{filter:blur(10px);transform:scale(1.04)}.shadow{filter:drop-shadow(0 2px 8px #000)}</style>'
    );

    assert.match(html, /filter: blur\(6px\);/);
    assert.match(html, /filter: none;/);
    assert.doesNotMatch(html, /filter:blur\(10px\)/);
  });
});
