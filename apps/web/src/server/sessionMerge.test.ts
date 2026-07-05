import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeClientSaveState } from "../../server/sessions.js";

function session(id: string, updatedAt: number) {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    messages: [],
    files: []
  };
}

describe("server session merge", () => {
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
});
