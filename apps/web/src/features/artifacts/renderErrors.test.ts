import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RenderError } from "../../runtime/streamui/types";
import { hasRenderError, renderErrorKey } from "./renderErrors";

function error(
  kind: RenderError["kind"],
  message: string,
  timestamp = 1
): RenderError {
  return { kind, message, timestamp };
}

describe("artifact render errors", () => {
  it("keys errors by kind and message only", () => {
    assert.equal(renderErrorKey(error("runtime", "boom")), "runtime:boom");
    assert.equal(
      hasRenderError([error("runtime", "boom", 1)], error("runtime", "boom", 9)),
      true
    );
  });

  it("keeps different kinds or messages distinct", () => {
    const errors = [error("runtime", "boom")];
    assert.equal(hasRenderError(errors, error("console", "boom")), false);
    assert.equal(hasRenderError(errors, error("runtime", "other")), false);
    assert.equal(hasRenderError(undefined, error("runtime", "boom")), false);
  });
});
