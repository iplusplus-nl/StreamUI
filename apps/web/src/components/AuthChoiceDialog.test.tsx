import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthChoiceDialogContent } from "./AuthChoiceDialog";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe("authentication choice dialog", () => {
  it("offers managed sign-in and a local provider path", () => {
    const markup = renderToStaticMarkup(
      <AuthChoiceDialogContent
        onClose={() => undefined}
        onSignIn={() => undefined}
        onContinueLocal={() => undefined}
      />
    );

    assert.match(markup, /Choose how to use ChatHTML/);
    assert.match(markup, />Sign in</);
    assert.match(markup, />Use your own API key</);
    assert.match(markup, /never pass[\s\S]*ChatHTML server/);
    assert.doesNotMatch(markup, /accessToken|code_verifier/);
  });

  it("offers browser-direct BYO mode when cloud account isolation is required", () => {
    const markup = renderToStaticMarkup(
      <AuthChoiceDialogContent
        required
        onClose={() => undefined}
        onSignIn={() => undefined}
        onContinueLocal={() => undefined}
      />
    );

    assert.match(markup, /Choose how to use ChatHTML/);
    assert.match(markup, />Sign in</);
    assert.match(markup, />Use your own API key</);
    assert.match(markup, /provider requests stay in this browser/);
    assert.doesNotMatch(markup, /auth-choice-close/);
  });
});
