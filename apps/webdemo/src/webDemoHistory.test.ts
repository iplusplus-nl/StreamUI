import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  loadWebDemoHistory,
  normalizeWebDemoHistory,
  saveWebDemoHistory,
  WEB_DEMO_HISTORY_KEY
} from "./webDemoHistory";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values
  };
}

describe("Web Demo browser history", () => {
  it("round-trips sessions without persisting render snapshots", () => {
    const storage = memoryStorage();
    const state = normalizeWebDemoHistory(
      {
        activeSessionId: "session-one",
        sessions: [
          {
            id: "session-one",
            title: "Hello",
            createdAt: 1,
            updatedAt: 2,
            files: [],
            messages: [
              { id: "user-one", role: "user", content: "Hello" },
              {
                id: "assistant-one",
                role: "assistant",
                content: "Hi",
                status: "complete",
                snapshot: { iframeDocument: "large generated document" }
              }
            ]
          }
        ]
      },
      10
    );

    saveWebDemoHistory(state, storage);
    const stored = storage.values.get(WEB_DEMO_HISTORY_KEY) ?? "";
    assert.doesNotMatch(stored, /large generated document/);
    assert.equal(loadWebDemoHistory(storage, 10).sessions[0].messages.length, 2);
  });

  it("repairs interrupted streams and corrupted cache safely", () => {
    const interrupted = normalizeWebDemoHistory({
      activeSessionId: "s",
      sessions: [
        {
          id: "s",
          title: "Test",
          createdAt: 1,
          updatedAt: 1,
          files: [],
          messages: [
            {
              id: "a",
              role: "assistant",
              content: "partial",
              generationRunId: "run",
              status: "streaming"
            }
          ]
        }
      ]
    });
    assert.equal(interrupted.sessions[0].messages[0].status, "error");

    const corrupted = memoryStorage({ [WEB_DEMO_HISTORY_KEY]: "{" });
    assert.equal(loadWebDemoHistory(corrupted, 20).sessions.length, 1);
  });
});
