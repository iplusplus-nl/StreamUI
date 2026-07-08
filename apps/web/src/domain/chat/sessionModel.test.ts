import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compactEmptySessions,
  countUserPrompts,
  createEmptySession,
  createInitialSessionState,
  filterDeletedSessionState,
  getSessionStreamingRunIds,
  hasPersistedMessages,
  isSessionEmpty,
  mergeSyncedSessionState,
  normalizeStoredMessage,
  normalizeStoredSessionState,
  serializeSessions,
  stripLegacyArtifactActionPrefix,
  summarizeSession,
  titleFromText,
  type ChatSession,
  type ClientMessage
} from "./sessionModel";

describe("sessionModel", () => {
  it("creates deterministic empty sessions when id and time are injected", () => {
    const session = createEmptySession(123, "session-test", "model-a");
    const state = createInitialSessionState(123, "session-test", "model-b");

    assert.equal(session.id, "session-test");
    assert.equal(session.createdAt, 123);
    assert.equal(session.model, "model-a");
    assert.equal(state.activeSessionId, "session-test");
    assert.equal(state.sessions[0].model, "model-b");
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

  it("can normalize stored artifacts without rebuilding snapshots", () => {
    const state = normalizeStoredSessionState(
      {
        activeSessionId: "s1",
        sessions: [
          {
            id: "s1",
            title: "Saved",
            createdAt: 1,
            updatedAt: 1,
            messages: [
              {
                id: "a1",
                role: "assistant",
                content: "",
                status: "streaming",
                rawStream: "<chat></chat><streamui><p>Saved</p></streamui>"
              }
            ]
          }
        ]
      },
      1,
      { rebuildSnapshots: false }
    );
    const message = state.sessions[0].messages[0];

    assert.equal(message.status, "complete");
    assert.equal(message.hasStreamUi, true);
    assert.equal(message.streamUiComplete, true);
    assert.equal(message.snapshot, undefined);
  });

  it("preserves resumable stored assistant streams", () => {
    const message = normalizeStoredMessage({
      id: "a1",
      role: "assistant",
      content: "",
      status: "streaming",
      generationRunId: "run-1",
      streamSequence: 4,
      rawStream: "<chat></chat><streamui><p>Still streaming"
    });

    assert.equal(message?.status, "streaming");
    assert.equal(message?.generationRunId, "run-1");
    assert.equal(message?.streamSequence, 4);
    assert.equal(message?.hasStreamUi, true);
  });

  it("lists streaming run ids for a single session", () => {
    const session: ChatSession = {
      id: "s1",
      title: "Session",
      createdAt: 1,
      updatedAt: 1,
      files: [],
      messages: [
        {
          id: "a1",
          role: "assistant",
          content: "",
          generationRunId: "run-1",
          status: "streaming"
        },
        {
          id: "a2",
          role: "assistant",
          content: "done",
          generationRunId: "run-2",
          status: "complete"
        },
        {
          id: "u1",
          role: "user",
          content: "hello",
          status: "complete"
        }
      ]
    };

    assert.deepEqual(getSessionStreamingRunIds(session), ["run-1"]);
  });

  it("migrates stored assistant artifacts into session files", () => {
    const state = normalizeStoredSessionState({
      activeSessionId: "s1",
      sessions: [
        {
          id: "s1",
          title: "Saved",
          createdAt: 1,
          updatedAt: 1,
          messages: [
            {
              id: "a1",
              role: "assistant",
              content: "",
              rawStream: "<chat></chat><streamui><p>Saved</p></streamui>"
            }
          ]
        }
      ]
    });

    assert.equal(state.sessions[0].files[0].id, "file-artifact-a1");
    assert.match(state.sessions[0].files[0].text ?? "", /<p>Saved<\/p>/);
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
          {
            id: "old",
            title: "Old",
            createdAt: 1,
            updatedAt: 1,
            messages: [{ id: "u-old", role: "user", content: "old" }]
          },
          {
            id: "new",
            title: "New",
            createdAt: 2,
            updatedAt: 10,
            messages: [{ id: "u-new", role: "user", content: "new" }]
          }
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

  it("drops empty stored sessions when persisted history exists", () => {
    const state = normalizeStoredSessionState(
      {
        activeSessionId: "empty-new",
        sessions: [
          {
            id: "empty-new",
            title: "New Session",
            createdAt: 3,
            updatedAt: 30,
            messages: [],
            files: []
          },
          {
            id: "saved",
            title: "Saved",
            createdAt: 1,
            updatedAt: 10,
            messages: [{ id: "u1", role: "user", content: "hello" }],
            files: []
          },
          {
            id: "empty-old",
            title: "New Session",
            createdAt: 2,
            updatedAt: 20,
            messages: [],
            files: []
          }
        ]
      },
      100
    );

    assert.deepEqual(
      state.sessions.map((session) => session.id),
      ["saved"]
    );
    assert.equal(state.activeSessionId, "saved");
  });

  it("keeps one empty session when no persisted history exists", () => {
    const state = normalizeStoredSessionState(
      {
        activeSessionId: "empty-old",
        sessions: [
          {
            id: "empty-new",
            title: "New Session",
            createdAt: 3,
            updatedAt: 30,
            messages: [],
            files: []
          },
          {
            id: "empty-old",
            title: "New Session",
            createdAt: 2,
            updatedAt: 20,
            messages: [],
            files: []
          }
        ]
      },
      100
    );

    assert.deepEqual(
      state.sessions.map((session) => session.id),
      ["empty-old"]
    );
    assert.equal(state.activeSessionId, "empty-old");
  });

  it("can preserve the active empty session as a transient draft", () => {
    const active = createEmptySession(30, "empty-new");
    const compacted = compactEmptySessions(
      {
        activeSessionId: active.id,
        sessions: [
          active,
          createEmptySession(20, "empty-old"),
          {
            id: "saved",
            title: "Saved",
            createdAt: 1,
            updatedAt: 10,
            messages: [{ id: "u1", role: "user", content: "hello" }],
            files: []
          }
        ]
      },
      { preserveActiveEmpty: true }
    );

    assert.equal(isSessionEmpty(active), true);
    assert.deepEqual(
      compacted.sessions.map((session) => session.id),
      ["empty-new", "saved"]
    );
    assert.equal(compacted.activeSessionId, "empty-new");
  });

  it("preserves a local active streaming run over stale server sync", () => {
    const local = mergeSyncedSessionState(
      {
        activeSessionId: "s1",
        sessions: [
          {
            id: "s1",
            title: "Local",
            createdAt: 1,
            updatedAt: 20,
            files: [],
            messages: [
              { id: "u1", role: "user", content: "continue", status: "complete" },
              {
                id: "a1",
                role: "assistant",
                content: "",
                generationRunId: "run-1",
                streamSequence: 2,
                status: "streaming"
              }
            ]
          }
        ]
      },
      {
        activeSessionId: "s1",
        sessions: [
          {
            id: "s1",
            title: "Server stale",
            createdAt: 1,
            updatedAt: 10,
            files: [],
            messages: []
          }
        ]
      }
    );

    assert.equal(local.sessions[0].title, "Local");
    assert.equal(local.sessions[0].messages[1].generationRunId, "run-1");
  });

  it("preserves local artifact edit state over stale server sync", () => {
    const merged = mergeSyncedSessionState(
      {
        activeSessionId: "s1",
        sessions: [
          {
            id: "s1",
            title: "Local",
            createdAt: 1,
            updatedAt: 30,
            files: [],
            messages: [
              { id: "u1", role: "user", content: "make a card" },
              {
                id: "a1",
                role: "assistant",
                content: "",
                rawStream: "<chat></chat><streamui><p>Edited</p></streamui>",
                artifactEditBaseRawStream:
                  "<chat></chat><streamui><p>Original</p></streamui>",
                activeArtifactEditId: "edit-1",
                artifactEdits: [
                  {
                    id: "edit-1",
                    createdAt: 20,
                    prompt: "Change copy",
                    references: [],
                    activeVariantId: "variant-1",
                    variants: [
                      {
                        id: "variant-1",
                        createdAt: 20,
                        status: "complete",
                        rawStream:
                          "<chat></chat><streamui><p>Edited</p></streamui>"
                      }
                    ],
                    status: "complete"
                  }
                ]
              }
            ]
          }
        ]
      },
      {
        activeSessionId: "s1",
        sessions: [
          {
            id: "s1",
            title: "Server stale",
            createdAt: 1,
            updatedAt: 10,
            files: [],
            messages: [
              { id: "u1", role: "user", content: "make a card" },
              {
                id: "a1",
                role: "assistant",
                content: "",
                rawStream: "<chat></chat><streamui><p>Original</p></streamui>"
              }
            ]
          }
        ]
      }
    );

    const assistant = merged.sessions[0].messages[1];
    assert.equal(assistant.rawStream, "<chat></chat><streamui><p>Edited</p></streamui>");
    assert.equal(assistant.activeArtifactEditId, "edit-1");
    assert.equal(assistant.artifactEdits?.[0]?.id, "edit-1");
  });

  it("filters locally deleted sessions during server sync", () => {
    const merged = mergeSyncedSessionState(
      {
        activeSessionId: "kept",
        sessions: [
          {
            id: "kept",
            title: "Kept",
            createdAt: 1,
            updatedAt: 2,
            files: [],
            messages: [{ id: "u1", role: "user", content: "hello" }]
          }
        ]
      },
      {
        activeSessionId: "deleted",
        sessions: [
          {
            id: "deleted",
            title: "Deleted",
            createdAt: 1,
            updatedAt: 3,
            files: [],
            messages: [{ id: "u2", role: "user", content: "gone" }]
          },
          {
            id: "kept",
            title: "Server kept",
            createdAt: 1,
            updatedAt: 2,
            files: [],
            messages: [{ id: "u1", role: "user", content: "hello" }]
          }
        ]
      },
      ["deleted"]
    );

    assert.deepEqual(
      merged.sessions.map((session) => session.id),
      ["kept"]
    );
    assert.equal(merged.activeSessionId, "kept");
  });

  it("uses a current fallback when every server session is locally deleted", () => {
    const fallback = createEmptySession(4, "new-local");
    const filtered = filterDeletedSessionState(
      {
        activeSessionId: "deleted",
        sessions: [
          {
            id: "deleted",
            title: "Deleted",
            createdAt: 1,
            updatedAt: 3,
            files: [],
            messages: [{ id: "u1", role: "user", content: "gone" }]
          }
        ]
      },
      ["deleted"],
      {
        activeSessionId: fallback.id,
        sessions: [fallback]
      }
    );

    assert.deepEqual(
      filtered.sessions.map((session) => session.id),
      ["new-local"]
    );
    assert.equal(filtered.activeSessionId, "new-local");
  });

  it("allows completed server runs to replace local streaming state", () => {
    const merged = mergeSyncedSessionState(
      {
        activeSessionId: "s1",
        sessions: [
          {
            id: "s1",
            title: "Local streaming",
            createdAt: 1,
            updatedAt: 20,
            files: [],
            messages: [
              {
                id: "a1",
                role: "assistant",
                content: "",
                generationRunId: "run-1",
                status: "streaming"
              }
            ]
          }
        ]
      },
      {
        activeSessionId: "s1",
        sessions: [
          {
            id: "s1",
            title: "Server complete",
            createdAt: 1,
            updatedAt: 30,
            files: [],
            messages: [
              {
                id: "a1",
                role: "assistant",
                content: "done",
                generationRunId: "run-1",
                status: "complete"
              }
            ]
          }
        ]
      }
    );

    assert.equal(merged.sessions[0].title, "Server complete");
    assert.equal(merged.sessions[0].messages[0].content, "done");
  });

  it("normalizes and serializes per-session model choices", () => {
    const state = normalizeStoredSessionState({
      activeSessionId: "s1",
      sessions: [
        {
          id: "s1",
          title: "Model session",
          createdAt: 1,
          updatedAt: 2,
          model: "  z-ai/glm-5.2  ",
          messages: [],
          files: []
        }
      ]
    });

    assert.equal(state.sessions[0].model, "z-ai/glm-5.2");
    assert.equal(serializeSessions(state.sessions)[0].model, "z-ai/glm-5.2");
  });

  it("detects persisted messages", () => {
    assert.equal(
      hasPersistedMessages({
        activeSessionId: "s1",
        sessions: [
          { id: "s1", title: "", createdAt: 1, updatedAt: 1, messages: [], files: [] }
        ]
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
            messages: [{ id: "u1", role: "user", content: "hello" }],
            files: []
          }
        ]
      }),
      true
    );
  });

  it("strips legacy artifact action click prefixes from user messages", () => {
    assert.equal(
      stripLegacyArtifactActionPrefix(
        'I clicked "脱因工艺详解". 详细说说瑞士水洗低因是怎么脱因的。'
      ),
      "详细说说瑞士水洗低因是怎么脱因的。"
    );

    const message = normalizeStoredMessage({
      id: "u1",
      role: "user",
      content: 'I clicked "展开细节".\n\n请继续。'
    });

    assert.equal(message?.content, "请继续。");
  });

  it("serializes sessions without transient snapshots and preserves active streams", () => {
    const sessions: ChatSession[] = [
      {
        id: "s1",
        title: "Session",
        createdAt: 1,
        updatedAt: 2,
        files: [],
        messages: [
          {
            id: "a1",
            role: "assistant",
            content: "",
            generationRunId: "run-1",
            streamSequence: 12,
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

    assert.equal(serialized[0].messages[0].status, "streaming");
    assert.equal(serialized[0].messages[0].error, undefined);
    assert.equal(serialized[0].messages[0].generationRunId, "run-1");
    assert.equal(serialized[0].messages[0].streamSequence, 12);
    assert.equal("snapshot" in serialized[0].messages[0], false);
  });

  it("preserves persisted artifact context while serializing sessions", () => {
    const sessions: ChatSession[] = [
      {
        id: "s1",
        title: "Session",
        createdAt: 1,
        updatedAt: 2,
        files: [],
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

  it("preserves artifact edit hierarchy while normalizing and serializing", () => {
    const message = normalizeStoredMessage({
      id: "a1",
      role: "assistant",
      content: "Artifact",
      rawStream: "<chat></chat><streamui><p>Edited</p></streamui>",
      hasStreamUi: true,
      streamUiComplete: true,
      artifactEditBaseRawStream:
        "<chat></chat><streamui><p>Original</p></streamui>",
      activeArtifactEditId: "edit-1",
      artifactEdits: [
        {
          id: "edit-1",
          createdAt: 10,
          prompt: "Change the copy",
          references: [
            {
              kind: "element",
              key: "p-0",
              selector: "p",
              label: "p",
              preview: "Original"
            }
          ],
          activeVariantId: "variant-1",
          variants: [
            {
              id: "variant-1",
              createdAt: 11,
              status: "complete",
              rawStream: "<chat></chat><streamui><p>Edited</p></streamui>",
              editCount: 1
            }
          ],
          status: "complete"
        }
      ]
    });

    assert.equal(message?.activeArtifactEditId, "edit-1");
    assert.equal(message?.artifactEdits?.[0]?.references[0]?.selector, "p");
    assert.equal(
      message?.artifactEdits?.[0]?.variants[0]?.rawStream,
      "<chat></chat><streamui><p>Edited</p></streamui>"
    );

    const serialized = serializeSessions([
      {
        id: "s1",
        title: "Session",
        createdAt: 1,
        updatedAt: 2,
        files: [],
        messages: message ? [message] : []
      }
    ]);

    assert.equal(
      serialized[0].messages[0].artifactEditBaseRawStream,
      "<chat></chat><streamui><p>Original</p></streamui>"
    );
    assert.equal(serialized[0].messages[0].artifactEdits?.[0]?.id, "edit-1");
    assert.equal("snapshot" in serialized[0].messages[0], false);
  });

  it("preserves pending artifact edits during ordinary normalization", () => {
    const message = normalizeStoredMessage({
      id: "a1",
      role: "assistant",
      content: "Artifact",
      artifactEdits: [
        {
          id: "edit-1",
          createdAt: 10,
          prompt: "Still pending",
          references: [],
          activeVariantId: "variant-1",
          variants: [
            {
              id: "variant-1",
              createdAt: 11,
              status: "pending"
            }
          ],
          status: "pending"
        }
      ]
    });

    assert.equal(message?.artifactEdits?.[0]?.status, "pending");
    assert.equal(message?.artifactEdits?.[0]?.error, undefined);
    assert.equal(message?.artifactEdits?.[0]?.variants[0]?.status, "pending");
  });

  it("marks restored pending artifact edits as interrupted when requested", () => {
    const message = normalizeStoredMessage(
      {
        id: "a1",
        role: "assistant",
        content: "Artifact",
        artifactEdits: [
          {
            id: "edit-1",
            createdAt: 10,
            prompt: "Still pending",
            references: [],
            activeVariantId: "variant-1",
            variants: [
              {
                id: "variant-1",
                createdAt: 11,
                status: "pending"
              }
            ],
            status: "pending"
          }
        ]
      },
      { interruptPendingArtifactEdits: true }
    );

    assert.equal(message?.artifactEdits?.[0]?.status, "error");
    assert.match(
      message?.artifactEdits?.[0]?.error ?? "",
      /interrupted/i
    );
    assert.equal(message?.artifactEdits?.[0]?.variants[0]?.status, "error");
  });
});
