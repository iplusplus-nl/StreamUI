import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  closeAuthAndDiscard,
  openManualAuth,
  pinManagedRequestToSession,
  queueManagedAuthRequest,
  replayManagedAuthRequest
} from "./managedAuthContinuation";
import { createPendingRequestSlot } from "./pendingRequestSlot";

describe("managed auth continuation", () => {
  it("pins a queued request to its original session without mutating it", () => {
    const request = {
      text: "hello",
      attachments: [{ id: "image-1" }],
      options: {
        targetSessionId: "stale-session",
        appendUserMessage: false
      }
    };

    const pinned = pinManagedRequestToSession(request, "session-owner");

    assert.notEqual(pinned, request);
    assert.notEqual(pinned.options, request.options);
    assert.equal(pinned.attachments, request.attachments);
    assert.deepEqual(pinned.options, {
      targetSessionId: "session-owner",
      appendUserMessage: false
    });
    assert.equal(request.options.targetSessionId, "stale-session");
  });

  it("queues managed chat before opening authentication", () => {
    const slot = createPendingRequestSlot<{ id: string }>();
    const request = { id: "request-1" };
    const events: string[] = [];

    queueManagedAuthRequest(slot, request, () => {
      assert.equal(slot.peek(), request);
      events.push("open");
    });

    assert.equal(slot.peek(), request);
    assert.deepEqual(events, ["open"]);
  });

  it("manual open and close discard stale continuations first", () => {
    const slot = createPendingRequestSlot<string>();
    const events: string[] = [];
    slot.put("stale");

    openManualAuth(slot, () => events.push(`open:${slot.peek()}`));
    slot.put("new-stale");
    closeAuthAndDiscard(slot, () => events.push(`close:${slot.peek()}`));

    assert.deepEqual(events, ["open:null", "close:null"]);
    assert.equal(slot.peek(), null);
  });

  it("replays a successful continuation once after closing the overlay", () => {
    const slot = createPendingRequestSlot<string>();
    const events: string[] = [];
    slot.put("send me");

    assert.equal(
      replayManagedAuthRequest(
        slot,
        () => events.push("close"),
        (request) => events.push(`send:${request}`)
      ),
      true
    );
    assert.equal(
      replayManagedAuthRequest(
        slot,
        () => events.push("unexpected-close"),
        () => events.push("unexpected-send")
      ),
      false
    );
    assert.deepEqual(events, ["close", "send:send me"]);
  });

  it("does not confuse a falsy request value with an empty slot", () => {
    const slot = createPendingRequestSlot<number>();
    let replayed: number | null = null;
    slot.put(0);

    assert.equal(
      replayManagedAuthRequest(slot, () => undefined, (request) => {
        replayed = request;
      }),
      true
    );
    assert.equal(replayed, 0);
  });
});
