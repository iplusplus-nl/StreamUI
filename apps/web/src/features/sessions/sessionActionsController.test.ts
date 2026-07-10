import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ChatSession,
  SessionState
} from "../../domain/chat/sessionModel";
import {
  createSessionActionsController,
  type SessionActionsDependencies
} from "./sessionActionsController";

function session(
  id: string,
  updatedAt: number,
  empty = false
): ChatSession {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    messages: empty
      ? []
      : [{ id: `message-${id}`, role: "user", content: id }],
    files: []
  };
}

function harness(
  initial: SessionState,
  overrides: Partial<SessionActionsDependencies> = {}
) {
  let current = initial;
  let transientId: string | null = null;
  let blocked = false;
  let selectionBlocked = false;
  const deletedIds = new Set<string>();
  const events: string[] = [];
  const savedSnapshots: Array<{
    state: SessionState;
    deletedIds: string[];
  }> = [];
  let fallbackCount = 0;

  const dependencies: SessionActionsDependencies = {
    isNewOrDeleteBlocked: () => blocked,
    isSelectionBlocked: () => selectionBlocked,
    getState: () => current,
    replaceState: (next) => {
      current = next;
      events.push("state");
    },
    getTransientEmptySessionId: () => transientId,
    setTransientEmptySessionId: (id) => {
      transientId = id;
      events.push(`transient:${id ?? "null"}`);
    },
    markSessionDeleted: (id) => {
      deletedIds.add(id);
      events.push(`deleted:${id}`);
    },
    createSession: () => {
      fallbackCount += 1;
      return session(`created-${fallbackCount}`, 100 + fallbackCount, true);
    },
    saveNow: () => {
      savedSnapshots.push({
        state: current,
        deletedIds: Array.from(deletedIds)
      });
      events.push("save");
    },
    ...overrides
  };

  return {
    actions: createSessionActionsController(dependencies),
    get state() {
      return current;
    },
    set state(next: SessionState) {
      current = next;
    },
    get transientId() {
      return transientId;
    },
    set transientId(id: string | null) {
      transientId = id;
    },
    get blocked() {
      return blocked;
    },
    set blocked(value: boolean) {
      blocked = value;
    },
    get selectionBlocked() {
      return selectionBlocked;
    },
    set selectionBlocked(value: boolean) {
      selectionBlocked = value;
    },
    deletedIds,
    events,
    savedSnapshots,
    get fallbackCount() {
      return fallbackCount;
    }
  };
}

describe("session actions controller", () => {
  it("updates the latest active or addressed session and reports missing ids", () => {
    const first = session("first", 1);
    const second = session("second", 2);
    const test = harness({ activeSessionId: first.id, sessions: [second, first] });

    assert.equal(
      test.actions.updateActiveSession((current) => ({
        ...current,
        title: "active updated",
        updatedAt: 3
      })),
      true
    );
    assert.equal(test.state.sessions[0].title, "active updated");

    test.state = { ...test.state, activeSessionId: second.id };
    assert.equal(
      test.actions.updateSessionById(second.id, (current) => ({
        ...current,
        title: "second updated",
        updatedAt: 4
      })),
      true
    );
    assert.equal(test.state.sessions[0].title, "second updated");
    assert.equal(
      test.actions.updateSessionById("missing", () => {
        throw new Error("missing updater should not run");
      }),
      false
    );
  });

  it("blocks new and delete actions without any side effects", () => {
    const only = session("only", 1);
    const initial = { activeSessionId: only.id, sessions: [only] };
    const test = harness(initial);
    test.blocked = true;
    test.transientId = only.id;

    assert.equal(test.actions.createNewSession(), "blocked");
    assert.equal(test.actions.deleteSession(only.id), "blocked");
    assert.equal(test.state, initial);
    assert.equal(test.transientId, only.id);
    assert.deepEqual(test.events, []);
    assert.deepEqual(Array.from(test.deletedIds), []);
    assert.equal(test.savedSnapshots.length, 0);
  });

  it("still permits selection while new/delete actions are blocked", () => {
    const first = session("first", 1);
    const second = session("second", 2);
    const test = harness({ activeSessionId: first.id, sessions: [second, first] });
    test.blocked = true;
    test.transientId = first.id;

    assert.equal(test.actions.selectSession(second.id), "selected");
    assert.equal(test.state.activeSessionId, second.id);
    assert.equal(test.transientId, null);
  });

  it("blocks selection independently while composer attachments are present", () => {
    const first = session("first", 1);
    const second = session("second", 2);
    const initial = { activeSessionId: first.id, sessions: [second, first] };
    const test = harness(initial);
    test.selectionBlocked = true;
    test.transientId = first.id;

    assert.equal(test.actions.selectSession(second.id), "blocked");
    assert.equal(test.state, initial);
    assert.equal(test.transientId, first.id);
    assert.deepEqual(test.events, []);
  });

  it("reuses an active empty session without calling the factory", () => {
    const empty = session("empty", 1, true);
    let factoryCalls = 0;
    const test = harness(
      { activeSessionId: empty.id, sessions: [empty] },
      {
        createSession: () => {
          factoryCalls += 1;
          return session("unexpected", 2, true);
        }
      }
    );

    assert.equal(test.actions.createNewSession(), "reused");
    assert.equal(factoryCalls, 0);
    assert.equal(test.transientId, empty.id);
    assert.deepEqual(test.events, ["transient:empty", "state"]);
  });

  it("creates a new session and makes it the transient active session", () => {
    const filled = session("filled", 1);
    const created = {
      ...session("created", 2, true),
      model: "latest-model"
    };
    const test = harness(
      { activeSessionId: filled.id, sessions: [filled] },
      { createSession: () => created }
    );

    assert.equal(test.actions.createNewSession(), "created");
    assert.equal(test.state.activeSessionId, created.id);
    assert.equal(test.state.sessions[0], created);
    assert.equal(test.transientId, created.id);
  });

  it("keeps a transient marker when selecting it and clears it for another target", () => {
    const transient = session("transient", 1, true);
    const other = session("other", 2);
    const test = harness({
      activeSessionId: other.id,
      sessions: [other, transient]
    });
    test.transientId = transient.id;

    assert.equal(test.actions.selectSession(transient.id), "selected");
    assert.equal(test.transientId, transient.id);
    assert.equal(test.actions.selectSession(other.id), "selected");
    assert.equal(test.transientId, null);
    assert.equal(test.actions.selectSession("missing"), "not-found");
    assert.equal(test.transientId, null);
  });

  it("commits state and tombstone before saving exactly once", () => {
    const kept = session("kept", 1);
    const removed = session("removed", 2);
    const test = harness({
      activeSessionId: removed.id,
      sessions: [removed, kept]
    });
    test.transientId = removed.id;

    assert.equal(test.actions.deleteSession(removed.id), "deleted");
    assert.equal(test.state.activeSessionId, kept.id);
    assert.deepEqual(test.state.sessions, [kept]);
    assert.equal(test.transientId, null);
    assert.deepEqual(test.events, [
      "transient:null",
      "deleted:removed",
      "state",
      "save"
    ]);
    assert.equal(test.savedSnapshots.length, 1);
    assert.equal(test.savedSnapshots[0].state, test.state);
    assert.deepEqual(test.savedSnapshots[0].deletedIds, [removed.id]);
  });

  it("keeps a tombstone for ids absent before hydration and saves it", () => {
    const local = session("local", 1);
    const test = harness({ activeSessionId: local.id, sessions: [local] });

    assert.equal(test.actions.deleteSession("preview-only"), "tombstoned-only");
    assert.equal(test.deletedIds.has("preview-only"), true);
    assert.equal(test.savedSnapshots.length, 1);
    assert.deepEqual(test.savedSnapshots[0].deletedIds, ["preview-only"]);
  });

  it("uses a fallback for the last deletion and lets the next action see it", () => {
    const only = session("only", 1);
    const test = harness({ activeSessionId: only.id, sessions: [only] });

    assert.equal(test.actions.deleteSession(only.id), "deleted");
    assert.equal(test.state.activeSessionId, "created-1");
    assert.equal(test.fallbackCount, 1);
    assert.equal(test.actions.createNewSession(), "reused");
    assert.equal(test.fallbackCount, 1);
    assert.equal(test.transientId, "created-1");
  });

  it("preserves the legacy tombstone ordering when the fallback factory throws", () => {
    const only = session("only", 1);
    const initial = { activeSessionId: only.id, sessions: [only] };
    const test = harness(initial, {
      createSession: () => {
        throw new Error("factory failed");
      }
    });
    test.transientId = only.id;

    assert.throws(() => test.actions.deleteSession(only.id), /factory failed/);
    assert.equal(test.state, initial);
    assert.equal(test.transientId, null);
    assert.deepEqual(test.events, ["transient:null", "deleted:only"]);
    assert.deepEqual(Array.from(test.deletedIds), [only.id]);
    assert.equal(test.savedSnapshots.length, 0);
  });

  it("does not commit state when a session updater throws", () => {
    const only = session("only", 1);
    const initial = { activeSessionId: only.id, sessions: [only] };
    const test = harness(initial);

    assert.throws(
      () =>
        test.actions.updateActiveSession(() => {
          throw new Error("updater failed");
        }),
      /updater failed/
    );
    assert.equal(test.state, initial);
    assert.deepEqual(test.events, []);
  });
});
