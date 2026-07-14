import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  consumeEscapeDismissal,
  isDirectOverlayInteraction,
  isEscapeDismissKey,
  isTargetOutside
} from "./dismissalModel";

describe("dismissal model", () => {
  it("only treats Escape as the keyboard dismissal key", () => {
    assert.equal(isEscapeDismissKey("Escape"), true);
    assert.equal(isEscapeDismissKey("Enter"), false);
    assert.equal(isEscapeDismissKey("Esc"), false);
  });

  it("lets the topmost layer consume Escape without reaching an outer layer", () => {
    let preventDefaultCalls = 0;
    let stopPropagationCalls = 0;
    const consumed = consumeEscapeDismissal({
      key: "Escape",
      defaultPrevented: false,
      preventDefault: () => {
        preventDefaultCalls += 1;
      },
      stopPropagation: () => {
        stopPropagationCalls += 1;
      }
    });

    assert.equal(consumed, true);
    assert.equal(preventDefaultCalls, 1);
    assert.equal(stopPropagationCalls, 1);
    assert.equal(
      consumeEscapeDismissal({
        key: "Escape",
        defaultPrevented: true,
        preventDefault: () => {
          throw new Error("already-consumed Escape must not be consumed again");
        },
        stopPropagation: () => {
          throw new Error("already-consumed Escape must not propagate again");
        }
      }),
      false
    );
  });

  it("only dismisses an overlay for an interaction on the overlay itself", () => {
    const overlay = {};
    const dialog = {};

    assert.equal(isDirectOverlayInteraction(overlay, overlay), true);
    assert.equal(isDirectOverlayInteraction(dialog, overlay), false);
  });

  it("distinguishes outside targets without dismissing inside interactions", () => {
    const inside = {};
    const outside = {};
    const boundary = { contains: (target: object) => target === inside };

    assert.equal(isTargetOutside(boundary, outside), true);
    assert.equal(isTargetOutside(boundary, inside), false);
    assert.equal(isTargetOutside(boundary, null), false);
    assert.equal(isTargetOutside(null, outside), false);
  });
});
