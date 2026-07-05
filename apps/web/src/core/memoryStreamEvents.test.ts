import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_API_SETTINGS } from "./apiSettings";
import { applyMemoryStreamEvent } from "./memoryStreamEvents";

describe("memoryStreamEvents", () => {
  it("adds memory items from stream events", () => {
    const settings = applyMemoryStreamEvent(DEFAULT_API_SETTINGS, {
      type: "memory",
      action: "add",
      item: { id: "memory-1", text: "User prefers concise Chinese replies." }
    });

    assert.deepEqual(settings.memoryItems, [
      { id: "memory-1", text: "User prefers concise Chinese replies." }
    ]);
  });

  it("updates existing memory items with the same id", () => {
    const settings = applyMemoryStreamEvent(
      {
        ...DEFAULT_API_SETTINGS,
        memoryItems: [{ id: "memory-1", text: "Old preference." }]
      },
      {
        type: "memory",
        action: "add",
        item: { id: "memory-1", text: "Updated preference." }
      }
    );

    assert.deepEqual(settings.memoryItems, [
      { id: "memory-1", text: "Updated preference." }
    ]);
  });

  it("deletes memory items by id", () => {
    const settings = applyMemoryStreamEvent(
      {
        ...DEFAULT_API_SETTINGS,
        memoryItems: [
          { id: "memory-1", text: "Keep this." },
          { id: "memory-2", text: "Remove this." }
        ]
      },
      { type: "memory", action: "delete", id: "memory-2" }
    );

    assert.deepEqual(settings.memoryItems, [
      { id: "memory-1", text: "Keep this." }
    ]);
  });

  it("ignores malformed memory events", () => {
    const original = {
      ...DEFAULT_API_SETTINGS,
      memoryItems: [{ id: "memory-1", text: "Keep this." }]
    };
    const settings = applyMemoryStreamEvent(original, {
      type: "memory",
      action: "add"
    });

    assert.equal(settings, original);
  });
});
