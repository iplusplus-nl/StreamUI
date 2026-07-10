import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ChatSession,
  SessionState
} from "../../domain/chat/sessionModel";
import {
  mergePolledSessionState,
  resolveInitialSessionState,
  shouldRequestSessionSync
} from "./sessionSyncPolicy";

function session(
  id: string,
  updatedAt: number,
  content?: string
): ChatSession {
  return {
    id,
    title: content ?? "New Session",
    createdAt: updatedAt,
    updatedAt,
    messages: content
      ? [{ id: `message-${id}`, role: "user", content }]
      : [],
    files: []
  };
}

function state(activeSessionId: string, sessions: ChatSession[]): SessionState {
  return { activeSessionId, sessions };
}

describe("session sync policy", () => {
  it("uses legacy history only when the server has no persisted messages", () => {
    const current = state("current", [session("current", 1)]);
    const emptyServer = state("server-empty", [session("server-empty", 2)]);
    const populatedServer = state("server", [session("server", 3, "Server")]);
    const legacy = state("legacy", [session("legacy", 4, "Legacy")]);

    assert.equal(
      resolveInitialSessionState({
        current,
        serverState: emptyServer,
        legacyState: legacy
      }),
      legacy
    );
    assert.equal(
      resolveInitialSessionState({
        current,
        serverState: populatedServer,
        legacyState: legacy
      }),
      populatedServer
    );
  });

  it("filters tombstones and falls back to current state when all loaded sessions were deleted", () => {
    const current = state("current", [session("current", 1, "Local")]);
    const server = state("deleted", [
      session("deleted", 3, "Deleted"),
      session("kept", 2, "Kept")
    ]);

    const filtered = resolveInitialSessionState({
      current,
      serverState: server,
      legacyState: null,
      deletedSessionIds: ["deleted"]
    });
    assert.deepEqual(filtered.sessions.map((item) => item.id), ["kept"]);
    assert.equal(filtered.activeSessionId, "kept");

    const fallback = resolveInitialSessionState({
      current,
      serverState: state("deleted", [session("deleted", 3, "Deleted")]),
      legacyState: null,
      deletedSessionIds: ["deleted"]
    });
    assert.deepEqual(fallback, current);
  });

  it("merges a matching transient empty session but otherwise uses loaded state", () => {
    const currentEmpty = session("draft", 5);
    const current = state("draft", [currentEmpty]);
    const server = state("saved", [session("saved", 4, "Saved")]);

    const merged = resolveInitialSessionState({
      current,
      serverState: server,
      legacyState: null,
      transientEmptySessionId: "draft"
    });
    assert.equal(merged.activeSessionId, "draft");
    assert.deepEqual(
      merged.sessions.map((item) => item.id),
      ["draft", "saved"]
    );

    assert.equal(
      resolveInitialSessionState({
        current,
        serverState: server,
        legacyState: null,
        transientEmptySessionId: "another-draft"
      }),
      server
    );

    const currentPopulated = state("draft", [session("draft", 5, "Typed")]);
    assert.equal(
      resolveInitialSessionState({
        current: currentPopulated,
        serverState: server,
        legacyState: null,
        transientEmptySessionId: "draft"
      }),
      server
    );
  });

  it("blocks polling for active runs, cancellations, attachments, and the active transient draft", () => {
    const populated = state("saved", [session("saved", 1, "Saved")]);
    const empty = state("draft", [session("draft", 1)]);

    assert.equal(
      shouldRequestSessionSync({ state: populated, hasActiveRuns: true }),
      false
    );
    assert.equal(
      shouldRequestSessionSync({
        state: populated,
        hasRecentCancellations: true
      }),
      false
    );
    assert.equal(
      shouldRequestSessionSync({
        state: populated,
        hasAttachmentDrafts: true
      }),
      false
    );
    assert.equal(
      shouldRequestSessionSync({
        state: empty,
        transientEmptySessionId: "draft"
      }),
      false
    );
    assert.equal(
      shouldRequestSessionSync({
        state: empty,
        transientEmptySessionId: "another-draft"
      }),
      true
    );
    assert.equal(shouldRequestSessionSync({ state: populated }), true);
  });

  it("keeps the current reference for persistently equal merges and returns real changes", () => {
    const current = state("saved", [session("saved", 1, "Current")]);
    const equivalentServer = structuredClone(current);

    assert.equal(
      mergePolledSessionState({
        current,
        serverState: equivalentServer,
        clientId: "client-1"
      }),
      current
    );

    const changed = mergePolledSessionState({
      current,
      serverState: state("saved", [session("saved", 2, "Changed")]),
      clientId: "client-1"
    });
    assert.notEqual(changed, current);
    assert.equal(changed.sessions[0].messages[0].content, "Changed");
  });

  it("does not mutate current, server, legacy, or tombstone inputs", () => {
    const current = state("draft", [session("draft", 5)]);
    const server = state("server", [session("server", 4, "Server")]);
    const legacy = state("legacy", [session("legacy", 3, "Legacy")]);
    const deletedSessionIds = ["missing"];
    const before = structuredClone({
      current,
      server,
      legacy,
      deletedSessionIds
    });

    resolveInitialSessionState({
      current,
      serverState: server,
      legacyState: legacy,
      deletedSessionIds,
      transientEmptySessionId: "draft"
    });
    shouldRequestSessionSync({
      state: current,
      transientEmptySessionId: "draft"
    });
    mergePolledSessionState({
      current,
      serverState: server,
      clientId: "client-1",
      deletedSessionIds
    });

    assert.deepEqual(
      { current, server, legacy, deletedSessionIds },
      before
    );
  });
});
