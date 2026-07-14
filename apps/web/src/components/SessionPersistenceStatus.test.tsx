import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionPersistenceStatus } from "./SessionPersistenceStatus";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe("session persistence status", () => {
  it("shows saving and saved states", () => {
    const saving = renderToStaticMarkup(
      <SessionPersistenceStatus
        saveStatus="saving"
        syncError={null}
        onRetry={() => undefined}
      />
    );
    const saved = renderToStaticMarkup(
      <SessionPersistenceStatus
        saveStatus="saved"
        syncError={null}
        onRetry={() => undefined}
      />
    );

    assert.match(saving, /Saving…/);
    assert.match(saved, />Saved</);
  });

  it("shows a retry affordance for save and sync failures", () => {
    const saveFailure = renderToStaticMarkup(
      <SessionPersistenceStatus
        saveStatus="failed"
        syncError={null}
        onRetry={() => undefined}
      />
    );
    const syncFailure = renderToStaticMarkup(
      <SessionPersistenceStatus
        saveStatus="saved"
        syncError="Sessions could not sync."
        onRetry={() => undefined}
      />
    );

    assert.match(saveFailure, /Changes could not be saved/);
    assert.match(saveFailure, />Retry</);
    assert.match(syncFailure, /Sessions could not sync/);
    assert.match(syncFailure, />Retry</);
  });
});
