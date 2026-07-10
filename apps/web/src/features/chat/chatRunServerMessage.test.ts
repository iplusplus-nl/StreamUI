import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadChatRunServerMessage } from "./chatRunServerMessage";

function storedState() {
  return {
    version: 1,
    activeSessionId: "session-1",
    sessions: [
      {
        id: "session-1",
        title: "Session",
        createdAt: 10,
        updatedAt: 20,
        messages: [
          { id: "user-1", role: "user", content: "Hello" },
          {
            id: "assistant-1",
            role: "assistant",
            content: "Partial",
            rawStream: "Partial",
            generationRunId: "run-1",
            streamSequence: 4,
            status: "streaming"
          }
        ],
        files: []
      }
    ]
  };
}

describe("chat run server message loader", () => {
  it("loads the exact normalized assistant without rebuilding snapshots", async () => {
    const clients: string[] = [];
    const message = await loadChatRunServerMessage({
      clientId: "client-1",
      sessionId: "session-1",
      assistantId: "assistant-1",
      now: () => 100,
      request: async (clientId) => {
        clients.push(clientId);
        return Response.json(storedState());
      }
    });

    assert.deepEqual(clients, ["client-1"]);
    assert.equal(message?.id, "assistant-1");
    assert.equal(message?.role, "assistant");
    assert.equal(message?.rawStream, "Partial");
    assert.equal(message?.streamSequence, 4);
    assert.equal(message?.snapshot, undefined);
  });

  it("returns undefined for a missing exact target", async () => {
    const message = await loadChatRunServerMessage({
      clientId: "client-1",
      sessionId: "session-1",
      assistantId: "missing",
      request: async () => Response.json(storedState())
    });

    assert.equal(message, undefined);
  });

  it("preserves the session sync HTTP failure", async () => {
    await assert.rejects(
      loadChatRunServerMessage({
        clientId: "client-1",
        sessionId: "session-1",
        assistantId: "assistant-1",
        request: async () => new Response("failed", { status: 503 })
      }),
      /Session sync failed with HTTP 503/
    );
  });
});
