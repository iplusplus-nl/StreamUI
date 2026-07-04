import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countUserPrompts,
  createEmptySession,
  createInitialSessionState,
  hasPersistedMessages,
  normalizeStoredMessage,
  normalizeStoredSessionState,
  serializeSessions,
  summarizeSession,
  titleFromText,
  type ChatSession,
  type ClientMessage
} from "./sessionModel";

describe("sessionModel", () => {
  it("creates deterministic empty sessions when id and time are injected", () => {
    const session = createEmptySession(123, "session-test");
    const state = createInitialSessionState(123, "session-test");

    assert.equal(session.id, "session-test");
    assert.equal(session.createdAt, 123);
    assert.equal(state.activeSessionId, "session-test");
  });

  it("derives compact titles from user or assistant messages", () => {
    assert.equal(titleFromText(""), "New Session");
    assert.equal(titleFromText("One two three four five six seven eight"), "One two three four five six seven");

    const messages: ClientMessage[] = [
      { id: "u1", role: "user", content: "Fallback user title" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        rawStream:
          "<sessiontitle>Generated title</sessiontitle><chat></chat><streamui><p>x</p></streamui>"
      }
    ];

    assert.equal(summarizeSession(messages), "Generated title");
  });

  it("counts user prompts", () => {
    assert.equal(
      countUserPrompts([
        { id: "u1", role: "user", content: "one" },
        { id: "a1", role: "assistant", content: "two" },
        { id: "u2", role: "user", content: "three" }
      ]),
      2
    );
  });

  it("normalizes stored assistant messages and rebuilds artifact snapshots", () => {
    const message = normalizeStoredMessage({
      id: "a1",
      role: "assistant",
      content: "",
      status: "streaming",
      rawStream: "<chat></chat><streamui><p>Saved</p></streamui>"
    });

    assert.equal(message?.status, "complete");
    assert.equal(message?.hasStreamUi, true);
    assert.match(message?.snapshot?.iframeDocument ?? "", /<p>Saved<\/p>/);
    assert.equal(message?.artifactContext?.textSummary, "Saved");
    assert.match(message?.artifactContext?.id ?? "", /^artifact-[a-z0-9]+$/);
  });

  it("preserves persisted runtime errors while rebuilding snapshots", () => {
    const message = normalizeStoredMessage({
      id: "a1",
      role: "assistant",
      content: "",
      rawStream: "<chat></chat><streamui><script>throw new Error('boom')</script></streamui>",
      runtimeErrors: [
        {
          kind: "runtime",
          message: "boom",
          timestamp: 123
        }
      ],
      repairOfMessageId: "a0",
      repairAttempt: 1
    });

    assert.equal(message?.runtimeErrors?.[0]?.message, "boom");
    assert.equal(message?.snapshot?.errors[0]?.message, "boom");
    assert.equal(message?.repairOfMessageId, "a0");
    assert.equal(message?.repairAttempt, 1);
  });

  it("sorts stored sessions and repairs active session ids", () => {
    const state = normalizeStoredSessionState(
      {
        activeSessionId: "missing",
        sessions: [
          { id: "old", title: "Old", createdAt: 1, updatedAt: 1, messages: [] },
          { id: "new", title: "New", createdAt: 2, updatedAt: 10, messages: [] }
        ]
      },
      100
    );

    assert.deepEqual(
      state.sessions.map((session) => session.id),
      ["new", "old"]
    );
    assert.equal(state.activeSessionId, "new");
  });

  it("detects persisted messages", () => {
    assert.equal(
      hasPersistedMessages({
        activeSessionId: "s1",
        sessions: [{ id: "s1", title: "", createdAt: 1, updatedAt: 1, messages: [] }]
      }),
      false
    );

    assert.equal(
      hasPersistedMessages({
        activeSessionId: "s1",
        sessions: [
          {
            id: "s1",
            title: "",
            createdAt: 1,
            updatedAt: 1,
            messages: [{ id: "u1", role: "user", content: "hello" }]
          }
        ]
      }),
      true
    );
  });

  it("serializes sessions without transient snapshots", () => {
    const sessions: ChatSession[] = [
      {
        id: "s1",
        title: "Session",
        createdAt: 1,
        updatedAt: 2,
        messages: [
          {
            id: "a1",
            role: "assistant",
            content: "",
            status: "streaming",
            snapshot: {
              raw: "",
              completedHtml: "",
              iframeDocument: "",
              errors: [],
              status: "streaming"
            }
          }
        ]
      }
    ];

    const serialized = serializeSessions(sessions);

    assert.equal(serialized[0].messages[0].status, "complete");
    assert.equal("snapshot" in serialized[0].messages[0], false);
  });

  it("preserves persisted artifact context while serializing sessions", () => {
    const sessions: ChatSession[] = [
      {
        id: "s1",
        title: "Session",
        createdAt: 1,
        updatedAt: 2,
        messages: [
          {
            id: "a1",
            role: "assistant",
            content: "",
            artifactContext: {
              id: "artifact-fixed",
              sourceHash: "fixed",
              sourceChars: 12,
              textSummary: "Text",
              styleSummary: "Style",
              structureSummary: "Structure",
              editableSummary: "Editable"
            },
            snapshot: {
              raw: "",
              completedHtml: "",
              iframeDocument: "",
              errors: [],
              status: "complete"
            }
          }
        ]
      }
    ];

    const serialized = serializeSessions(sessions);

    assert.equal(serialized[0].messages[0].artifactContext?.id, "artifact-fixed");
    assert.equal("snapshot" in serialized[0].messages[0], false);
  });
});
