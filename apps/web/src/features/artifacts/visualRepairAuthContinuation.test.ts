import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPendingRequestSlot } from "../chat/pendingRequestSlot";
import type { StartVisualRepairInput } from "./visualRepairController";
import {
  replayPendingVisualRepair,
  startVisualRepairWithAuthContinuation
} from "./visualRepairAuthContinuation";

function request(sessionId = "session-1"): StartVisualRepairInput {
  return {
    sessionId,
    assistantId: "assistant-1",
    width: 900,
    snapshot: {
      raw: "<streamui><main>Artifact</main></streamui>",
      completedHtml: "<main>Artifact</main>",
      iframeDocument: "<html><main>Artifact</main></html>",
      errors: [],
      status: "complete"
    }
  };
}

describe("visual repair authentication continuation", () => {
  it("queues only authentication-required requests without copying them", async () => {
    const pending = createPendingRequestSlot<StartVisualRepairInput>();
    const input = request();

    assert.equal(
      await startVisualRepairWithAuthContinuation(
        input,
        async () => "authentication-required",
        pending
      ),
      "authentication-required"
    );
    assert.equal(pending.peek(), input);

    pending.clear();
    assert.equal(
      await startVisualRepairWithAuthContinuation(
        input,
        async () => "stale",
        pending
      ),
      "stale"
    );
    assert.equal(pending.peek(), null);
  });

  it("takes a pending request once and replays its exact target", async () => {
    const pending = createPendingRequestSlot<StartVisualRepairInput>();
    const input = request("locked-session");
    const starts: StartVisualRepairInput[] = [];
    const warnings: unknown[] = [];
    pending.put(input);

    assert.equal(
      replayPendingVisualRepair(
        pending,
        async (next) => {
          starts.push(next);
          return "finished";
        },
        (...args) => warnings.push(args)
      ),
      true
    );
    assert.equal(pending.peek(), null);
    await Promise.resolve();
    assert.deepEqual(starts, [input]);
    assert.deepEqual(warnings, []);
    assert.equal(
      replayPendingVisualRepair(pending, async () => "finished", () => {}),
      false
    );
  });

  it("retains the request if replay still requires authentication and contains rejection", async () => {
    const pending = createPendingRequestSlot<StartVisualRepairInput>();
    const input = request();
    pending.put(input);
    replayPendingVisualRepair(
      pending,
      async () => "authentication-required",
      () => {}
    );
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(pending.peek(), input);

    pending.put(input);
    replayPendingVisualRepair(pending, async () => "busy", () => {});
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(pending.peek(), input);

    const failure = new Error("resume failed");
    const warnings: Array<{ message: string; error: unknown }> = [];
    pending.put(input);
    replayPendingVisualRepair(
      pending,
      async () => {
        throw failure;
      },
      (message, error) => warnings.push({ message, error })
    );
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(warnings, [
      { message: "Could not resume visual artifact repair.", error: failure }
    ]);
  });
});
