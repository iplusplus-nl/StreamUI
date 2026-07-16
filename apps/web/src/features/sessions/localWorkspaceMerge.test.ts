import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeStoredSessionState,
  type SessionFile,
  type SessionState
} from "../../domain/chat/sessionModel";
import { mergeLocalWorkspaceIntoAccount } from "./localWorkspaceMerge";

describe("local workspace account merge", () => {
  it("preserves account sessions, uploads local files, and is retry-safe", async () => {
    let serverState: SessionState = {
      activeSessionId: "account-session",
      sessions: [
        {
          id: "account-session",
          title: "Account",
          createdAt: 1,
          updatedAt: 1,
          messages: [{ id: "a1", role: "user", content: "account content" }],
          files: []
        }
      ]
    };
    const localState: SessionState = {
      activeSessionId: "local-session",
      sessions: [
        {
          id: "local-session",
          title: "Local",
          createdAt: 2,
          updatedAt: 3,
          messages: [
            {
              id: "l1",
              role: "user",
              content: "local content",
              fileIds: ["local-file"]
            }
          ],
          files: [
            {
              id: "local-file",
              kind: "text",
              name: "notes.txt",
              mimeType: "text/plain",
              size: 5,
              createdAt: 2,
              sourceMessageId: "l1",
              text: "notes"
            }
          ]
        }
      ]
    };
    let revision = 10;
    let uploadCount = 0;
    const dependencies = {
      requestSessions: async () => Response.json(serverState),
      persistSessions: async (serialized: string) => {
        serverState = normalizeStoredSessionState(JSON.parse(serialized), 100);
        return Response.json({ applied: true });
      },
      uploadFile: async (
        sessionId: string,
        input: { name: string; text?: string }
      ): Promise<SessionFile> => {
        uploadCount += 1;
        assert.equal(sessionId, "browser-import:local-session");
        assert.equal(input.text, "notes");
        const file: SessionFile = {
          id: "server-file",
          kind: "text",
          name: input.name,
          mimeType: "text/plain",
          size: 5,
          createdAt: 4,
          sourceMessageId: "l1",
          storageKey: "files/server-file",
          contentHash: "hash"
        };
        serverState = {
          ...serverState,
          sessions: serverState.sessions.map((session) =>
            session.id === sessionId
              ? { ...session, files: [...session.files, file] }
              : session
          )
        };
        return file;
      },
      nextRevision: () => ++revision,
      now: () => 100
    };

    const merged = await mergeLocalWorkspaceIntoAccount(
      localState,
      "client-1",
      dependencies
    );
    const imported = merged.sessions.find(
      (session) => session.id === "browser-import:local-session"
    );
    assert.ok(merged.sessions.some((session) => session.id === "account-session"));
    assert.deepEqual(imported?.messages[0].fileIds, ["server-file"]);
    assert.equal(imported?.files[0].storageKey, "files/server-file");
    assert.equal(uploadCount, 1);

    await mergeLocalWorkspaceIntoAccount(localState, "client-1", dependencies);
    assert.equal(uploadCount, 1);
  });

  it("rejects an incomplete server copy even when the imported id exists", async () => {
    const localState: SessionState = {
      activeSessionId: "local-session",
      sessions: [
        {
          id: "local-session",
          title: "Local",
          createdAt: 1,
          updatedAt: 2,
          messages: [{ id: "message", role: "user", content: "keep me" }],
          files: []
        }
      ]
    };
    let reads = 0;
    let serverState: SessionState = { sessions: [], activeSessionId: "" };

    await assert.rejects(
      mergeLocalWorkspaceIntoAccount(localState, "client", {
        requestSessions: async () => {
          reads += 1;
          return Response.json(
            reads < 4
              ? serverState
              : {
                  sessions: [
                    {
                      ...localState.sessions[0],
                      id: "browser-import:local-session",
                      messages: []
                    }
                  ],
                  activeSessionId: "browser-import:local-session"
                }
          );
        },
        persistSessions: async (serialized) => {
          serverState = normalizeStoredSessionState(
            JSON.parse(serialized),
            10
          );
          return Response.json({ applied: true });
        },
        uploadFile: async () => {
          throw new Error("No files should be uploaded.");
        },
        nextRevision: () => 1,
        now: () => 10
      }),
      /browser copy was kept/
    );
  });

  it("retries under a fresh id when the stable import id was deleted", async () => {
    const localState: SessionState = {
      activeSessionId: "local-session",
      sessions: [
        {
          id: "local-session",
          title: "Recovered local session",
          createdAt: 1,
          updatedAt: 2,
          messages: [{ id: "message", role: "user", content: "keep me" }],
          files: []
        }
      ]
    };
    const tombstonedId = "browser-import:local-session";
    let serverState: SessionState = { sessions: [], activeSessionId: "" };
    const persistedIds: string[][] = [];

    const merged = await mergeLocalWorkspaceIntoAccount(
      localState,
      "client",
      {
        requestSessions: async () => Response.json(serverState),
        persistSessions: async (serialized) => {
          const incoming = normalizeStoredSessionState(JSON.parse(serialized), 10);
          persistedIds.push(incoming.sessions.map((session) => session.id));
          serverState = {
            sessions: incoming.sessions.filter(
              (session) => session.id !== tombstonedId
            ),
            activeSessionId: incoming.activeSessionId
          };
          return Response.json({ applied: true });
        },
        uploadFile: async () => {
          throw new Error("No files should be uploaded.");
        },
        nextRevision: () => 1,
        createImportSuffix: () => "retry-1",
        now: () => 10
      }
    );

    assert.equal(persistedIds[0].includes(tombstonedId), true);
    assert.equal(
      merged.sessions.some(
        (session) => session.id === `${tombstonedId}:retry-1`
      ),
      true
    );
  });

  it("rebases automatically when a concurrent account save wins", async () => {
    const localState: SessionState = {
      activeSessionId: "local-session",
      sessions: [
        {
          id: "local-session",
          title: "Local",
          createdAt: 1,
          updatedAt: 2,
          messages: [{ id: "message", role: "user", content: "keep me" }],
          files: []
        }
      ]
    };
    let serverState: SessionState = { sessions: [], activeSessionId: "" };
    let saves = 0;

    const merged = await mergeLocalWorkspaceIntoAccount(
      localState,
      "client",
      {
        requestSessions: async () => Response.json(serverState),
        persistSessions: async (serialized) => {
          saves += 1;
          if (saves === 1) {
            serverState = normalizeStoredSessionState(
              {
                sessions: [
                  {
                    id: "concurrent",
                    title: "Concurrent",
                    createdAt: 3,
                    updatedAt: 3,
                    messages: [
                      { id: "other", role: "user", content: "other tab" }
                    ],
                    files: []
                  }
                ],
                activeSessionId: "concurrent"
              },
              10
            );
            return Response.json({ applied: false });
          }
          serverState = normalizeStoredSessionState(
            JSON.parse(serialized),
            10
          );
          return Response.json({ applied: true });
        },
        uploadFile: async () => {
          throw new Error("No files should be uploaded.");
        },
        nextRevision: () => saves + 1,
        now: () => 10
      }
    );

    assert.equal(saves >= 3, true);
    assert.equal(
      merged.sessions.some((session) => session.id === "concurrent"),
      true
    );
    assert.equal(
      merged.sessions.some(
        (session) => session.id === "browser-import:local-session"
      ),
      true
    );
  });
});
