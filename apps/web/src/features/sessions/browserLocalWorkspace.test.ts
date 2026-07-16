import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BROWSER_LOCAL_WORKSPACE_STORAGE_KEY,
  browserLocalWorkspaceSignature,
  browserLocalWorkspaceStorageVersion,
  clearBrowserLocalWorkspace,
  clearBrowserLocalWorkspaceIfUnchanged,
  createBrowserLocalSessionFile,
  loadBrowserLocalWorkspace,
  requestBrowserLocalWorkspace,
  saveBrowserLocalWorkspace
} from "./browserLocalWorkspace";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key)
  };
}

describe("browser-only workspace", () => {
  it("persists sessions under a separate non-legacy key", async () => {
    const storage = memoryStorage();
    const payload = JSON.stringify({
      clientId: "client-local",
      saveRevision: 12,
      sessions: [{ id: "local-session" }],
      activeSessionId: "local-session"
    });
    const response = await saveBrowserLocalWorkspace(payload, storage);

    assert.equal(response.ok, true);
    assert.equal(
      storage.getItem(BROWSER_LOCAL_WORKSPACE_STORAGE_KEY),
      payload
    );
    assert.equal(storage.getItem("streamui.sessions.v1"), null);
    assert.equal(await (await requestBrowserLocalWorkspace(storage)).text(), payload);
  });

  it("keeps local image content inside the browser file record", () => {
    const file = createBrowserLocalSessionFile({
      kind: "image",
      name: "photo.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,AAAA",
      width: 20,
      height: 10
    });
    assert.equal(file.kind, "image");
    assert.equal(file.dataUrl, "data:image/png;base64,AAAA");
    assert.equal(file.width, 20);
  });

  it("discovers meaningful local sessions and can clear them after import", () => {
    const storage = memoryStorage();
    storage.setItem(
      BROWSER_LOCAL_WORKSPACE_STORAGE_KEY,
      JSON.stringify({
        activeSessionId: "empty",
        sessions: [
          {
            id: "empty",
            title: "New Session",
            createdAt: 1,
            updatedAt: 1,
            messages: [],
            files: []
          },
          {
            id: "kept",
            title: "Kept",
            createdAt: 2,
            updatedAt: 3,
            messages: [{ id: "m1", role: "user", content: "hello" }],
            files: []
          }
        ]
      })
    );

    const state = loadBrowserLocalWorkspace(storage);
    assert.deepEqual(state?.sessions.map((session) => session.id), ["kept"]);
    assert.equal(state?.activeSessionId, "kept");
    assert.match(browserLocalWorkspaceSignature(state!), /^v2:\d+:[a-f0-9]{16}$/);

    clearBrowserLocalWorkspace(storage);
    assert.equal(loadBrowserLocalWorkspace(storage), null);
  });

  it("fingerprints content changes even when session timestamps do not change", () => {
    const original = {
      activeSessionId: "kept",
      sessions: [
        {
          id: "kept",
          title: "Kept",
          createdAt: 1,
          updatedAt: 2,
          messages: [{ id: "m1", role: "user" as const, content: "first" }],
          files: []
        }
      ]
    };
    const changed = {
      ...original,
      sessions: [
        {
          ...original.sessions[0],
          messages: [{ id: "m1", role: "user" as const, content: "second" }]
        }
      ]
    };

    assert.notEqual(
      browserLocalWorkspaceSignature(original),
      browserLocalWorkspaceSignature(changed)
    );
  });

  it("clears only the exact browser workspace version that was imported", () => {
    const storage = memoryStorage();
    const original = JSON.stringify({
      activeSessionId: "kept",
      sessions: [
        {
          id: "kept",
          title: "Kept",
          createdAt: 1,
          updatedAt: 2,
          messages: [{ id: "m1", role: "user", content: "first" }],
          files: []
        }
      ]
    });
    storage.setItem(BROWSER_LOCAL_WORKSPACE_STORAGE_KEY, original);
    const expected = browserLocalWorkspaceStorageVersion(storage);

    storage.setItem(
      BROWSER_LOCAL_WORKSPACE_STORAGE_KEY,
      original.replace("first", "changed in another tab")
    );
    assert.equal(
      clearBrowserLocalWorkspaceIfUnchanged(expected, storage),
      false
    );
    assert.notEqual(storage.getItem(BROWSER_LOCAL_WORKSPACE_STORAGE_KEY), null);

    assert.equal(
      clearBrowserLocalWorkspaceIfUnchanged(
        browserLocalWorkspaceStorageVersion(storage),
        storage
      ),
      true
    );
    assert.equal(storage.getItem(BROWSER_LOCAL_WORKSPACE_STORAGE_KEY), null);
  });
});
