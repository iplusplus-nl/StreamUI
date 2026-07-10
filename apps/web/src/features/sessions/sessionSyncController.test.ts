import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ChatSession,
  SessionState
} from "../../domain/chat/sessionModel";
import {
  runInitialSessionLoad,
  runSessionPoll,
  type SessionStateUpdater,
  type SessionSyncDependencies
} from "./sessionSyncController";

function session(
  id: string,
  updatedAt: number,
  content?: string
): ChatSession {
  return {
    id,
    title: content ?? "New Session",
    createdAt: updatedAt,
    updatedAt,
    messages: content
      ? [{ id: `message-${id}`, role: "user", content }]
      : [],
    files: []
  };
}

function state(activeSessionId: string, sessions: ChatSession[]): SessionState {
  return { activeSessionId, sessions };
}

function responseFor(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function stateUpdater(read: () => SessionState, write: (state: SessionState) => void) {
  const update: SessionStateUpdater = (updater) => {
    write(updater(read()));
  };
  return update;
}

function dependencies(
  overrides: Partial<SessionSyncDependencies>
): Partial<SessionSyncDependencies> {
  return {
    normalizeServerState: (payload) => payload as SessionState,
    loadLegacyState: () => null,
    now: () => 100,
    ...overrides
  };
}

describe("session sync controller", () => {
  it("applies initial data against the latest transient draft and tombstones", async () => {
    const pending = deferred<Response>();
    let current = state("initial", [session("initial", 1)]);
    let transientId: string | null = null;
    const deletedIds = new Set<string>();
    let requestedClientId = "";
    let hydrationSignals = 0;

    const loading = runInitialSessionLoad(
      {
        clientId: "client-1",
        isCancelled: () => false,
        updateState: stateUpdater(
          () => current,
          (next) => {
            current = next;
          }
        ),
        onApplied: () => {
          hydrationSignals += 1;
        },
        getDeletedSessionIds: () => deletedIds,
        getTransientEmptySessionId: () => transientId
      },
      dependencies({
        requestSessions: async (clientId) => {
          requestedClientId = clientId;
          return pending.promise;
        }
      })
    );

    current = state("draft", [session("draft", 5)]);
    transientId = "draft";
    deletedIds.add("remote-deleted");
    pending.resolve(
      responseFor(
        state("remote-deleted", [
          session("remote-deleted", 4, "Deleted"),
          session("remote-kept", 3, "Kept")
        ])
      )
    );

    assert.equal(await loading, "applied");
    assert.equal(requestedClientId, "client-1");
    assert.equal(hydrationSignals, 1);
    assert.equal(current.activeSessionId, "draft");
    assert.deepEqual(
      current.sessions.map((item) => item.id),
      ["draft", "remote-kept"]
    );
  });

  it("reads legacy state only after a successful initial response", async () => {
    const legacy = state("legacy", [session("legacy", 2, "Legacy")]);
    let legacyReads = 0;
    let normalizedAt = 0;
    let current = state("current", [session("current", 1)]);

    await runInitialSessionLoad(
      {
        clientId: "client-1",
        isCancelled: () => false,
        updateState: stateUpdater(
          () => current,
          (next) => {
            current = next;
          }
        ),
        getDeletedSessionIds: () => [],
        getTransientEmptySessionId: () => null
      },
      dependencies({
        requestSessions: async () =>
          responseFor(state("server", [session("server", 1)])),
        normalizeServerState: (payload, now) => {
          normalizedAt = now;
          return payload as SessionState;
        },
        loadLegacyState: () => {
          legacyReads += 1;
          return legacy;
        },
        now: () => 42
      })
    );

    assert.equal(legacyReads, 1);
    assert.equal(normalizedAt, 42);
    assert.equal(current, legacy);
  });

  it("suppresses cancelled initial results before normalize and update", async () => {
    let normalized = false;
    let updated = false;
    let hydrationSignals = 0;

    const outcome = await runInitialSessionLoad(
      {
        clientId: "client-1",
        isCancelled: () => true,
        updateState: () => {
          updated = true;
        },
        onApplied: () => {
          hydrationSignals += 1;
        },
        getDeletedSessionIds: () => [],
        getTransientEmptySessionId: () => null
      },
      dependencies({
        requestSessions: async () => responseFor({ sessions: [] }),
        normalizeServerState: () => {
          normalized = true;
          return state("unused", [session("unused", 1)]);
        }
      })
    );

    assert.equal(outcome, "cancelled");
    assert.equal(normalized, false);
    assert.equal(updated, false);
    assert.equal(hydrationSignals, 0);
  });

  it("skips a pending initial result when an attachment draft appears", async () => {
    const pending = deferred<Response>();
    let hasAttachmentDrafts = false;
    let normalized = false;
    let updated = false;
    let hydrationSignals = 0;
    const loading = runInitialSessionLoad(
      {
        clientId: "client-1",
        isCancelled: () => false,
        updateState: () => {
          updated = true;
        },
        onApplied: () => {
          hydrationSignals += 1;
        },
        getDeletedSessionIds: () => [],
        getTransientEmptySessionId: () => null,
        hasAttachmentDrafts: () => hasAttachmentDrafts
      },
      dependencies({
        requestSessions: async () => pending.promise,
        normalizeServerState: () => {
          normalized = true;
          return state("server", [session("server", 1, "Server")]);
        }
      })
    );

    hasAttachmentDrafts = true;
    pending.resolve(responseFor(state("server", [session("server", 1)])));

    assert.equal(await loading, "skipped");
    assert.equal(normalized, false);
    assert.equal(updated, false);
    assert.equal(hydrationSignals, 0);
  });

  it("surfaces initial and polling HTTP failures with their original messages", async () => {
    let hydrationSignals = 0;
    const common = {
      clientId: "client-1",
      isCancelled: () => false,
      updateState: (() => undefined) as SessionStateUpdater,
      onApplied: () => {
        hydrationSignals += 1;
      },
      getDeletedSessionIds: () => [] as string[],
      getTransientEmptySessionId: () => null
    };
    const failing = dependencies({
      requestSessions: async () => responseFor({}, 503)
    });

    await assert.rejects(
      runInitialSessionLoad(common, failing),
      /Session load failed with HTTP 503\./
    );
    await assert.rejects(
      runSessionPoll(
        {
          ...common,
          getState: () => state("saved", [session("saved", 1, "Saved")]),
          hasActiveRuns: () => false,
          hasRecentCancellations: () => false
        },
        failing
      ),
      /Session sync failed with HTTP 503\./
    );
    assert.equal(hydrationSignals, 0);
  });

  it("skips a poll tick while any synchronization gate is active", async () => {
    const populated = state("saved", [session("saved", 1, "Saved")]);
    const emptyDraft = state("draft", [session("draft", 1)]);
    let requestCount = 0;
    let hydrationSignals = 0;
    const syncDependencies = dependencies({
      requestSessions: async () => {
        requestCount += 1;
        return responseFor(populated);
      }
    });

    const run = (
      current: SessionState,
      options: {
        transientId?: string | null;
        activeRuns?: boolean;
        cancellations?: boolean;
        attachments?: boolean;
      }
    ) =>
      runSessionPoll(
        {
          clientId: "client-1",
          isCancelled: () => false,
          getState: () => current,
          updateState: () => undefined,
          onApplied: () => {
            hydrationSignals += 1;
          },
          getDeletedSessionIds: () => [],
          getTransientEmptySessionId: () => options.transientId ?? null,
          hasActiveRuns: () => options.activeRuns ?? false,
          hasRecentCancellations: () => options.cancellations ?? false,
          hasAttachmentDrafts: () => options.attachments ?? false
        },
        syncDependencies
      );

    assert.equal(await run(populated, { activeRuns: true }), "skipped");
    assert.equal(await run(populated, { cancellations: true }), "skipped");
    assert.equal(await run(populated, { attachments: true }), "skipped");
    assert.equal(await run(emptyDraft, { transientId: "draft" }), "skipped");
    assert.equal(requestCount, 0);
    assert.equal(hydrationSignals, 0);
  });

  it("does not apply an in-flight poll after an attachment draft appears", async () => {
    const pending = deferred<Response>();
    const current = state("local", [session("local", 1, "Local")]);
    let hasAttachmentDrafts = false;
    let updates = 0;
    let hydrationSignals = 0;
    const polling = runSessionPoll(
      {
        clientId: "client-1",
        isCancelled: () => false,
        getState: () => current,
        updateState: () => {
          updates += 1;
        },
        onApplied: () => {
          hydrationSignals += 1;
        },
        getDeletedSessionIds: () => [],
        getTransientEmptySessionId: () => null,
        hasActiveRuns: () => false,
        hasRecentCancellations: () => false,
        hasAttachmentDrafts: () => hasAttachmentDrafts
      },
      dependencies({ requestSessions: async () => pending.promise })
    );

    hasAttachmentDrafts = true;
    pending.resolve(
      responseFor(state("server", [session("server", 2, "Server")]))
    );

    assert.equal(await polling, "skipped");
    assert.equal(updates, 0);
    assert.equal(hydrationSignals, 0);
  });

  it("merges a pending poll with the latest state and tombstones", async () => {
    const pending = deferred<Response>();
    let current = state("local-a", [session("local-a", 1, "Local A")]);
    const deletedIds = new Set<string>();
    let activeRuns = false;
    let hydrationSignals = 0;

    const polling = runSessionPoll(
      {
        clientId: "client-1",
        isCancelled: () => false,
        getState: () => current,
        updateState: stateUpdater(
          () => current,
          (next) => {
            current = next;
          }
        ),
        onApplied: () => {
          hydrationSignals += 1;
        },
        getDeletedSessionIds: () => deletedIds,
        getTransientEmptySessionId: () => null,
        hasActiveRuns: () => activeRuns,
        hasRecentCancellations: () => false
      },
      dependencies({ requestSessions: async () => pending.promise })
    );

    current = state("local-b", [
      session("local-a", 1, "Local A"),
      session("local-b", 5, "Local B")
    ]);
    deletedIds.add("remote");
    activeRuns = true;
    pending.resolve(responseFor(state("remote", [session("remote", 4, "Remote")])));

    assert.equal(await polling, "applied");
    assert.equal(current.sessions.some((item) => item.id === "local-b"), true);
    assert.equal(current.sessions.some((item) => item.id === "remote"), false);
    assert.equal(hydrationSignals, 1);
  });

  it("normalizes but does not apply a cancelled poll response", async () => {
    let normalized = false;
    let updated = false;
    let hydrationSignals = 0;

    const outcome = await runSessionPoll(
      {
        clientId: "client-1",
        isCancelled: () => true,
        getState: () => state("saved", [session("saved", 1, "Saved")]),
        updateState: () => {
          updated = true;
        },
        onApplied: () => {
          hydrationSignals += 1;
        },
        getDeletedSessionIds: () => [],
        getTransientEmptySessionId: () => null,
        hasActiveRuns: () => false,
        hasRecentCancellations: () => false
      },
      dependencies({
        requestSessions: async () => responseFor({ sessions: [] }),
        normalizeServerState: () => {
          normalized = true;
          return state("server", [session("server", 2, "Server")]);
        }
      })
    );

    assert.equal(outcome, "cancelled");
    assert.equal(normalized, true);
    assert.equal(updated, false);
    assert.equal(hydrationSignals, 0);
  });

  it("allows overlapping polls and preserves the current reference for equal data", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const current = state("saved", [session("saved", 1, "Saved")]);
    let stateValue = current;
    let requestCount = 0;
    let updateCount = 0;
    const requestQueue = [first, second];
    const input = {
      clientId: "client-1",
      isCancelled: () => false,
      getState: () => stateValue,
      updateState: ((updater: (value: SessionState) => SessionState) => {
        updateCount += 1;
        stateValue = updater(stateValue);
      }) as SessionStateUpdater,
      getDeletedSessionIds: () => [],
      getTransientEmptySessionId: () => null,
      hasActiveRuns: () => false,
      hasRecentCancellations: () => false
    };
    const syncDependencies = dependencies({
      requestSessions: async () => requestQueue[requestCount++].promise
    });

    const firstPoll = runSessionPoll(input, syncDependencies);
    const secondPoll = runSessionPoll(input, syncDependencies);
    assert.equal(requestCount, 2);

    second.resolve(responseFor(structuredClone(current)));
    first.resolve(responseFor(structuredClone(current)));
    assert.deepEqual(await Promise.all([firstPoll, secondPoll]), [
      "applied",
      "applied"
    ]);
    assert.equal(updateCount, 2);
    assert.equal(stateValue, current);
  });
});
