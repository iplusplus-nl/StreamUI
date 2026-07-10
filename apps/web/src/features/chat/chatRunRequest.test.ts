import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isManagedRequestReplaySafe } from "./chatRunRequest";

describe("managed chat request replay safety", () => {
  it("allows ordinary requests to be reconstructed after authentication", () => {
    assert.equal(isManagedRequestReplaySafe({}), true);
    assert.equal(
      isManagedRequestReplaySafe({ targetSessionId: "session-1" }),
      true
    );
  });

  it("rejects transferred leases, ephemeral files, and ownership callbacks", () => {
    assert.equal(
      isManagedRequestReplaySafe({
        chatActivityLease: { release() {} }
      }),
      false
    );
    assert.equal(
      isManagedRequestReplaySafe({ ephemeralAttachments: true }),
      false
    );
    assert.equal(
      isManagedRequestReplaySafe({ onRunAccepted() {} }),
      false
    );
  });
});
