import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createGenerationActivityCoordinator } from "./generationActivityCoordinator";

function setup() {
  const busyChanges: boolean[] = [];
  const coordinator = createGenerationActivityCoordinator({
    onBusyChange: (busy) => busyChanges.push(busy)
  });
  return { coordinator, busyChanges };
}

describe("generation activity coordinator", () => {
  it("blocks a same-tick local start after chat reserves activity", () => {
    const { coordinator, busyChanges } = setup();

    assert.ok(coordinator.tryAcquireChatRun("chat-a"));
    assert.equal(coordinator.tryAcquireLocal("local-a"), undefined);
    assert.deepEqual(coordinator.getSnapshot(), {
      busy: true,
      chatRunCount: 1,
      localOwnerId: null
    });
    assert.deepEqual(busyChanges, [true]);
  });

  it("blocks a same-tick chat start after local acquires activity", () => {
    const { coordinator, busyChanges } = setup();
    const lease = coordinator.tryAcquireLocal("local-a");
    assert.ok(lease);

    assert.equal(coordinator.tryAcquireChatRun("chat-a"), undefined);
    assert.deepEqual(coordinator.getSnapshot(), {
      busy: true,
      chatRunCount: 0,
      localOwnerId: "local-a"
    });
    lease.release();
    assert.equal(coordinator.isBusy(), false);
    assert.deepEqual(busyChanges, [true, false]);
  });

  it("does not let an old chat finally clear a newer local lease", () => {
    const { coordinator, busyChanges } = setup();
    assert.ok(coordinator.tryAcquireChatRun("chat-a"));
    assert.equal(coordinator.finishChatRun("chat-a"), true);
    const localLease = coordinator.tryAcquireLocal("local-b");
    assert.ok(localLease);

    assert.equal(coordinator.finishChatRun("chat-a"), false);
    assert.equal(coordinator.getSnapshot().localOwnerId, "local-b");
    assert.equal(coordinator.isBusy(), true);
    localLease.release();
    assert.deepEqual(busyChanges, [true, false, true, false]);
  });

  it("keeps multiple restored runs busy until all have completed", () => {
    const { coordinator, busyChanges } = setup();

    assert.ok(coordinator.registerRestoredChatRun("restored-a"));
    assert.ok(coordinator.registerRestoredChatRun("restored-b"));
    assert.equal(coordinator.registerRestoredChatRun("restored-a"), undefined);
    assert.equal(coordinator.finishChatRun("restored-a"), true);
    assert.equal(coordinator.isBusy(), true);
    assert.equal(coordinator.getSnapshot().chatRunCount, 1);
    assert.equal(coordinator.finishChatRun("restored-b"), true);
    assert.equal(coordinator.isBusy(), false);
    assert.deepEqual(busyChanges, [true, false]);
  });

  it("preserves busy when restored chat and local activity overlap", () => {
    const { coordinator, busyChanges } = setup();
    const localLease = coordinator.tryAcquireLocal("local-a");
    assert.ok(localLease);
    assert.ok(coordinator.registerRestoredChatRun("restored-a"));

    localLease.release();
    assert.equal(coordinator.isBusy(), true);
    assert.deepEqual(coordinator.getSnapshot(), {
      busy: true,
      chatRunCount: 1,
      localOwnerId: null
    });
    assert.deepEqual(busyChanges, [true]);
    coordinator.finishChatRun("restored-a");
    assert.deepEqual(busyChanges, [true, false]);
  });

  it("makes lease release idempotent and reset reusable", () => {
    const { coordinator, busyChanges } = setup();
    const lease = coordinator.tryAcquireLocal("local-a");
    assert.ok(lease);
    lease.release();
    lease.release();
    coordinator.reset();

    assert.ok(coordinator.tryAcquireChatRun("chat-b"));
    assert.deepEqual(busyChanges, [true, false, true]);
  });

  it("releases a busy state when reset and remains reusable", () => {
    const { coordinator, busyChanges } = setup();
    assert.ok(coordinator.tryAcquireChatRun("chat-a"));

    coordinator.reset();

    assert.equal(coordinator.isBusy(), false);
    assert.deepEqual(busyChanges, [true, false]);
    assert.ok(coordinator.tryAcquireLocal("local-b"));
    assert.deepEqual(busyChanges, [true, false, true]);
  });

  it("lets a chat reservation release after synchronous setup failure", () => {
    const { coordinator, busyChanges } = setup();
    const lease = coordinator.tryAcquireChatRun("chat-a");
    assert.ok(lease);

    assert.throws(() => {
      try {
        throw new Error("setup failed");
      } finally {
        lease.release();
      }
    }, /setup failed/);

    assert.equal(coordinator.isBusy(), false);
    assert.equal(coordinator.getSnapshot().chatRunCount, 0);
    assert.deepEqual(busyChanges, [true, false]);
  });

  it("does not let an old lease release a reused run id", () => {
    const { coordinator, busyChanges } = setup();
    const firstLease = coordinator.tryAcquireChatRun("shared-run");
    assert.ok(firstLease);
    assert.equal(coordinator.finishChatRun("shared-run"), true);
    const secondLease = coordinator.registerRestoredChatRun("shared-run");
    assert.ok(secondLease);

    firstLease.release();

    assert.equal(coordinator.isBusy(), true);
    assert.equal(coordinator.getSnapshot().chatRunCount, 1);
    secondLease.release();
    assert.equal(coordinator.isBusy(), false);
    assert.deepEqual(busyChanges, [true, false, true, false]);
  });

  it("does not let a pre-reset lease clear the same restored run id", () => {
    const { coordinator, busyChanges } = setup();
    const oldLease = coordinator.tryAcquireChatRun("shared-run");
    assert.ok(oldLease);
    coordinator.reset();
    const restoredLease = coordinator.registerRestoredChatRun("shared-run");
    assert.ok(restoredLease);

    oldLease.release();

    assert.equal(coordinator.isBusy(), true);
    assert.equal(coordinator.getSnapshot().chatRunCount, 1);
    restoredLease.release();
    assert.deepEqual(busyChanges, [true, false, true, false]);
  });

  it("does not let a pre-reset local lease clear a reused owner id", () => {
    const { coordinator } = setup();
    const oldLease = coordinator.tryAcquireLocal("shared-owner");
    assert.ok(oldLease);
    coordinator.reset();
    const currentLease = coordinator.tryAcquireLocal("shared-owner");
    assert.ok(currentLease);

    oldLease.release();

    assert.equal(coordinator.isBusy(), true);
    assert.equal(
      coordinator.getSnapshot().localOwnerId,
      "shared-owner"
    );
    currentLease.release();
    assert.equal(coordinator.isBusy(), false);
  });
});
