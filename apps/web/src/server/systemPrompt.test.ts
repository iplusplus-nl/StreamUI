import assert from "node:assert/strict";
import test from "node:test";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

test("discourages back navigation actions in chat artifacts", () => {
  assert.match(SYSTEM_PROMPT, /conversation history is already the navigation/i);
  assert.match(SYSTEM_PROMPT, /返回选择方向/);
  assert.match(SYSTEM_PROMPT, /返回低因列表/);
  assert.match(SYSTEM_PROMPT, /continue forward/i);
});
