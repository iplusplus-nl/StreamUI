import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ActiveEphemeralFileDeletionError,
  cleanupReleasedEphemeralFiles,
  createActiveEphemeralFileRegistry
} from "./activeEphemeralFileRegistry.js";
import { finalizeChatRunTerminal } from "./chatRunFinalization.js";
import { runSessionFileDeletionTransaction } from "./sessionFileUploadSafety.js";

describe("active ephemeral file registry", () => {
  it("blocks deletion until every active run lease releases", () => {
    const registry = createActiveEphemeralFileRegistry();
    const registration = {
      stateKey: "client-a",
      sessionId: "session-1",
      storageKeys: ["session-1/render/blob.png"]
    };
    const first = registry.register(registration);
    const second = registry.register(registration);

    assert.throws(
      () =>
        registry.acquireDeletion([
          {
            stateKey: registration.stateKey,
            sessionId: registration.sessionId,
            storageKey: registration.storageKeys[0]
          }
        ]),
      ActiveEphemeralFileDeletionError
    );
    first.release();
    assert.equal(
      registry.isActive(
        registration.stateKey,
        registration.sessionId,
        registration.storageKeys[0]
      ),
      true
    );
    first.release();
    second.release();
    assert.equal(
      registry.isActive(
        registration.stateKey,
        registration.sessionId,
        registration.storageKeys[0]
      ),
      false
    );
  });

  it("isolates equal storage keys by state and session", () => {
    const registry = createActiveEphemeralFileRegistry();
    const lease = registry.register({
      stateKey: "client-a",
      sessionId: "session-a",
      storageKeys: ["shared/blob.png"]
    });

    assert.equal(registry.isActive("client-a", "session-a", "shared/blob.png"), true);
    assert.equal(registry.isActive("client-b", "session-a", "shared/blob.png"), false);
    assert.equal(registry.isActive("client-a", "session-b", "shared/blob.png"), false);
    lease.release();
  });

  it("prevents a lost-response client delete from committing metadata", async () => {
    const registry = createActiveEphemeralFileRegistry();
    const lease = registry.register({
      stateKey: "client-a",
      sessionId: "session-1",
      storageKeys: ["session-1/render/blob.png"]
    });
    let metadataWrites = 0;
    let blobDeletes = 0;
    const remove = () =>
      runSessionFileDeletionTransaction({
        prepare: () => ({
          storageKeys: ["session-1/render/blob.png"],
          persistMetadata: () => {
            metadataWrites += 1;
          }
        }),
        acquireDeletion: (storageKeys) =>
          registry.acquireDeletion(
            storageKeys.map((storageKey) => ({
              stateKey: "client-a",
              sessionId: "session-1",
              storageKey
            }))
          ),
        deleteBlob: () => {
          blobDeletes += 1;
        }
      });

    await assert.rejects(remove(), ActiveEphemeralFileDeletionError);
    assert.equal(blobDeletes, 0);
    assert.equal(metadataWrites, 0);

    lease.release();
    await remove();
    assert.equal(blobDeletes, 1);
    assert.equal(metadataWrites, 1);
  });

  it("lets only the last terminal run clean a shared ephemeral blob", async () => {
    const registry = createActiveEphemeralFileRegistry();
    const registration = {
      stateKey: "client-a",
      sessionId: "session-1",
      storageKeys: ["session-1/render/blob.png"]
    };
    const first = registry.register(registration);
    const second = registry.register(registration);
    const cleaned: string[] = [];
    const finalize = (lease: typeof first) =>
      finalizeChatRunTerminal({
        outcome: "complete",
        persistTerminalState: () => undefined,
        waitForExecution: () => undefined,
        cleanupEphemeralFiles: () =>
          cleanupReleasedEphemeralFiles(lease, (storageKeys) => {
            cleaned.push(...storageKeys);
          })
      });

    await finalize(first);
    assert.deepEqual(cleaned, []);
    assert.equal(
      registry.isActive(
        registration.stateKey,
        registration.sessionId,
        registration.storageKeys[0]
      ),
      true
    );

    await finalize(second);
    assert.deepEqual(cleaned, ["session-1/render/blob.png"]);
    assert.equal(
      registry.isActive(
        registration.stateKey,
        registration.sessionId,
        registration.storageKeys[0]
      ),
      false
    );
  });

  it("blocks a new run for the full asynchronous deletion transaction", async () => {
    const registry = createActiveEphemeralFileRegistry();
    const registration = {
      stateKey: "client-a",
      sessionId: "session-1",
      storageKeys: ["session-1/render/blob.png"]
    };
    let resolveDelete: () => void = () => {};
    const deletePending = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    let metadataWrites = 0;
    const deletion = runSessionFileDeletionTransaction({
      prepare: () => ({
        storageKeys: registration.storageKeys,
        persistMetadata: () => {
          metadataWrites += 1;
        }
      }),
      acquireDeletion: (storageKeys) =>
        registry.acquireDeletion(
          storageKeys.map((storageKey) => ({
            stateKey: registration.stateKey,
            sessionId: registration.sessionId,
            storageKey
          }))
        ),
      deleteBlob: () => deletePending
    });
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(
      registry.isDeletionReserved(
        registration.stateKey,
        registration.sessionId,
        registration.storageKeys[0]
      ),
      true
    );
    assert.throws(
      () => registry.register(registration),
      ActiveEphemeralFileDeletionError
    );
    assert.equal(metadataWrites, 0);

    resolveDelete();
    await deletion;
    assert.equal(metadataWrites, 1);
    assert.equal(
      registry.isDeletionReserved(
        registration.stateKey,
        registration.sessionId,
        registration.storageKeys[0]
      ),
      false
    );
    const nextRun = registry.register(registration);
    nextRun.release();
  });
});
