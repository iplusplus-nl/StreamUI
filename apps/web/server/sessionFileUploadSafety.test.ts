import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeClientSaveState } from "./sessions.js";
import {
  SessionFileUploadRollbackError,
  TombstonedSessionUploadError,
  applyUploadedSessionFileMetadata,
  assertSessionFileUploadAllowed,
  mergeSessionFilesForClientSave,
  normalizeEphemeralFileIds,
  removeOwnedEphemeralFilesFromSession,
  removeOwnedEphemeralSessionFiles,
  runSessionFileDeletionTransaction,
  runSessionFileUploadTransaction,
  selectDurableSessionFiles,
  selectEphemeralSessionFileIdentities,
  selectTombstonedSessionStorageKeys
} from "./sessionFileUploadSafety.js";

type TestFile = {
  id: string;
  storageKey: string;
};

function state(deletedSessionIds: string[] = []) {
  return {
    sessions: [] as Array<{
      id: string;
      title: string;
      createdAt: number;
      updatedAt: number;
      messages: unknown[];
      files?: TestFile[];
    }>,
    activeSessionId: "existing",
    deletedSessionIds
  };
}

describe("ephemeral chat run files", () => {
  it("normalizes ids and excludes only ephemeral files from durable persistence", () => {
    const files = [
      { id: "durable", storageKey: "durable/blob" },
      { id: "screenshot", storageKey: "temporary/blob" }
    ];
    const ephemeralIds = normalizeEphemeralFileIds([
      " screenshot ",
      "screenshot",
      null,
      ""
    ]);

    assert.deepEqual(ephemeralIds, ["screenshot"]);
    assert.deepEqual(selectDurableSessionFiles(files, ephemeralIds), [files[0]]);
    assert.deepEqual(files.map((file) => file.id), ["durable", "screenshot"]);
  });

  it("selects cleanup identities only for declared files that actually exist", () => {
    assert.deepEqual(
      selectEphemeralSessionFileIdentities(
        [
          {
            id: "screenshot",
            storageKey: "session/screenshot/blob.png",
            contentHash: "hash-1"
          },
          { id: "durable", storageKey: "session/durable/blob.png" },
          { id: "inline-only" }
        ],
        ["screenshot", "missing", "inline-only"]
      ),
      [
        {
          id: "screenshot",
          storageKey: "session/screenshot/blob.png",
          contentHash: "hash-1"
        }
      ]
    );
  });

  it("removes only the exact draft owned by the terminal run", () => {
    const expected = [
      {
        id: "screenshot",
        storageKey: "target/screenshot/blob.png",
        contentHash: "hash-1"
      }
    ];
    const exactDraft = {
      id: "screenshot",
      storageKey: "target/screenshot/blob.png",
      contentHash: "hash-1",
      draft: true
    };
    const durableReplacement = {
      ...exactDraft,
      id: "durable-same-storage",
      draft: false
    };
    const reusedId = {
      ...exactDraft,
      storageKey: "target/reused/blob.png"
    };

    assert.deepEqual(
      removeOwnedEphemeralSessionFiles(
        [exactDraft, durableReplacement, reusedId],
        expected
      ),
      {
        files: [durableReplacement, reusedId],
        removedStorageKeys: ["target/screenshot/blob.png"]
      }
    );
  });

  it("does not delete a durable replacement with the same id and identity", () => {
    const durable = {
      id: "screenshot",
      storageKey: "target/screenshot/blob.png",
      contentHash: "hash-1"
    };

    assert.deepEqual(
      removeOwnedEphemeralSessionFiles([durable], [durable]),
      { files: [durable], removedStorageKeys: [] }
    );
  });

  it("requires an exact session and leaves a foreign same-id file untouched", () => {
    const targetDraft = {
      id: "screenshot",
      storageKey: "target/screenshot/blob.png",
      draft: true
    };
    const foreignDraft = {
      id: "screenshot",
      storageKey: "foreign/screenshot/blob.png",
      draft: true
    };
    const sessions = [
      { id: "target", files: [targetDraft] },
      { id: "foreign", files: [foreignDraft] }
    ];
    const expected = [
      { id: "screenshot", storageKey: "target/screenshot/blob.png" }
    ];

    assert.deepEqual(
      removeOwnedEphemeralFilesFromSession(sessions, undefined, expected),
      { sessions, removedStorageKeys: [] }
    );
    assert.deepEqual(
      removeOwnedEphemeralFilesFromSession(sessions, "missing", expected),
      { sessions, removedStorageKeys: [] }
    );
    assert.deepEqual(
      removeOwnedEphemeralFilesFromSession(sessions, "target", expected),
      {
        sessions: [
          { id: "target", files: [] },
          { id: "foreign", files: [foreignDraft] }
        ],
        removedStorageKeys: ["target/screenshot/blob.png"]
      }
    );
  });

  it("is idempotent after the owned draft has been removed", () => {
    const expected = [
      {
        id: "screenshot",
        storageKey: "target/screenshot/blob.png",
        contentHash: "hash-1"
      }
    ];
    const first = removeOwnedEphemeralFilesFromSession(
      [
        {
          id: "target",
          files: [
            {
              ...expected[0],
              draft: true
            }
          ]
        }
      ],
      "target",
      expected
    );
    const second = removeOwnedEphemeralFilesFromSession(
      first.sessions,
      "target",
      expected
    );

    assert.deepEqual(first.removedStorageKeys, [
      "target/screenshot/blob.png"
    ]);
    assert.deepEqual(second, {
      sessions: [{ id: "target", files: [] }],
      removedStorageKeys: []
    });
  });

  it("does not remove a reused storage key with a different content hash", () => {
    const current = {
      id: "screenshot",
      storageKey: "target/screenshot/blob.png",
      contentHash: "replacement-hash",
      draft: true
    };

    assert.deepEqual(
      removeOwnedEphemeralSessionFiles([current], [
        {
          id: "screenshot",
          storageKey: "target/screenshot/blob.png",
          contentHash: "original-hash"
        }
      ]),
      { files: [current], removedStorageKeys: [] }
    );
  });

});

describe("draft session file merge safety", () => {
  it("preserves hidden server drafts across ordinary client saves", () => {
    const draft = {
      id: "temporary-screenshot",
      storageKey: "session/temporary-screenshot/blob",
      draft: true
    };
    const incoming = {
      id: "visible-file",
      storageKey: "session/visible-file/blob"
    };

    assert.deepEqual(
      mergeSessionFilesForClientSave(
        [
          { id: "removed-visible", storageKey: "old/blob" },
          draft
        ],
        [incoming],
        false
      ),
      [draft, incoming]
    );
  });

  it("lets an incoming visible record replace a server draft without duplicates", () => {
    const visible: { id: string; storageKey: string; draft?: boolean } = {
      id: "uploaded-file",
      storageKey: "session/uploaded-file/blob"
    };

    assert.deepEqual(
      mergeSessionFilesForClientSave(
        [{ ...visible, draft: true }],
        [visible],
        false
      ),
      [visible]
    );
  });

  it("keeps all current files while an active run is being reconciled", () => {
    const current = [
      { id: "durable", storageKey: "durable/blob" },
      { id: "draft", storageKey: "draft/blob", draft: true }
    ];

    assert.deepEqual(
      mergeSessionFilesForClientSave(current, [], true),
      current
    );
  });

  it("preserves a server-only draft through the real session merge", () => {
    type TestState = Parameters<typeof mergeClientSaveState>[0];
    const draft = {
      id: "temporary-screenshot",
      kind: "image" as const,
      name: "render.png",
      mimeType: "image/png",
      size: 10,
      createdAt: 5,
      storageKey: "session/temporary-screenshot/blob.png",
      draft: true
    };
    const baseSession = {
      id: "session-1",
      title: "Session",
      createdAt: 1,
      updatedAt: 10,
      messages: [{ id: "user-1", role: "user" as const, content: "Hello" }]
    };
    const current: TestState = {
      sessions: [{ ...baseSession, files: [draft] }],
      activeSessionId: "session-1"
    };
    const incoming: TestState = {
      sessions: [{ ...baseSession, updatedAt: 20, files: [] }],
      activeSessionId: "session-1"
    };

    const merged = mergeClientSaveState(current, incoming);

    assert.equal(merged.sessions[0].files?.length, 1);
    assert.equal(merged.sessions[0].files?.[0].id, draft.id);
    assert.equal(merged.sessions[0].files?.[0].storageKey, draft.storageKey);
    assert.equal(merged.sessions[0].files?.[0].draft, true);
  });

  it("retains metadata for a draft-only session omitted by the client", () => {
    type TestState = Parameters<typeof mergeClientSaveState>[0];
    const draft = {
      id: "temporary-screenshot",
      kind: "image" as const,
      name: "render.png",
      mimeType: "image/png",
      size: 10,
      createdAt: 5,
      storageKey: "draft-only/temporary-screenshot/blob.png",
      draft: true
    };
    const current: TestState = {
      sessions: [
        {
          id: "draft-only",
          title: "New Session",
          createdAt: 1,
          updatedAt: 5,
          messages: [],
          files: [draft]
        },
        {
          id: "visible",
          title: "Visible",
          createdAt: 1,
          updatedAt: 4,
          messages: [
            { id: "user-1", role: "user" as const, content: "Hello" }
          ],
          files: []
        }
      ],
      activeSessionId: "visible"
    };
    const incoming: TestState = {
      sessions: [current.sessions[1]],
      activeSessionId: "visible"
    };

    const merged = mergeClientSaveState(current, incoming);
    const preserved = merged.sessions.find(
      (session) => session.id === "draft-only"
    );

    assert.equal(preserved?.files?.length, 1);
    assert.equal(preserved?.files?.[0].storageKey, draft.storageKey);
    assert.equal(preserved?.files?.[0].draft, true);
  });
});

describe("tombstoned session file cleanup", () => {
  it("selects every unique blob owned by sessions deleted in the same save", () => {
    assert.deepEqual(
      selectTombstonedSessionStorageKeys(
        [
          {
            id: "deleted",
            files: [
              { storageKey: "deleted/draft.png" },
              { storageKey: "deleted/draft.png" },
              { storageKey: "deleted/durable.html" },
              {}
            ]
          },
          {
            id: "kept",
            files: [{ storageKey: "kept/file.png" }]
          }
        ],
        ["deleted"]
      ),
      ["deleted/draft.png", "deleted/durable.html"]
    );
  });
});

describe("session file upload metadata", () => {
  it("rejects tombstoned sessions without mutating state", () => {
    const current = state(["deleted"]);

    assert.throws(
      () =>
        applyUploadedSessionFileMetadata(
          current,
          "deleted",
          { id: "file-1", storageKey: "deleted/file-1" },
          10
        ),
      TombstonedSessionUploadError
    );
    assert.deepEqual(current.sessions, []);
    assert.equal(current.activeSessionId, "existing");
  });

  it("preserves uploads to missing sessions that have no tombstone", () => {
    const current = state(["other-deleted"]);
    const file = { id: "file-1", storageKey: "new/file-1" };

    applyUploadedSessionFileMetadata(current, "new-session", file, 25);

    assert.equal(current.activeSessionId, "new-session");
    assert.deepEqual(current.deletedSessionIds, ["other-deleted"]);
    assert.deepEqual(current.sessions, [
      {
        id: "new-session",
        title: "New Session",
        createdAt: 25,
        updatedAt: 25,
        messages: [],
        files: [file]
      }
    ]);
  });

  it("updates an existing session without duplicating file metadata", () => {
    const current = state();
    current.sessions.push({
      id: "existing",
      title: "Existing",
      createdAt: 1,
      updatedAt: 2,
      messages: [],
      files: [{ id: "file-1", storageKey: "old/blob" }]
    });
    const replacement = { id: "file-1", storageKey: "new/blob" };

    applyUploadedSessionFileMetadata(current, "existing", replacement, 30);

    assert.deepEqual(current.sessions[0].files, [replacement]);
    assert.equal(current.sessions[0].updatedAt, 30);
  });
});

describe("session file upload transaction", () => {
  it("rejects a pre-existing tombstone before writing a blob", async () => {
    const events: string[] = [];
    const current = state(["deleted"]);

    await assert.rejects(
      runSessionFileUploadTransaction({
        assertUploadAllowed: () => {
          events.push("preflight");
          assertSessionFileUploadAllowed(current, "deleted");
        },
        storeBlob: () => {
          events.push("store");
          return { storageKey: "deleted/blob" };
        },
        createFile: () => ({ id: "file-1" }),
        persistMetadata: () => {
          events.push("metadata");
        },
        rollbackBlob: () => {
          events.push("rollback");
        }
      }),
      TombstonedSessionUploadError
    );
    assert.deepEqual(events, ["preflight"]);
  });

  it("rolls back a blob when deletion wins the metadata race", async () => {
    const events: string[] = [];
    const current = state();

    await assert.rejects(
      runSessionFileUploadTransaction({
        assertUploadAllowed: () =>
          assertSessionFileUploadAllowed(current, "session-1"),
        storeBlob: () => {
          events.push("store");
          current.deletedSessionIds.push("session-1");
          return { storageKey: "session-1/blob" };
        },
        createFile: (stored) => ({ id: "file-1", ...stored }),
        persistMetadata: (file) => {
          events.push("metadata");
          applyUploadedSessionFileMetadata(current, "session-1", file, 10);
        },
        rollbackBlob: (stored) => {
          events.push(`rollback:${stored.storageKey}`);
        }
      }),
      TombstonedSessionUploadError
    );
    assert.deepEqual(events, [
      "store",
      "metadata",
      "rollback:session-1/blob"
    ]);
    assert.deepEqual(current.sessions, []);
  });

  it("rolls back a blob when metadata persistence fails", async () => {
    const metadataError = new Error("sqlite write failed");
    const events: string[] = [];

    await assert.rejects(
      runSessionFileUploadTransaction({
        assertUploadAllowed: () => undefined,
        storeBlob: () => {
          events.push("store");
          return { storageKey: "session-1/blob" };
        },
        createFile: (stored) => ({ id: "file-1", ...stored }),
        persistMetadata: () => {
          events.push("metadata");
          throw metadataError;
        },
        rollbackBlob: (stored) => {
          events.push(`rollback:${stored.storageKey}`);
        }
      }),
      metadataError
    );
    assert.deepEqual(events, [
      "store",
      "metadata",
      "rollback:session-1/blob"
    ]);
  });

  it("keeps a successful blob after its metadata is durable", async () => {
    const events: string[] = [];

    const file = await runSessionFileUploadTransaction({
      assertUploadAllowed: () => {
        events.push("preflight");
      },
      storeBlob: () => {
        events.push("store");
        return { storageKey: "session-1/blob" };
      },
      createFile: (stored) => ({ id: "file-1", ...stored }),
      persistMetadata: () => {
        events.push("metadata");
      },
      rollbackBlob: () => {
        events.push("rollback");
      }
    });

    assert.deepEqual(file, {
      id: "file-1",
      storageKey: "session-1/blob"
    });
    assert.deepEqual(events, ["preflight", "store", "metadata"]);
  });

  it("preserves both failures when blob rollback also fails", async () => {
    const metadataFailure = new Error("metadata failed");
    const rollbackFailure = new Error("rollback failed");

    await assert.rejects(
      runSessionFileUploadTransaction({
        assertUploadAllowed: () => undefined,
        storeBlob: () => ({ storageKey: "session/blob" }),
        createFile: (stored) => ({ id: "file-1", ...stored }),
        persistMetadata: () => {
          throw metadataFailure;
        },
        rollbackBlob: () => {
          throw rollbackFailure;
        }
      }),
      (error: unknown) => {
        assert.ok(error instanceof SessionFileUploadRollbackError);
        assert.equal(error.uploadError, metadataFailure);
        assert.equal(error.rollbackError, rollbackFailure);
        return true;
      }
    );
  });
});

describe("session file deletion transaction", () => {
  it("deduplicates and deletes blobs before committing metadata", async () => {
    const events: string[] = [];

    const deleted = await runSessionFileDeletionTransaction({
      prepare: () => ({
        storageKeys: ["session/blob-a", "session/blob-a", "session/blob-b"],
        persistMetadata: () => {
          events.push("metadata");
        }
      }),
      deleteBlob: (storageKey) => {
        events.push(`delete:${storageKey}`);
      }
    });

    assert.equal(deleted, 2);
    assert.deepEqual(events, [
      "delete:session/blob-a",
      "delete:session/blob-b",
      "metadata"
    ]);
  });

  it("does not discard metadata when a blob delete fails", async () => {
    const deleteFailure = new Error("rm failed");
    let metadataWrites = 0;

    await assert.rejects(
      runSessionFileDeletionTransaction({
        prepare: () => ({
          storageKeys: ["session/blob"],
          persistMetadata: () => {
            metadataWrites += 1;
          }
        }),
        deleteBlob: () => {
          throw deleteFailure;
        }
      }),
      deleteFailure
    );
    assert.equal(metadataWrites, 0);
  });

  it("can retry after metadata persistence fails because blob deletion is idempotent", async () => {
    const metadataFailure = new Error("database write failed");
    const events: string[] = [];
    let metadataAttempts = 0;
    const run = () =>
      runSessionFileDeletionTransaction({
        prepare: () => ({
          storageKeys: ["session/blob"],
          persistMetadata: () => {
            metadataAttempts += 1;
            events.push(`metadata:${metadataAttempts}`);
            if (metadataAttempts === 1) {
              throw metadataFailure;
            }
          }
        }),
        deleteBlob: (storageKey) => {
          events.push(`delete:${storageKey}`);
        }
      });

    await assert.rejects(run(), metadataFailure);
    await run();

    assert.deepEqual(events, [
      "delete:session/blob",
      "metadata:1",
      "delete:session/blob",
      "metadata:2"
    ]);
  });
});
