import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ChatSession,
  SessionFile,
  SessionState
} from "../../domain/chat/sessionModel";
import {
  updateMessageByIdInState,
  updateMessageInSessionByIdInState,
  upsertSessionFilesInState
} from "./sessionStateMutations";

function file(
  id: string,
  createdAt: number,
  name = `${id}.txt`
): SessionFile {
  return {
    id,
    kind: "text",
    name,
    mimeType: "text/plain",
    size: 1,
    createdAt
  };
}

function session(
  id: string,
  updatedAt: number,
  files: SessionFile[] = []
): ChatSession {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    messages: [{ id: `message-${id}`, role: "user", content: id }],
    files
  };
}

describe("session state mutations", () => {
  it("returns the original state for empty input or a missing session", () => {
    const active = session("active", 1);
    const state: SessionState = {
      activeSessionId: active.id,
      sessions: [active]
    };

    assert.equal(upsertSessionFilesInState(state, active.id, [], 10), state);
    assert.equal(
      upsertSessionFilesInState(state, "missing", [file("new", 2)], 10),
      state
    );
  });

  it("merges files by id, sorts files and sessions, and keeps inputs immutable", () => {
    const oldFile = file("same", 3, "old.txt");
    const target = session("target", 1, [oldFile]);
    const other = session("other", 5, [file("other", 1)]);
    const state: SessionState = {
      activeSessionId: target.id,
      sessions: [other, target]
    };
    const replacement = file("same", 3, "replacement.txt");
    const earlier = file("earlier", 2);

    const result = upsertSessionFilesInState(
      state,
      target.id,
      [replacement, earlier],
      10
    );

    assert.notEqual(result, state);
    assert.deepEqual(result.sessions.map((item) => item.id), ["target", "other"]);
    assert.equal(result.sessions[1], other);
    assert.equal(result.sessions[0].updatedAt, 10);
    assert.deepEqual(
      result.sessions[0].files.map((item) => [item.id, item.name]),
      [
        ["earlier", "earlier.txt"],
        ["same", "replacement.txt"]
      ]
    );
    assert.deepEqual(target.files, [oldFile]);
    assert.deepEqual(state.sessions, [other, target]);
  });

  it("keeps message identity no-ops from changing state or timestamps", () => {
    const active = session("active", 1);
    const state: SessionState = {
      activeSessionId: active.id,
      sessions: [active]
    };
    let calls = 0;

    const result = updateMessageByIdInState(
      state,
      active.messages[0].id,
      (message) => {
        calls += 1;
        return message;
      },
      99
    );

    assert.equal(calls, 1);
    assert.equal(result, state);
    assert.equal(result.sessions[0], active);
    assert.equal(result.sessions[0].updatedAt, 1);
  });

  it("updates a matching message, title, timestamp, and session order", () => {
    const target = session("target", 1);
    const other = session("other", 5);
    const state: SessionState = {
      activeSessionId: target.id,
      sessions: [other, target]
    };

    const result = updateMessageByIdInState(
      state,
      target.messages[0].id,
      (message) => ({ ...message, content: "Updated title" }),
      10
    );

    assert.notEqual(result, state);
    assert.deepEqual(result.sessions.map((item) => item.id), ["target", "other"]);
    assert.equal(result.sessions[0].title, "Updated title");
    assert.equal(result.sessions[0].updatedAt, 10);
    assert.equal(result.sessions[0].messages[0].content, "Updated title");
    assert.equal(result.sessions[1], other);
    assert.equal(state.sessions[1], target);
  });

  it("does not invoke a message updater for a missing id", () => {
    const active = session("active", 1);
    const state: SessionState = {
      activeSessionId: active.id,
      sessions: [active]
    };

    assert.equal(
      updateMessageByIdInState(
        state,
        "missing",
        () => {
          throw new Error("should not run");
        },
        10
      ),
      state
    );
  });

  it("updates only the explicitly targeted session when message ids collide", () => {
    const target = session("target", 1);
    const other = session("other", 5);
    target.messages[0] = { ...target.messages[0], id: "shared-message" };
    other.messages[0] = { ...other.messages[0], id: "shared-message" };
    const state: SessionState = {
      activeSessionId: other.id,
      sessions: [other, target]
    };

    const result = updateMessageInSessionByIdInState(
      state,
      target.id,
      "shared-message",
      (message) => ({ ...message, content: "Target only" }),
      10
    );

    assert.equal(result.sessions[0].id, target.id);
    assert.equal(result.sessions[0].messages[0].content, "Target only");
    assert.equal(result.sessions[0].updatedAt, 10);
    assert.equal(result.sessions[1], other);
    assert.equal(other.messages[0].content, "other");
  });

  it("keeps exact-session missing and identity mutations as no-ops", () => {
    const active = session("active", 1);
    const state: SessionState = {
      activeSessionId: active.id,
      sessions: [active]
    };
    let calls = 0;

    assert.equal(
      updateMessageInSessionByIdInState(
        state,
        "missing-session",
        active.messages[0].id,
        () => {
          throw new Error("should not run");
        },
        10
      ),
      state
    );
    assert.equal(
      updateMessageInSessionByIdInState(
        state,
        active.id,
        "missing-message",
        () => {
          throw new Error("should not run");
        },
        10
      ),
      state
    );
    assert.equal(
      updateMessageInSessionByIdInState(
        state,
        active.id,
        active.messages[0].id,
        (message) => {
          calls += 1;
          return message;
        },
        10
      ),
      state
    );
    assert.equal(calls, 1);
  });
});
