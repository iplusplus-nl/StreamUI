import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ChatSession,
  SessionFile,
  SessionState
} from "../../domain/chat/sessionModel";
import { upsertSessionFilesInState } from "./sessionStateMutations";

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
});
