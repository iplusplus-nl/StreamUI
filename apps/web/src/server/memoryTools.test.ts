import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMemoryContextPrompt,
  createMemoryToolStats,
  createMemoryTools,
  normalizeMemorySettings,
  type MemoryStreamEvent
} from "../../server/memoryTools.js";

async function stringifyToolOutput(
  output: string | AsyncIterable<string>
): Promise<string> {
  if (typeof output === "string") {
    return output;
  }

  let text = "";
  for await (const chunk of output) {
    text += chunk;
  }
  return text;
}

test("memory prompt injects user preference prompt and memory table", () => {
  const prompt = buildMemoryContextPrompt({
    userPreferencePrompt: "Prefer concise Chinese replies.",
    memoryItems: [{ id: "memory-1", text: "User works in TypeScript." }]
  });

  assert.match(prompt, /Persistent user preferences and memory:/);
  assert.match(prompt, /Prefer concise Chinese replies\./);
  assert.match(prompt, /\[memory-1\] User works in TypeScript\./);
  assert.match(prompt, /Use addMemory only for stable, long-term/);
  assert.match(prompt, /Use deleteMemory only when/);
});

test("memory settings migrate legacy preference fields", () => {
  const settings = normalizeMemorySettings({
    userPreferences: {
      responseTone: "Warm.",
      longTermMemory: "- User likes small increments.\n- User prefers tests."
    }
  });

  assert.equal(settings.userPreferencePrompt, "Warm.");
  assert.deepEqual(
    settings.memoryItems.map((item) => item.text),
    ["User likes small increments.", "User prefers tests."]
  );
});

test("addMemory emits a memory add event and status", async () => {
  const stats = createMemoryToolStats();
  const events: MemoryStreamEvent[] = [];
  const statuses: string[] = [];
  const tools = createMemoryTools({
    memoryItems: [],
    stats,
    onEvent: (event) => events.push(event),
    onStatus: (message) => statuses.push(message)
  });
  const execute = tools.addMemory.execute;
  assert.ok(execute);

  const output = await stringifyToolOutput(
    await execute(
      { text: "User prefers concise Chinese replies." },
      { toolCallId: "add-memory-test", messages: [] }
    )
  );

  assert.equal(stats.adds, 1);
  assert.equal(stats.errors, 0);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "memory");
  assert.equal(events[0].action, "add");
  assert.match(output, /Added memory item memory-/);
  if (events[0].action === "add") {
    assert.equal(events[0].item.text, "User prefers concise Chinese replies.");
  }
  assert.deepEqual(statuses, [
    'Memory: added "User prefers concise Chinese replies.".'
  ]);
});

test("deleteMemory emits a delete event only for valid ids", async () => {
  const stats = createMemoryToolStats();
  const events: MemoryStreamEvent[] = [];
  const tools = createMemoryTools({
    memoryItems: [{ id: "memory-1", text: "Remove this." }],
    stats,
    onEvent: (event) => events.push(event)
  });
  const execute = tools.deleteMemory.execute;
  assert.ok(execute);

  const output = await stringifyToolOutput(
    await execute(
      { id: "memory-1" },
      { toolCallId: "delete-memory-test", messages: [] }
    )
  );
  const missingOutput = await stringifyToolOutput(
    await execute(
      { id: "missing" },
      { toolCallId: "delete-missing-memory-test", messages: [] }
    )
  );

  assert.equal(stats.deletes, 1);
  assert.equal(stats.errors, 1);
  assert.deepEqual(events, [{ type: "memory", action: "delete", id: "memory-1" }]);
  assert.equal(output, "Deleted memory item memory-1.");
  assert.match(missingOutput, /No memory item with id missing exists/);
});
