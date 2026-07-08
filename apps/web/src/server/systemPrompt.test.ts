import assert from "node:assert/strict";
import test from "node:test";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

test("discourages back navigation actions in chat artifacts", () => {
  assert.match(SYSTEM_PROMPT, /conversation history is already the navigation/i);
  assert.match(SYSTEM_PROMPT, /返回选择方向/);
  assert.match(SYSTEM_PROMPT, /返回低因列表/);
  assert.match(SYSTEM_PROMPT, /continue forward/i);
});

test("pushes generated artifacts through visual layout quality checks", () => {
  assert.match(SYSTEM_PROMPT, /Honor requested quantity/i);
  assert.match(SYSTEM_PROMPT, /IDs must be unique/i);
  assert.match(SYSTEM_PROMPT, /styled empty placeholder/i);
  assert.match(SYSTEM_PROMPT, /horizontal overflow/i);
  assert.match(SYSTEM_PROMPT, /no accidental duplicate primary subjects/i);
});
