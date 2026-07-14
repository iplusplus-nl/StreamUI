import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  requestSessionDeletion,
  sessionDeletionPrompt
} from "./sessionDeletionModel";

describe("session deletion confirmation", () => {
  it("keeps the session when confirmation is declined", () => {
    const deleted: string[] = [];
    const result = requestSessionDeletion(
      { id: "session-1", title: "Important work" },
      () => false,
      (id) => deleted.push(id)
    );

    assert.equal(result, false);
    assert.deepEqual(deleted, []);
  });

  it("deletes only after explicit confirmation", () => {
    const prompts: string[] = [];
    const deleted: string[] = [];
    const session = { id: "session-1", title: "Important work" };
    const result = requestSessionDeletion(
      session,
      (message) => {
        prompts.push(message);
        return true;
      },
      (id) => deleted.push(id)
    );

    assert.equal(result, true);
    assert.deepEqual(prompts, [sessionDeletionPrompt(session)]);
    assert.deepEqual(deleted, [session.id]);
  });
});
