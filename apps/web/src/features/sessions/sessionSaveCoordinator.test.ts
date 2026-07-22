import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ChatSession,
  SessionState
} from "../../domain/chat/sessionModel";
import {
  createSessionSaveCoordinator,
  type SessionSaveCoordinator,
  type SessionSaveDependencies,
  type SessionSaveScheduler,
  type SessionSaveStatus
} from "./sessionSaveCoordinator";
import {
  nextSessionSaveRevision,
  type SessionStorage
} from "./sessionPersistence";

function session(id: string, content = id): ChatSession {
  return {
    id,
    title: content,
    createdAt: 1,
    updatedAt: 1,
    messages: [{ id: `message-${id}`, role: "user", content }],
    files: []
  };
}

function state(id: string): SessionState {
  return { activeSessionId: id, sessions: [session(id)] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function drainAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type ScheduledTask = {
  delayMs: number;
  task: () => Promise<void>;
  cancelled: boolean;
};

function fakeScheduler(tasks: ScheduledTask[]): SessionSaveScheduler {
  return {
    schedule: (delayMs, task) => {
      const scheduled = { delayMs, task, cancelled: false };
      tasks.push(scheduled);
      return () => {
        scheduled.cancelled = true;
      };
    }
  };
}

function serialized(
  value: SessionState,
  clientId: string,
  deletedSessionIds: string[],
  saveRevision?: number
): string {
  return JSON.stringify({
    activeSessionId: value.activeSessionId,
    clientId,
    ...(saveRevision === undefined ? {} : { saveRevision }),
    deletedSessionIds
  });
}

function createHarness(options: {
  persist?: SessionSaveDependencies["persist"];
  flush?: SessionSaveDependencies["flush"];
  nextRevision?: SessionSaveDependencies["nextRevision"];
  observeRevision?: SessionSaveDependencies["observeRevision"];
  persistTimeoutMs?: number;
  now?: () => number;
}) {
  let loaded = true;
  let current = state("session-a");
  let clientId = "client-1";
  const deletedIds = new Set<string>();
  const tasks: ScheduledTask[] = [];
  const persistCalls: Array<{
    payload: string;
    clientId: string;
    signal?: AbortSignal;
  }> = [];
  const flushCalls: Array<{ payload: string; clientId: string }> = [];
  const warnings: unknown[] = [];
  const statuses: SessionSaveStatus[] = [];
  const controllers: AbortController[] = [];
  let clearLegacyCount = 0;
  let revision = 0;

  const persist: SessionSaveDependencies["persist"] = async (
    payload,
    requestedClientId,
    signal
  ) => {
    persistCalls.push({ payload, clientId: requestedClientId, signal });
    return options.persist
      ? options.persist(payload, requestedClientId, signal)
      : new Response(null, { status: 204 });
  };
  const flush: SessionSaveDependencies["flush"] = (
    payload,
    requestedClientId
  ) => {
    flushCalls.push({ payload, clientId: requestedClientId });
    options.flush?.(payload, requestedClientId);
  };

  const coordinator = createSessionSaveCoordinator(
    {
      isLoaded: () => loaded,
      getLatestState: () => current,
      getClientId: () => clientId,
      getDeletedSessionIds: () => deletedIds
    },
    350,
    {
      serialize: serialized,
      nextRevision: options.nextRevision ?? (() => ++revision),
      observeRevision:
        options.observeRevision ??
        ((_clientId, observedRevision) => {
          revision = Math.max(revision, observedRevision);
        }),
      persist,
      flush,
      clearLegacy: () => {
        clearLegacyCount += 1;
      },
      warn: (error) => warnings.push(error),
      onStatusChange: (status) => statuses.push(status),
      scheduler: fakeScheduler(tasks),
      persistTimeoutMs: options.persistTimeoutMs ?? 15_000,
      createAbortController: () => {
        const controller = new AbortController();
        controllers.push(controller);
        return controller;
      },
      now: options.now ?? Date.now
    }
  );

  return {
    coordinator,
    tasks,
    persistCalls,
    flushCalls,
    warnings,
    statuses,
    controllers,
    deletedIds,
    setLoaded: (value: boolean) => {
      loaded = value;
    },
    setState: (value: SessionState) => {
      current = value;
    },
    setClientId: (value: string) => {
      clientId = value;
    },
    getClearLegacyCount: () => clearLegacyCount
  };
}

describe("session save coordinator", () => {
  it("skips autosave, saveNow, and exit flush while sessions are unloaded", async () => {
    const harness = createHarness({});
    harness.setLoaded(false);

    harness.coordinator.scheduleAutosave(state("render"), false)();

    assert.equal(await harness.coordinator.saveNow(), "skipped");
    assert.equal(harness.coordinator.flushPageExit(), "skipped");
    assert.equal(harness.tasks.length, 0);
    assert.equal(harness.persistCalls.length, 0);
    assert.equal(harness.flushCalls.length, 0);
  });

  it("starts a new coordinator above a persisted pre-reload watermark", async () => {
    const values = new Map([
      ["streamui.sessionSaveRevision.v1:client-1", "700000"]
    ]);
    const storage: SessionStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key)
    };
    const harness = createHarness({
      nextRevision: (clientId) =>
        nextSessionSaveRevision(clientId, storage, () => 100)
    });

    assert.equal(await harness.coordinator.saveNow(), "saved");
    assert.equal(JSON.parse(harness.persistCalls[0].payload).saveRevision, 700001);
    assert.deepEqual(harness.statuses, ["saving", "saved"]);
  });

  it("debounces a captured render snapshot while saveNow reads the latest refs", async () => {
    const harness = createHarness({});
    const renderState = state("render-a");

    harness.coordinator.scheduleAutosave(renderState, true);
    assert.equal(harness.tasks.length, 1);
    assert.equal(harness.tasks[0].delayMs, 350);
    assert.equal(harness.persistCalls.length, 0);

    harness.setState(state("latest-b"));
    harness.deletedIds.add("deleted-after-render");
    await harness.tasks[0].task();

    assert.deepEqual(JSON.parse(harness.persistCalls[0].payload), {
      activeSessionId: "render-a",
      clientId: "client-1",
      saveRevision: 1,
      deletedSessionIds: []
    });
    assert.ok(harness.persistCalls[0].signal instanceof AbortSignal);
    assert.equal(harness.getClearLegacyCount(), 1);

    assert.equal(await harness.coordinator.saveNow(), "saved");
    assert.deepEqual(JSON.parse(harness.persistCalls[1].payload), {
      activeSessionId: "latest-b",
      clientId: "client-1",
      saveRevision: 2,
      deletedSessionIds: ["deleted-after-render"]
    });
    assert.ok(harness.persistCalls[1].signal instanceof AbortSignal);
    assert.equal(harness.getClearLegacyCount(), 2);
  });

  it("cancels the previous timer and aborts an in-flight autosave", async () => {
    const pending = deferred<Response>();
    const harness = createHarness({ persist: async () => pending.promise });
    const cleanup = harness.coordinator.scheduleAutosave(state("first"), true);
    const saving = harness.tasks[0].task();
    await Promise.resolve();

    assert.equal(harness.controllers[0].signal.aborted, false);
    cleanup();
    assert.equal(harness.tasks[0].cancelled, false);
    assert.equal(harness.controllers[0].signal.aborted, true);

    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    pending.reject(abortError);
    await saving;
    assert.equal(harness.warnings.length, 0);

    harness.coordinator.scheduleAutosave(state("second"), true);
    harness.coordinator.scheduleAutosave(state("third"), true);
    assert.equal(harness.tasks[1].cancelled, true);
    assert.equal(harness.controllers[1].signal.aborted, true);
    assert.equal(harness.tasks.length, 3);
  });

  it("does not schedule a duplicate of the last acknowledged payload", async () => {
    const harness = createHarness({});
    const snapshot = state("same");
    harness.coordinator.scheduleAutosave(snapshot, true);
    await harness.tasks[0].task();

    assert.equal(harness.controllers[0].signal.aborted, false);
    harness.coordinator.scheduleAutosave(snapshot, true);

    assert.equal(harness.controllers[0].signal.aborted, false);
    assert.equal(harness.controllers.length, 1);
    assert.equal(harness.tasks.length, 1);
  });

  it("warns for autosave failures without acknowledging or clearing legacy", async () => {
    const harness = createHarness({
      persist: async () => new Response(null, { status: 500 })
    });
    harness.coordinator.scheduleAutosave(state("failed"), true);

    await harness.tasks[0].task();

    assert.equal(harness.warnings.length, 1);
    assert.match(String(harness.warnings[0]), /Session save failed with HTTP 500/);
    assert.deepEqual(harness.statuses, ["pending", "saving", "failed"]);
    assert.equal(harness.getClearLegacyCount(), 0);
    assert.equal(
      harness.coordinator.getDebugState().lastSavedPayload,
      null
    );
  });

  it("serializes concurrent saveNow calls so the newest snapshot persists last", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const responses = [first, second];
    let requestIndex = 0;
    const harness = createHarness({
      persist: async () => responses[requestIndex++].promise
    });

    harness.setState(state("older"));
    const olderSave = harness.coordinator.saveNow();
    harness.setState(state("newer"));
    const newerSave = harness.coordinator.saveNow();
    await Promise.resolve();
    assert.equal(harness.persistCalls.length, 1);

    first.resolve(new Response(null, { status: 204 }));
    assert.equal(await olderSave, "saved");
    await Promise.resolve();
    assert.equal(harness.persistCalls.length, 2);
    second.resolve(new Response(null, { status: 204 }));
    assert.equal(await newerSave, "saved");

    assert.deepEqual(
      JSON.parse(harness.coordinator.getDebugState().lastSavedPayload ?? "{}"),
      {
        activeSessionId: "newer",
        clientId: "client-1",
        saveRevision: 2,
        deletedSessionIds: []
      }
    );
  });

  it("cancels a pending stale autosave before saveNow persists the latest state", async () => {
    const harness = createHarness({});
    harness.coordinator.scheduleAutosave(state("stale"), true);
    harness.setState(state("latest"));

    assert.equal(await harness.coordinator.saveNow(), "saved");
    await harness.tasks[0].task();

    assert.equal(harness.tasks[0].cancelled, true);
    assert.equal(harness.controllers[0].signal.aborted, true);
    assert.equal(harness.persistCalls.length, 1);
    assert.deepEqual(JSON.parse(harness.persistCalls[0].payload), {
      activeSessionId: "latest",
      clientId: "client-1",
      saveRevision: 2,
      deletedSessionIds: []
    });
  });

  it("persists the final A in an A-to-B-to-A sequence while B is in flight", async () => {
    const inFlightB = deferred<Response>();
    let requestIndex = 0;
    const harness = createHarness({
      persist: async () => {
        requestIndex += 1;
        return requestIndex === 2
          ? inFlightB.promise
          : new Response(null, { status: 204 });
      }
    });

    harness.setState(state("A"));
    assert.equal(await harness.coordinator.saveNow(), "saved");

    harness.setState(state("B"));
    const savingB = harness.coordinator.saveNow();
    await Promise.resolve();
    assert.equal(harness.persistCalls.length, 2);

    harness.setState(state("A"));
    const revertingToA = harness.coordinator.saveNow();
    assert.equal(harness.persistCalls.length, 2);

    inFlightB.resolve(new Response(null, { status: 204 }));
    assert.equal(await savingB, "saved");
    assert.equal(await revertingToA, "saved");
    assert.equal(harness.persistCalls.length, 3);
    assert.deepEqual(
      JSON.parse(harness.coordinator.getDebugState().lastSavedPayload ?? "{}"),
      {
        activeSessionId: "A",
        clientId: "client-1",
        saveRevision: 3,
        deletedSessionIds: []
      }
    );
  });

  it("reuses a queued or in-flight save for the same content", async () => {
    const pending = deferred<Response>();
    const harness = createHarness({ persist: async () => pending.promise });
    harness.setState(state("same-active"));

    const firstSave = harness.coordinator.saveNow();
    const duplicateSave = harness.coordinator.saveNow();
    await Promise.resolve();

    assert.equal(harness.persistCalls.length, 1);
    pending.resolve(new Response(null, { status: 204 }));
    assert.equal(await firstSave, "saved");
    assert.equal(await duplicateSave, "saved");
    assert.equal(harness.getClearLegacyCount(), 1);
  });

  it("keeps a newer page-exit marker when an older request completes later", async () => {
    const inFlightB = deferred<Response>();
    const visibleRetry = deferred<Response>();
    let requestIndex = 0;
    const harness = createHarness({
      persist: async () => {
        requestIndex += 1;
        return requestIndex === 2
          ? inFlightB.promise
          : requestIndex === 3
            ? visibleRetry.promise
          : new Response(null, { status: 204 });
      }
    });

    harness.setState(state("A"));
    assert.equal(await harness.coordinator.saveNow(), "saved");
    harness.setState(state("B"));
    const savingB = harness.coordinator.saveNow();
    await Promise.resolve();

    harness.setState(state("A"));
    assert.equal(harness.coordinator.flushPageExit(), "flushed");
    assert.deepEqual(JSON.parse(harness.flushCalls[0].payload), {
      activeSessionId: "A",
      clientId: "client-1",
      saveRevision: 3,
      deletedSessionIds: []
    });
    const exitMarker = harness.coordinator.getDebugState().lastSavedPayload;
    assert.equal(harness.coordinator.flushPageExit(), "skipped");
    const retryAfterVisible = harness.coordinator.saveNow();
    assert.equal(harness.persistCalls.length, 2);

    inFlightB.resolve(new Response(null, { status: 204 }));
    assert.equal(await savingB, "saved");
    await Promise.resolve();
    assert.equal(
      harness.coordinator.getDebugState().lastSavedPayload,
      exitMarker
    );
    assert.equal(harness.persistCalls.length, 3);
    assert.deepEqual(JSON.parse(harness.persistCalls[2].payload), {
      activeSessionId: "A",
      clientId: "client-1",
      saveRevision: 4,
      deletedSessionIds: []
    });
    visibleRetry.resolve(new Response(null, { status: 204 }));
    assert.equal(await retryAfterVisible, "saved");
    assert.equal(harness.flushCalls.length, 1);
  });

  it("does not acknowledge an applied-false response and retries above its watermark", async () => {
    const staleResponse = deferred<Response>();
    let requestIndex = 0;
    const harness = createHarness({
      persist: async () => {
        requestIndex += 1;
        return requestIndex === 1
          ? staleResponse.promise
          : new Response(null, { status: 204 });
      }
    });
    harness.setState(state("stale-local"));
    const staleSave = harness.coordinator.saveNow();
    await Promise.resolve();
    harness.setState(state("newer-local"));
    staleResponse.resolve(
      Response.json({
        ok: true,
        applied: false,
        currentSaveRevision: 50
      })
    );

    assert.equal(await staleSave, "failed");
    assert.equal(harness.getClearLegacyCount(), 0);
    assert.equal(harness.coordinator.getDebugState().lastSavedPayload, null);

    assert.equal(await harness.coordinator.saveNow(), "saved");
    assert.deepEqual(
      harness.persistCalls.map((call) => JSON.parse(call.payload).saveRevision),
      [1, 51]
    );
    assert.equal(harness.getClearLegacyCount(), 1);
  });

  it("does not retry stale content after an applied-false response", async () => {
    const harness = createHarness({
      persist: async () =>
        Response.json({
          ok: true,
          applied: false,
          currentSaveRevision: 80
        })
    });
    harness.setState(state("retry-stale"));

    assert.equal(await harness.coordinator.saveNow(), "failed");
    assert.deepEqual(
      harness.persistCalls.map((call) => JSON.parse(call.payload).saveRevision),
      [1]
    );
    assert.equal(harness.getClearLegacyCount(), 0);
    assert.equal(harness.coordinator.getDebugState().lastSavedPayload, null);
  });

  it("does not let a stale coordinator turn rejected old content into a newer revision", async () => {
    const releaseOldRequest = deferred<void>();
    let issuedRevision = 0;
    let serverRevision = 0;
    let serverContent = "";
    const persist: SessionSaveDependencies["persist"] = async (payload) => {
      const parsed = JSON.parse(payload) as {
        activeSessionId: string;
        saveRevision: number;
      };
      if (parsed.activeSessionId === "OLD") {
        await releaseOldRequest.promise;
      }
      if (parsed.saveRevision <= serverRevision) {
        return Response.json({
          ok: true,
          applied: false,
          currentSaveRevision: serverRevision
        });
      }
      serverRevision = parsed.saveRevision;
      serverContent = parsed.activeSessionId;
      return Response.json({
        ok: true,
        applied: true,
        currentSaveRevision: serverRevision
      });
    };
    const revisionDependencies = {
      persist,
      nextRevision: () => ++issuedRevision,
      observeRevision: (_clientId: string, revision: number) => {
        issuedRevision = Math.max(issuedRevision, revision);
      }
    };
    const oldTab = createHarness(revisionDependencies);
    const newTab = createHarness(revisionDependencies);

    oldTab.setState(state("OLD"));
    const savingOld = oldTab.coordinator.saveNow();
    await Promise.resolve();
    newTab.setState(state("NEW"));
    assert.equal(await newTab.coordinator.saveNow(), "saved");
    assert.equal(serverRevision, 2);
    assert.equal(serverContent, "NEW");

    releaseOldRequest.resolve();
    assert.equal(await savingOld, "failed");
    assert.equal(serverRevision, 2);
    assert.equal(serverContent, "NEW");
    assert.equal(oldTab.persistCalls.length, 1);
    assert.equal(issuedRevision, 2);
  });

  it("times out a stuck persist so a newer queued save can proceed", async () => {
    let requestIndex = 0;
    const never = new Promise<Response>(() => undefined);
    const harness = createHarness({
      persistTimeoutMs: 5,
      persist: async () =>
        requestIndex++ === 0
          ? never
          : new Response(null, { status: 204 })
    });

    harness.setState(state("stuck"));
    const stuckSave = harness.coordinator.saveNow();
    harness.setState(state("newer-after-timeout"));
    const newerSave = harness.coordinator.saveNow();

    assert.equal(await stuckSave, "failed");
    assert.equal(await newerSave, "saved");
    assert.equal(harness.persistCalls.length, 2);
    assert.equal(harness.persistCalls[0].signal?.aborted, true);
    assert.equal(harness.warnings.length, 1);
  });

  it("allows the same content to retry after a failed save", async () => {
    let requestIndex = 0;
    const harness = createHarness({
      persist: async () =>
        new Response(null, { status: requestIndex++ === 0 ? 500 : 204 })
    });
    harness.setState(state("retry"));

    assert.equal(await harness.coordinator.saveNow(), "failed");
    assert.equal(await harness.coordinator.saveNow(), "saved");
    assert.equal(harness.persistCalls.length, 2);
    assert.deepEqual(
      harness.persistCalls.map((call) => JSON.parse(call.payload).saveRevision),
      [1, 2]
    );
  });

  it("honors Retry-After and retries a rate-limited save", async () => {
    let requestIndex = 0;
    const harness = createHarness({
      now: () => 10_000,
      persist: async () =>
        requestIndex++ === 0
          ? new Response(null, {
              status: 429,
              headers: { "Retry-After": "2" }
            })
          : new Response(null, { status: 204 })
    });
    harness.setState(state("rate-limited"));

    const saving = harness.coordinator.saveNow();
    await drainAsyncWork();

    assert.equal(harness.persistCalls.length, 1);
    assert.equal(harness.tasks.length, 1);
    assert.equal(harness.tasks[0].delayMs, 2_000);
    assert.deepEqual(harness.statuses, ["saving"]);
    assert.equal(harness.warnings.length, 0);

    await harness.tasks[0].task();
    assert.equal(await saving, "saved");
    assert.equal(harness.persistCalls.length, 2);
    assert.deepEqual(harness.statuses, ["saving", "saved"]);
    assert.equal(harness.warnings.length, 0);
  });

  it("uses exponential cooldown when a 429 response has no retry headers", async () => {
    let requestIndex = 0;
    const harness = createHarness({
      now: () => 20_000,
      persist: async () =>
        requestIndex++ < 2
          ? new Response(null, { status: 429 })
          : new Response(null, { status: 204 })
    });
    harness.setState(state("nginx-rate-limited"));

    const saving = harness.coordinator.saveNow();
    await drainAsyncWork();
    assert.equal(harness.tasks[0].delayMs, 1_000);

    await harness.tasks[0].task();
    await drainAsyncWork();
    assert.equal(harness.tasks[1].delayMs, 2_000);

    await harness.tasks[1].task();
    assert.equal(await saving, "saved");
    assert.equal(harness.persistCalls.length, 3);
    assert.equal(harness.warnings.length, 0);
  });

  it("aborts an autosave while it is waiting for a rate-limit cooldown", async () => {
    const harness = createHarness({
      now: () => 30_000,
      persist: async () => new Response(null, { status: 429 })
    });
    harness.coordinator.scheduleAutosave(state("rate-limited-autosave"), true);

    const autosaving = harness.tasks[0].task();
    await drainAsyncWork();
    assert.equal(harness.persistCalls.length, 1);
    assert.equal(harness.tasks[1].delayMs, 1_000);

    harness.coordinator.cancelAutosave();
    await autosaving;

    assert.equal(harness.tasks[1].cancelled, true);
    assert.equal(harness.persistCalls.length, 1);
    assert.equal(harness.warnings.length, 0);
  });

  it("skips an aborted queued autosave before it reaches persistence", async () => {
    const first = deferred<Response>();
    const harness = createHarness({ persist: async () => first.promise });

    harness.setState(state("manual"));
    const saving = harness.coordinator.saveNow();
    harness.coordinator.scheduleAutosave(state("stale-autosave"), true);
    const autosaving = harness.tasks[0].task();
    harness.coordinator.cancelAutosave();
    await Promise.resolve();
    assert.equal(harness.persistCalls.length, 1);

    first.resolve(new Response(null, { status: 204 }));
    assert.equal(await saving, "saved");
    await autosaving;
    assert.equal(harness.persistCalls.length, 1);
    assert.deepEqual(
      JSON.parse(harness.coordinator.getDebugState().lastSavedPayload ?? "{}"),
      {
        activeSessionId: "manual",
        clientId: "client-1",
        saveRevision: 1,
        deletedSessionIds: []
      }
    );
  });

  it("marks exit payloads before transport and deduplicates consecutive events", () => {
    let coordinator!: SessionSaveCoordinator;
    let markerSeenByTransport: string | null = null;
    const harness = createHarness({
      flush: () => {
        markerSeenByTransport = coordinator.getDebugState().lastSavedPayload;
      }
    });
    coordinator = harness.coordinator;
    harness.setState(state("exit"));
    harness.setClientId("client-exit");

    assert.equal(coordinator.flushPageExit(), "flushed");
    assert.equal(markerSeenByTransport, harness.flushCalls[0].payload);
    assert.equal(coordinator.flushPageExit(), "skipped");
    assert.equal(harness.flushCalls.length, 1);
    assert.equal(harness.getClearLegacyCount(), 0);
  });

  it("dispose clears a pending timer and aborts its controller", () => {
    const harness = createHarness({});
    harness.coordinator.scheduleAutosave(state("pending"), true);

    harness.coordinator.dispose();

    assert.equal(harness.tasks[0].cancelled, true);
    assert.equal(harness.controllers[0].signal.aborted, true);
    assert.equal(harness.coordinator.getDebugState().hasAutosave, false);
  });
});
