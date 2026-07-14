import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_API_SETTINGS,
  REQUIRED_MODEL_OPTIONS,
  type ApiSettings
} from "../../core/apiSettings";
import type { ChatSession } from "../../domain/chat/sessionModel";
import {
  deriveSessionRunSettings,
  normalizeRequestedSessionModel
} from "./useSessionRunSettings";

const apiSettings: ApiSettings = {
  ...DEFAULT_API_SETTINGS,
  model: "default-model",
  modelOptions: ["other-model"],
  reasoningEffort: "low",
  uiComplexity: 50
};

const session: ChatSession = {
  id: "session-a",
  title: "Session A",
  createdAt: 1,
  updatedAt: 1,
  messages: [],
  files: []
};

test("derives run settings from API defaults for an unconfigured session", () => {
  assert.deepEqual(deriveSessionRunSettings(session, apiSettings), {
    model: "default-model",
    reasoningEffort: "low",
    uiComplexity: 50,
    selectableModels: [
      ...REQUIRED_MODEL_OPTIONS,
      "default-model",
      "other-model"
    ]
  });
});

test("prefers session settings and keeps its model selectable", () => {
  const settings = deriveSessionRunSettings(
    {
      ...session,
      model: "session-model",
      reasoningEffort: "high",
      uiComplexity: 123
    },
    apiSettings
  );

  assert.equal(settings.model, "session-model");
  assert.equal(settings.reasoningEffort, "high");
  assert.equal(settings.uiComplexity, 100);
  assert.deepEqual(settings.selectableModels, [
    ...REQUIRED_MODEL_OPTIONS,
    "session-model",
    "other-model"
  ]);
});

test("normalizes requested session models without accepting blank input", () => {
  assert.equal(normalizeRequestedSessionModel("  custom/model  "), "custom/model");
  assert.equal(normalizeRequestedSessionModel("   "), null);
});

test("uses provider-filtered selectable models for OpenAI sessions", () => {
  const settings = deriveSessionRunSettings(session, {
    ...apiSettings,
    providerId: "openai",
    model: "gpt-4.1",
    modelOptions: [
      "google/gemini-custom",
      "anthropic/claude-custom",
      "z-ai/glm-custom",
      "gpt-4o"
    ]
  });

  assert.deepEqual(settings.selectableModels, [
    "openai/gpt-5.5",
    "gpt-4.1",
    "gpt-4o"
  ]);
});
