import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHAT_REASONING_OPTIONS,
  getChatReasoningIndex,
  getChatReasoningLabel
} from "./chatModelSelectorModel";

describe("chat model selector reasoning model", () => {
  it("labels and maps minimal reasoning as Minimal", () => {
    const index = getChatReasoningIndex("minimal");

    assert.equal(getChatReasoningLabel("minimal"), "Minimal");
    assert.equal(CHAT_REASONING_OPTIONS[index].value, "minimal");
    assert.equal(CHAT_REASONING_OPTIONS[index].label, "Minimal");
  });

  it("keeps Off as the display fallback only for none", () => {
    assert.equal(getChatReasoningLabel("none"), "");
    assert.equal(CHAT_REASONING_OPTIONS[getChatReasoningIndex("none")].value, "none");
    assert.notEqual(getChatReasoningIndex("none"), getChatReasoningIndex("minimal"));
    assert.equal(getChatReasoningLabel("low"), "Low");
  });
});
