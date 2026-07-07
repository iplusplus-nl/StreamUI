import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getSessionStateKeyFromClientId,
  mergeClientSaveState
} from "../../server/sessions.js";

function userMessage(id: string, content: string) {
  return {
    id,
    role: "user" as const,
    content
  };
}

function session(
  id: string,
  updatedAt: number,
  messages: ReturnType<typeof userMessage>[] = []
) {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    messages,
    files: []
  };
}

describe("server session merge", () => {
  it("scopes anonymous state by browser client id", () => {
    assert.equal(
      getSessionStateKeyFromClientId("client-test-12345678"),
      "client:client-test-12345678"
    );
    assert.equal(getSessionStateKeyFromClientId("short"), "global");
  });

  it("does not resurrect sessions deleted by another client", () => {
    const current = {
      sessions: [session("kept", 2)],
      activeSessionId: "kept",
      deletedSessionIds: ["deleted"]
    };
    const staleIncoming = {
      sessions: [session("deleted", 3), session("kept", 2)],
      activeSessionId: "deleted"
    };

    const merged = mergeClientSaveState(current, staleIncoming);

    assert.deepEqual(
      merged.sessions.map((item: { id: string }) => item.id),
      ["kept"]
    );
    assert.equal(merged.activeSessionId, "kept");
    assert.deepEqual(merged.deletedSessionIds, ["deleted"]);
  });

  it("records explicit deleted session ids as tombstones", () => {
    const current = {
      sessions: [session("deleted", 3), session("kept", 2)],
      activeSessionId: "deleted"
    };
    const incoming = {
      sessions: [session("kept", 2)],
      activeSessionId: "kept"
    };

    const merged = mergeClientSaveState(current, incoming, new Set(["deleted"]));

    assert.deepEqual(
      merged.sessions.map((item: { id: string }) => item.id),
      ["kept"]
    );
    assert.equal(merged.activeSessionId, "kept");
    assert.deepEqual(merged.deletedSessionIds, ["deleted"]);
  });

  it("does not preserve missing empty sessions during client saves", () => {
    const current = {
      sessions: [
        session("empty", 3),
        session("saved", 2, [userMessage("u1", "hello")])
      ],
      activeSessionId: "empty"
    };
    const incoming = {
      sessions: [session("saved", 4, [userMessage("u1", "hello")])],
      activeSessionId: "saved"
    };

    const merged = mergeClientSaveState(current, incoming);

    assert.deepEqual(
      merged.sessions.map((item: { id: string }) => item.id),
      ["saved"]
    );
    assert.equal(merged.activeSessionId, "saved");
  });

  it("still preserves missing non-empty sessions from other clients", () => {
    const current = {
      sessions: [
        session("other-client", 5, [userMessage("u2", "from another tab")]),
        session("saved", 2, [userMessage("u1", "hello")])
      ],
      activeSessionId: "other-client"
    };
    const incoming = {
      sessions: [session("saved", 4, [userMessage("u1", "hello")])],
      activeSessionId: "saved"
    };

    const merged = mergeClientSaveState(current, incoming);

    assert.deepEqual(
      merged.sessions.map((item: { id: string }) => item.id),
      ["other-client", "saved"]
    );
  });

  it("drops incoming empty sessions when incoming also has history", () => {
    const current = {
      sessions: [session("saved", 2, [userMessage("u1", "hello")])],
      activeSessionId: "saved"
    };
    const incoming = {
      sessions: [
        session("empty", 5),
        session("saved", 4, [userMessage("u1", "hello")])
      ],
      activeSessionId: "empty"
    };

    const merged = mergeClientSaveState(current, incoming);

    assert.deepEqual(
      merged.sessions.map((item: { id: string }) => item.id),
      ["saved"]
    );
    assert.equal(merged.activeSessionId, "saved");
  });

  it("allows a missing resumed run to be marked interrupted", () => {
    const current = {
      sessions: [
        {
          ...session("active", 2),
          messages: [
            {
              id: "a1",
              role: "assistant" as const,
              content: "",
              generationRunId: "run-1",
              streamSequence: 0,
              status: "streaming" as const
            }
          ]
        }
      ],
      activeSessionId: "active"
    };
    const incoming = {
      sessions: [
        {
          ...session("active", 3),
          messages: [
            {
              id: "a1",
              role: "assistant" as const,
              content: "I could not complete that request.",
              generationRunId: "run-1",
              streamSequence: 0,
              status: "error" as const,
              error: "The stream was interrupted before it completed."
            }
          ]
        }
      ],
      activeSessionId: "active"
    };

    const merged = mergeClientSaveState(current, incoming);

    assert.equal(merged.sessions[0].messages[0].status, "error");
    assert.equal(
      merged.sessions[0].messages[0].error,
      "The stream was interrupted before it completed."
    );
  });
});
