import {
  serializeApiSettings,
  type ApiSettings
} from "../../core/apiSettings";
import { apiUrl } from "../../api/appUrl";

type ModelsResponse = {
  models?: unknown;
  error?: unknown;
};

export async function fetchModelCatalog(
  apiSettings: ApiSettings
): Promise<string[]> {
  const response = await fetch(apiUrl("/models"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      apiSettings: serializeApiSettings(apiSettings)
    })
  });
  const payload = (await response.json().catch(() => ({}))) as ModelsResponse;

  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `Unable to fetch model list (${response.status}).`
    );
  }

  if (!Array.isArray(payload.models)) {
    return [];
  }

  return payload.models.filter((model): model is string => {
    return typeof model === "string" && model.trim().length > 0;
  });
}
