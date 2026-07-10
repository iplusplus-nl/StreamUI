import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  finalizeChatRunTerminal,
  type ChatRunTerminalOutcome
} from "./chatRunFinalization.js";

describe("chat run terminal resource finalization", () => {
  for (const outcome of [
    "complete",
    "error",
    "cancelled"
  ] as ChatRunTerminalOutcome[]) {
    it(`cleans ephemeral files after ${outcome}`, async () => {
      const events: string[] = [];

      await finalizeChatRunTerminal({
        outcome,
        persistTerminalState: (value) => {
          events.push(`persist:${value}`);
        },
        waitForExecution: (value) => {
          events.push(`settled:${value}`);
        },
        cleanupEphemeralFiles: (value) => {
          events.push(`cleanup:${value}`);
        }
      });

      assert.deepEqual(events, [
        `persist:${outcome}`,
        `settled:${outcome}`,
        `cleanup:${outcome}`
      ]);
    });
  }

  it("still cleans ephemeral files when terminal persistence throws", async () => {
    const failure = new Error("terminal persistence failed");
    const events: string[] = [];

    await assert.rejects(
      finalizeChatRunTerminal({
        outcome: "error",
        persistTerminalState: () => {
          events.push("persist");
          throw failure;
        },
        waitForExecution: () => {
          events.push("settled");
        },
        cleanupEphemeralFiles: () => {
          events.push("cleanup");
        }
      }),
      failure
    );
    assert.deepEqual(events, ["persist", "settled", "cleanup"]);
  });

  it("does not clean a cancelled run until its execution has settled", async () => {
    const events: string[] = [];
    let settleExecution: () => void = () => {};
    const executionSettled = new Promise<void>((resolve) => {
      settleExecution = resolve;
    });
    const finalization = finalizeChatRunTerminal({
      outcome: "cancelled",
      persistTerminalState: () => {
        events.push("persist");
      },
      waitForExecution: async () => {
        events.push("wait");
        await executionSettled;
        events.push("settled");
      },
      cleanupEphemeralFiles: () => {
        events.push("cleanup");
      }
    });

    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(events, ["persist", "wait"]);

    settleExecution();
    await finalization;
    assert.deepEqual(events, ["persist", "wait", "settled", "cleanup"]);
  });

  it("retries idempotent ephemeral cleanup failures", async () => {
    const cleanupFailure = new Error("temporary rm failure");
    let attempts = 0;

    await finalizeChatRunTerminal({
      outcome: "complete",
      persistTerminalState: () => undefined,
      waitForExecution: () => undefined,
      cleanupEphemeralFiles: () => {
        attempts += 1;
        if (attempts < 3) {
          throw cleanupFailure;
        }
      }
    });

    assert.equal(attempts, 3);
  });

  it("reports the final cleanup failure after the configured attempts", async () => {
    const cleanupFailure = new Error("persistent rm failure");
    let attempts = 0;

    await assert.rejects(
      finalizeChatRunTerminal({
        outcome: "error",
        persistTerminalState: () => undefined,
        waitForExecution: () => undefined,
        cleanupEphemeralFiles: () => {
          attempts += 1;
          throw cleanupFailure;
        },
        cleanupAttempts: 2
      }),
      cleanupFailure
    );
    assert.equal(attempts, 2);
  });
});
