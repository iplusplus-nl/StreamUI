import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { normalizeApiSettings } from "../../core/apiSettings";
import type { ApiStyle } from "../../core/apiSettings";
import { ApiSettingsSection } from "./ApiSettingsSection";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function render(
  providerId: "openrouter" | "openai" | "local" | "custom",
  apiStyle: ApiStyle = "responses"
) {
  return renderToStaticMarkup(
    <ApiSettingsSection
      settings={normalizeApiSettings({
        providerId,
        apiStyle,
        model:
          providerId === "custom"
            ? "deployment-42"
            : providerId === "openai"
              ? "openai/gpt-5.5"
              : undefined,
        modelOptions: []
      })}
      runtimeSettings={null}
      cloudEnabled={false}
      isModelImportLoading={false}
      onSettingsChange={() => undefined}
      onProviderChange={() => undefined}
      onBaseUrlChange={() => undefined}
      onFetchModels={() => undefined}
      onRemoveModel={() => undefined}
    />
  );
}

describe("API settings provider controls", () => {
  it("offers Responses and Chat Completions API styles", () => {
    const responsesMarkup = render("openrouter");
    const completionsMarkup = render("openrouter", "chat-completions");

    assert.match(responsesMarkup, /aria-label="API Style"/);
    assert.match(responsesMarkup, />Responses</);
    assert.match(completionsMarkup, />Chat Completions</);
  });

  it("uses free-form model IDs for Local and Custom", () => {
    for (const providerId of ["local", "custom"] as const) {
      const markup = render(providerId);
      assert.match(markup, /aria-label="Default Model ID"/);
      assert.match(markup, /even if Fetch does not list it/);
      assert.match(markup, /Not available on this provider request path/);
    }
  });

  it("normalizes OpenAI IDs and does not advertise unsent reasoning levels", () => {
    const markup = render("openai");

    assert.match(markup, />gpt-5\.5</);
    assert.doesNotMatch(markup, /openai\/gpt-5\.5/);
    assert.doesNotMatch(markup, /gemini-3\.1|claude-sonnet|glm-5\.2/);
    assert.match(markup, /Not available on this provider request path/);
  });

  it("keeps supported reasoning bounded to the transmitted levels", () => {
    const markup = render("openrouter");

    assert.match(markup, /aria-label="Reasoning"/);
    assert.doesNotMatch(markup, /XHigh|Ultra/);
  });
});
