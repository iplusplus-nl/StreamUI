import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { resolveClientSessionSave } from "./sessionSavePolicy.js";
import type { StoredSessionState } from "./sessionStateTypes.js";

const repositoryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "chathtml-session-repository-")
);
const repositoryDatabasePath = path.join(repositoryDirectory, "state.sqlite");
process.env.STREAMUI_SESSION_DB = repositoryDatabasePath;
process.env.STREAMUI_SESSION_DIR = repositoryDirectory;

const {
  closeSessionRepository,
  enqueueSessionRepositoryOperation,
  readAllSessionStateEntries,
  readSessionState,
  writeSessionState
} = await import("./sessionRepository.js");

after(async () => {
  await closeSessionRepository();
  await rm(repositoryDirectory, { recursive: true, force: true });
});

function state(content: string, revision: number): StoredSessionState {
  return {
    sessions: [
      {
        id: "active",
        title: content,
        createdAt: 1,
        updatedAt: revision,
        messages: [{ id: "user-1", role: "user", content }],
        files: []
      }
    ],
    activeSessionId: "active",
    clientSaveRevisions: { "client-one": revision }
  };
}

describe("session repository queue", () => {
  it("serializes operations and continues after a rejected operation", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = enqueueSessionRepositoryOperation(async () => {
      events.push("first:start");
      await firstGate;
      events.push("first:end");
      return 1;
    });
    const second = enqueueSessionRepositoryOperation(async () => {
      events.push("second");
      throw new Error("expected rejection");
    });
    const third = enqueueSessionRepositoryOperation(async () => {
      events.push("third");
      return 3;
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events, ["first:start"]);
    releaseFirst();

    assert.equal(await first, 1);
    await assert.rejects(second, /expected rejection/);
    assert.equal(await third, 3);
    assert.deepEqual(events, ["first:start", "first:end", "second", "third"]);
  });

  it("keeps a newer queued revision when an older network request arrives later", async () => {
    let stored = state("initial", 10);

    const newer = enqueueSessionRepositoryOperation(async () => {
      stored = resolveClientSessionSave({
        current: stored,
        incoming: state("page-exit", 12),
        clientId: "client-one",
        saveRevision: 12
      }).state;
    });
    const older = enqueueSessionRepositoryOperation(async () => {
      stored = resolveClientSessionSave({
        current: stored,
        incoming: state("late-fetch", 11),
        clientId: "client-one",
        saveRevision: 11
      }).state;
    });

    await Promise.all([newer, older]);
    assert.equal(stored.sessions[0].messages[0].content, "page-exit");
    assert.equal(stored.clientSaveRevisions?.["client-one"], 12);
  });

  it("rejects a corrupt SQLite row without replacing its stored value", async () => {
    await readSessionState("schema-seed");

    const [{ open }, sqlite3] = await Promise.all([
      import("sqlite"),
      import("sqlite3")
    ]);
    const driver = sqlite3.default?.Database ?? sqlite3.Database;
    const corruptValue = '{"sessions":';
    const corruptUpdatedAt = 123_456;
    const corruptKey = "corrupt-session";
    const db = await open({ filename: repositoryDatabasePath, driver });
    try {
      await db.run(
        `
          INSERT INTO streamui_state (key, value, updated_at)
          VALUES (?, ?, ?)
        `,
        corruptKey,
        corruptValue,
        corruptUpdatedAt
      );
    } finally {
      await db.close();
    }

    await assert.rejects(readSessionState(corruptKey), SyntaxError);

    const verificationDb = await open({
      filename: repositoryDatabasePath,
      driver
    });
    try {
      const row = (await verificationDb.get(
        "SELECT value, updated_at FROM streamui_state WHERE key = ?",
        corruptKey
      )) as { value: string; updated_at: number } | undefined;
      assert.deepEqual(row, {
        value: corruptValue,
        updated_at: corruptUpdatedAt
      });
    } finally {
      await verificationDb.close();
    }
  });

  it("rejects corrupt legacy JSON without creating an empty global row", async () => {
    await readSessionState("legacy-schema-seed");
    await writeFile(
      path.join(repositoryDirectory, "state.json"),
      '{"sessions":',
      "utf8"
    );

    await assert.rejects(readSessionState(), SyntaxError);

    const [{ open }, sqlite3] = await Promise.all([
      import("sqlite"),
      import("sqlite3")
    ]);
    const driver = sqlite3.default?.Database ?? sqlite3.Database;
    const verificationDb = await open({
      filename: repositoryDatabasePath,
      driver
    });
    try {
      const row = await verificationDb.get(
        "SELECT value FROM streamui_state WHERE key = ?",
        "global"
      );
      assert.equal(row, undefined);
    } finally {
      await verificationDb.close();
    }
  });

  it("lists every tenant state with its key and version", async () => {
    await writeSessionState(state("first account", 21), "user:first");
    await writeSessionState(state("second account", 22), "user:second");

    const entries = await readAllSessionStateEntries();
    const first = entries.find((entry) => entry.stateKey === "user:first");
    const second = entries.find((entry) => entry.stateKey === "user:second");

    assert.equal(first?.state.sessions[0]?.title, "first account");
    assert.equal(second?.state.sessions[0]?.title, "second account");
    assert.equal(Number.isFinite(first?.version), true);
    assert.equal(Number.isFinite(second?.version), true);
  });
});
