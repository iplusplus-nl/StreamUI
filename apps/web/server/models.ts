import type { Request, Response } from "express";
import { readRuntimeApiCredentials } from "./runtimeApiSettings.js";

const MAX_MODEL_IDS = 1_000;
const MAX_MODEL_ID_LENGTH = 180;

function normalizeModelsEndpoint(value: unknown, baseUrl: string): string {
  const input = typeof value === "string" ? value.trim() : "";
  const fallback = baseUrl ? `${baseUrl}/models` : "";
  const endpoint = input || fallback;

  if (!endpoint) {
    return "";
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    if (!baseUrl) {
      throw new Error("Models endpoint must be a valid URL.");
    }
    url = new URL(endpoint, `${baseUrl}/`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Models endpoint must use http or https.");
  }

  return url.toString();
}

function normalizeModelId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const modelId = value.trim().slice(0, MAX_MODEL_ID_LENGTH);
  if (!modelId || /[\r\n]/.test(modelId)) {
    return null;
  }

  return modelId;
}

function readModelId(value: unknown): string | null {
  if (typeof value === "string") {
    return normalizeModelId(value);
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  return normalizeModelId(record.id ?? record.name ?? record.model);
}

function extractModelIds(payload: unknown): string[] {
  const candidates: unknown[] = [];

  if (Array.isArray(payload)) {
    candidates.push(...payload);
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.data)) {
      candidates.push(...record.data);
    }
    if (Array.isArray(record.models)) {
      candidates.push(...record.models);
    }
  }

  const seen = new Set<string>();
  const modelIds: string[] = [];

  for (const candidate of candidates) {
    const modelId = readModelId(candidate);
    if (!modelId) {
      continue;
    }

    const key = modelId.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    modelIds.push(modelId);

    if (modelIds.length >= MAX_MODEL_IDS) {
      break;
    }
  }

  return modelIds;
}

export async function handleModelsRequest(
  req: Request,
  res: Response
): Promise<void> {
  const body = req.body as { apiSettings?: unknown };
  const object =
    typeof body.apiSettings === "object" && body.apiSettings !== null
      ? (body.apiSettings as Record<string, unknown>)
      : {};
  const credentials = readRuntimeApiCredentials(object);
  const endpoint = normalizeModelsEndpoint(
    object.modelsEndpoint,
    credentials.baseUrl
  );
  const missing: string[] = [];

  if (!endpoint) {
    missing.push("Models endpoint");
  }
  if (!credentials.apiKey) {
    missing.push(
      credentials.apiKeySource === "environment"
        ? credentials.apiKeyEnvironmentName
        : "API key"
    );
  }

  if (missing.length) {
    res.status(400).json({ error: `API settings missing: ${missing.join(", ")}.` });
    return;
  }

  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credentials.apiKey}`
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Models endpoint returned ${response.status}: ${text.slice(0, 500)}`
      );
    }

    const payload = (await response.json()) as unknown;
    const models = extractModelIds(payload);

    res.json({ models });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to fetch model list.";
    res.status(502).json({ error: message });
  }
}
