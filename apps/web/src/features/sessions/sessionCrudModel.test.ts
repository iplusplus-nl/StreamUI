import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ChatSession,
  SessionState
} from "../../domain/chat/sessionModel";
import {
  createNewSessionState,
  deleteSessionInState,
  selectSessionInState,
  updateActiveSessionInState,
  updateSessionByIdInState
} from "./sessionCrudModel";

function session(
  id: string,
  updatedAt: number,
  options: {
    empty?: boolean;
    withFile?: boolean;
    withBugDraft?: boolean;
  } = {}
): ChatSession {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    messages:
      options.empty || options.withFile || options.withBugDraft
        ? []
        : [{ id: `message-${id}`, role: "user", content: id }],
    files: options.withFile
      ? [
          {
            id: `file-${id}`,
            kind: "text",
            name: `${id}.txt`,
            mimeType: "text/plain",
            size: 1,
            createdAt: updatedAt
          }
        ]
      : [],
    bugReportDraft: options.withBugDraft
      ? { text: "draft", images: [], updatedAt }
      : undefined
  };
}

function state(
  activeSessionId: string,
  sessions: ChatSession[]
): SessionState {
  return { activeSessionId, sessions };
}

describe("session CRUD model", () => {
  it("updates one session, keeps the input immutable, and re-sorts by updatedAt", () => {
    const first = session("first", 10);
    const target = session("target", 5);
    const input = state("first", [first, target]);
    let calls = 0;

    const result = updateSessionByIdInState(input, "target", (current) => {
      calls += 1;
      assert.equal(current, target);
      return { ...current, title: "updated", updatedAt: 20 };
    });

    assert.equal(calls, 1);
    assert.notEqual(result, input);
    assert.equal(input.sessions[1], target);
    assert.deepEqual(result.sessions.map((item) => item.id), ["target", "first"]);
    assert.equal(result.sessions[0].title, "updated");
    assert.equal(result.sessions[1], first);
  });

  it("returns the original state and never calls the updater for a missing id", () => {
    const input = state("first", [session("first", 1)]);
    const result = updateSessionByIdInState(input, "missing", () => {
      throw new Error("updater should not run");
    });

    assert.equal(result, input);
  });

  it("updates only the active session and preserves a missing-active state", () => {
    const active = session("active", 1);
    const other = session("other", 2);
    const input = state("active", [other, active]);
    const updated = updateActiveSessionInState(input, (current) => ({
      ...current,
      title: "active updated",
      updatedAt: 3
    }));

    assert.equal(updated.sessions[0].id, "active");
    assert.equal(updated.sessions[0].title, "active updated");
    assert.equal(updated.sessions[1], other);
    assert.equal(
      updateActiveSessionInState(
        state("missing", [other]),
        () => session("unexpected", 4)
      ).sessions[0],
      other
    );
  });

  it("reuses the active empty session and compacts other empty sessions", () => {
    const activeEmpty = session("active-empty", 1, { empty: true });
    const otherEmpty = session("other-empty", 2, { empty: true });
    const filled = session("filled", 3);
    let factoryCalls = 0;

    const result = createNewSessionState(
      state(activeEmpty.id, [otherEmpty, filled, activeEmpty]),
      () => {
        factoryCalls += 1;
        return session("new", 4, { empty: true });
      }
    );

    assert.equal(factoryCalls, 0);
    assert.equal(result.outcome, "reused");
    assert.equal(result.transientEmptySessionId, activeEmpty.id);
    assert.equal(result.state.activeSessionId, activeEmpty.id);
    assert.deepEqual(result.state.sessions.map((item) => item.id), [
      "filled",
      "active-empty"
    ]);
  });

  it("creates a new session for non-empty active content and injects defaults through the factory", () => {
    const active = session("active", 4, { withBugDraft: true });
    const disposableEmpty = session("empty", 5, { empty: true });
    const created = {
      ...session("created", 1, { empty: true }),
      model: "factory-model",
      reasoningEffort: "high" as const,
      uiComplexity: 4
    };

    const result = createNewSessionState(
      state(active.id, [disposableEmpty, active]),
      () => created
    );

    assert.equal(result.outcome, "created");
    assert.equal(result.transientEmptySessionId, created.id);
    assert.equal(result.state.activeSessionId, created.id);
    assert.deepEqual(result.state.sessions, [created, active]);
  });

  it("creates a distinct session without compacting an empty session that owns a composer draft", () => {
    const draftOwner = session("draft-owner", 3, { empty: true });
    const saved = session("saved", 2);
    const created = session("created", 4, { empty: true });

    const result = createNewSessionState(
      state(draftOwner.id, [draftOwner, saved]),
      () => created,
      [draftOwner.id]
    );

    assert.equal(result.outcome, "created");
    assert.equal(result.state.activeSessionId, created.id);
    assert.deepEqual(
      result.state.sessions.map((item) => item.id),
      ["created", "draft-owner", "saved"]
    );
  });

  it("treats files as content when deciding whether to reuse an empty session", () => {
    const withFile = session("file-session", 1, { withFile: true });
    const created = session("created", 2, { empty: true });
    const result = createNewSessionState(
      state(withFile.id, [withFile]),
      () => created
    );

    assert.equal(result.outcome, "created");
    assert.deepEqual(result.state.sessions, [created, withFile]);
  });

  it("selects an empty target, preserves it, and compacts unrelated empties", () => {
    const target = session("target", 1, { empty: true });
    const otherEmpty = session("other-empty", 2, { empty: true });
    const filled = session("filled", 3);
    const result = selectSessionInState(
      state(filled.id, [otherEmpty, target, filled]),
      target.id
    );

    assert.equal(result.targetFound, true);
    assert.equal(result.state.activeSessionId, target.id);
    assert.deepEqual(result.state.sessions.map((item) => item.id), [
      "filled",
      "target"
    ]);
  });

  it("selects non-empty content while removing empty sessions and ignores unknown ids", () => {
    const first = session("first", 1);
    const target = session("target", 2);
    const empty = session("empty", 3, { empty: true });
    const input = state(first.id, [empty, target, first]);
    const selected = selectSessionInState(input, target.id);

    assert.equal(selected.targetFound, true);
    assert.equal(selected.state.activeSessionId, target.id);
    assert.deepEqual(selected.state.sessions.map((item) => item.id), [
      "target",
      "first"
    ]);

    const missing = selectSessionInState(input, "missing");
    assert.equal(missing.targetFound, false);
    assert.equal(missing.state, input);
  });

  it("preserves an inactive empty draft owner while selecting another session", () => {
    const draftOwner = session("draft-owner", 3, { empty: true });
    const target = session("target", 2);
    const result = selectSessionInState(
      state(draftOwner.id, [draftOwner, target]),
      target.id,
      [draftOwner.id]
    );

    assert.equal(result.state.activeSessionId, target.id);
    assert.deepEqual(
      result.state.sessions.map((item) => item.id),
      ["draft-owner", "target"]
    );
  });

  it("deletes the active session using the first remaining id before compaction", () => {
    const removed = session("removed", 5);
    const firstRemaining = session("kept-empty", 1, { empty: true });
    const newerFilled = session("newer-filled", 10);
    const input = state(removed.id, [removed, firstRemaining, newerFilled]);

    const result = deleteSessionInState(input, removed.id, () => {
      throw new Error("fallback should not be created");
    });

    assert.equal(result.activeSessionId, firstRemaining.id);
    assert.deepEqual(result.sessions.map((item) => item.id), [
      "newer-filled",
      "kept-empty"
    ]);
    assert.deepEqual(input.sessions, [removed, firstRemaining, newerFilled]);
  });

  it("deletes a non-active session without changing the active id", () => {
    const active = session("active", 2);
    const removed = session("removed", 3);
    const result = deleteSessionInState(
      state(active.id, [removed, active]),
      removed.id,
      () => session("unused", 4, { empty: true })
    );

    assert.equal(result.activeSessionId, active.id);
    assert.deepEqual(result.sessions, [active]);
  });

  it("does not compact another session's empty composer draft during deletion", () => {
    const active = session("active", 4);
    const removed = session("removed", 3);
    const draftOwner = session("draft-owner", 2, { empty: true });
    const result = deleteSessionInState(
      state(active.id, [active, removed, draftOwner]),
      removed.id,
      () => session("unused", 5, { empty: true }),
      [draftOwner.id]
    );

    assert.deepEqual(
      result.sessions.map((item) => item.id),
      ["active", "draft-owner"]
    );
  });

  it("creates the injected fallback after deleting the last session", () => {
    const only = session("only", 1);
    const fallback = session("fallback", 2, { empty: true });
    let calls = 0;
    const result = deleteSessionInState(state(only.id, [only]), only.id, () => {
      calls += 1;
      return fallback;
    });

    assert.equal(calls, 1);
    assert.deepEqual(result, {
      sessions: [fallback],
      activeSessionId: fallback.id
    });
  });
});
