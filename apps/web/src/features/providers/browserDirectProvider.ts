import {
  normalizeApiSettings,
  type ApiSettings
} from "../../core/apiSettings";
import type { SessionFile } from "../../domain/chat/sessionModel";
import {
  SYSTEM_PROMPT,
  buildUiComplexityPrompt
} from "../../server/systemPrompt";

type FetchLike = typeof fetch;

type DirectChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type DirectChatPayload = {
  runId?: unknown;
  messages?: unknown;
  files?: unknown;
  userMessage?: unknown;
  themeMode?: unknown;
  canvas?: unknown;
  apiSettings?: unknown;
};

type ProviderStreamEvent = Record<string, unknown>;

const MAX_PROVIDER_ERROR_CHARS = 2_000;
const MAX_DIRECT_STREAM_BYTES = 67_108_864;
const MAX_DIRECT_SSE_LINE_CHARS = 2_097_152;

export function usesBrowserDirectProvider(settings: ApiSettings): boolean {
  return normalizeApiSettings(settings).apiKeySource === "manual";
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function requireDirectProviderUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }

  if (url.username || url.password) {
    throw new Error(`${label} must not contain embedded credentials.`);
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHostname(url.hostname))
  ) {
    throw new Error(
      `${label} must use HTTPS. Plain HTTP is allowed only for a local provider.`
    );
  }
  return url;
}

function requireManualSettings(input: unknown): ApiSettings {
  const settings = normalizeApiSettings(input);
  if (settings.apiKeySource !== "manual") {
    throw new Error("Browser-direct requests require a manual API key.");
  }
  if (!settings.apiKey.trim()) {
    throw new Error("Enter your provider API key in Settings first.");
  }
  if (!settings.baseUrl.trim()) {
    throw new Error("Enter a provider Base URL in Settings first.");
  }
  if (!settings.model.trim()) {
    throw new Error("Choose a provider model in Settings first.");
  }
  return settings;
}

function providerEndpoint(settings: ApiSettings): string {
  const baseUrl = requireDirectProviderUrl(
    settings.baseUrl.trim().replace(/\/+$/, ""),
    "Provider Base URL"
  );
  baseUrl.pathname = [
    baseUrl.pathname.replace(/\/+$/, ""),
    settings.apiStyle === "chat-completions"
      ? "chat/completions"
      : "responses"
  ].join("/");
  baseUrl.search = "";
  baseUrl.hash = "";
  return baseUrl.toString();
}

function directFetchError(error: unknown): Error {
  if ((error as { name?: unknown })?.name === "AbortError") {
    return error as Error;
  }
  const detail = error instanceof Error ? ` ${error.message}` : "";
  return new Error(
    `The browser could not connect directly to the model provider.${detail} ` +
      "The provider must allow browser CORS requests; ChatHTML will not proxy your key."
  );
}

function normalizeMessages(input: unknown): DirectChatMessage[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      return [];
    }
    const message = candidate as { role?: unknown; content?: unknown };
    if (
      (message.role !== "user" && message.role !== "assistant") ||
      typeof message.content !== "string"
    ) {
      return [];
    }
    return [{ role: message.role, content: message.content }];
  });
}

function normalizeFiles(input: unknown): SessionFile[] {
  return Array.isArray(input)
    ? input.filter(
        (file): file is SessionFile =>
          Boolean(file) && typeof file === "object" && "id" in file
      )
    : [];
}

function getLatestUserFileIds(payload: DirectChatPayload): Set<string> {
  const message =
    payload.userMessage && typeof payload.userMessage === "object"
      ? (payload.userMessage as { fileIds?: unknown })
      : null;
  return new Set(
    Array.isArray(message?.fileIds)
      ? message.fileIds.filter((id): id is string => typeof id === "string")
      : []
  );
}

function createResponsesInput(payload: DirectChatPayload) {
  const messages = normalizeMessages(payload.messages);
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const latestFileIds = getLatestUserFileIds(payload);
  const imageFiles = normalizeFiles(payload.files).filter(
    (file) =>
      file.kind === "image" &&
      typeof file.dataUrl === "string" &&
      file.dataUrl.startsWith("data:image/") &&
      (!latestFileIds.size || latestFileIds.has(file.id))
  );

  return messages.map((message, index) => {
    if (index !== latestUserIndex || !imageFiles.length) {
      return message;
    }
    return {
      role: message.role,
      content: [
        { type: "input_text", text: message.content || "Describe these images." },
        ...imageFiles.map((file) => ({
          type: "input_image",
          image_url: file.dataUrl,
          detail: "auto"
        }))
      ]
    };
  });
}

function toChatCompletionContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const value = part as {
      type?: unknown;
      text?: unknown;
      image_url?: unknown;
    };
    if (
      (value.type === "input_text" || value.type === "text") &&
      typeof value.text === "string"
    ) {
      parts.push({ type: "text", text: value.text });
      continue;
    }
    if (value.type === "input_image" && typeof value.image_url === "string") {
      parts.push({
        type: "image_url",
        image_url: { url: value.image_url, detail: "auto" }
      });
    }
  }
  return parts;
}

function createChatCompletionMessages(
  input: unknown,
  instructions: string
): Array<Record<string, unknown>> {
  const candidates = Array.isArray(input) ? input : [];
  const messages: Array<Record<string, unknown>> = instructions
    ? [{ role: "system", content: instructions }]
    : [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const message = candidate as {
      role?: unknown;
      content?: unknown;
      type?: unknown;
    };
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    const content = toChatCompletionContent(message.content);
    messages.push({
      role: message.role,
      content:
        message.role === "assistant" && Array.isArray(content)
          ? content
              .flatMap((part) => {
                const text = (part as { text?: unknown }).text;
                return typeof text === "string" ? [text] : [];
              })
              .join("")
          : content
    });
  }
  if (messages.length === (instructions ? 1 : 0)) {
    messages.push({
      role: "user",
      content:
        typeof input === "string" ? input : JSON.stringify(input ?? "")
    });
  }
  return messages;
}

function createDirectInstructions(
  payload: DirectChatPayload,
  settings: ApiSettings
): string {
  const memory = settings.memoryItems
    .map((item) => `- ${item.text.trim()}`)
    .filter((item) => item !== "- ")
    .join("\n");
  const theme = payload.themeMode === "day" ? "day" : "night";
  const canvas =
    payload.canvas && typeof payload.canvas === "object"
      ? JSON.stringify(payload.canvas)
      : "unknown";

  return [
    SYSTEM_PROMPT,
    settings.userPreferencePrompt.trim()
      ? `User preferences:\n${settings.userPreferencePrompt.trim()}`
      : "",
    memory ? `User-managed memory:\n${memory}` : "",
    `Current ChatHTML theme: ${theme}.`,
    `Current browser canvas context: ${canvas}.`,
    buildUiComplexityPrompt(settings.uiComplexity),
    "This is browser-direct mode. Server-side retrieval and server file tools are unavailable. Do not claim to have used them."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function compactProviderError(value: string): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return "The provider returned an error.";
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const message =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.error?.message === "string"
          ? parsed.error.message
          : typeof parsed.message === "string"
            ? parsed.message
            : trimmed;
    return message.slice(0, MAX_PROVIDER_ERROR_CHARS);
  } catch {
    return trimmed.slice(0, MAX_PROVIDER_ERROR_CHARS);
  }
}

function eventText(event: ProviderStreamEvent): {
  type: "content" | "reasoning";
  text: string;
} | null {
  const type = typeof event.type === "string" ? event.type : "";
  const isReasoning = /reasoning|summary_text/.test(type);
  const delta = typeof event.delta === "string" ? event.delta : "";
  if (delta && (type.endsWith(".delta") || type.includes("content_part"))) {
    return { type: isReasoning ? "reasoning" : "content", text: delta };
  }
  if (
    typeof event.text === "string" &&
    (type.endsWith(".done") || type.includes("content_part.done"))
  ) {
    return { type: isReasoning ? "reasoning" : "content", text: event.text };
  }
  return null;
}

function chatCompletionEvents(event: ProviderStreamEvent): Array<{
  type: "content" | "reasoning";
  text: string;
}> {
  const choices = Array.isArray(event.choices) ? event.choices : [];
  const events: Array<{ type: "content" | "reasoning"; text: string }> = [];
  for (const candidate of choices) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const delta = (candidate as { delta?: unknown }).delta;
    if (!delta || typeof delta !== "object") {
      continue;
    }
    const object = delta as {
      content?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
    };
    if (typeof object.content === "string" && object.content) {
      events.push({ type: "content", text: object.content });
    }
    const reasoning = object.reasoning ?? object.reasoning_content;
    if (typeof reasoning === "string" && reasoning) {
      events.push({ type: "reasoning", text: reasoning });
    }
  }
  return events;
}

function chatCompletionFinishReason(event: ProviderStreamEvent): string {
  const choices = Array.isArray(event.choices) ? event.choices : [];
  for (const candidate of choices) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const reason = (candidate as { finish_reason?: unknown }).finish_reason;
    if (typeof reason === "string" && reason) {
      return reason;
    }
  }
  return "";
}

function finalResponseText(event: ProviderStreamEvent): string {
  const response =
    event.response && typeof event.response === "object"
      ? (event.response as { output?: unknown })
      : null;
  if (!Array.isArray(response?.output)) {
    return "";
  }
  return response.output
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const content = (item as { content?: unknown }).content;
      return Array.isArray(content)
        ? content.flatMap((part) => {
            if (!part || typeof part !== "object") {
              return [];
            }
            const text = (part as { text?: unknown }).text;
            return typeof text === "string" ? [text] : [];
          })
        : [];
    })
    .join("");
}

function terminalError(event: ProviderStreamEvent): string {
  const error = event.error;
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  const response =
    event.response && typeof event.response === "object"
      ? (event.response as {
          error?: unknown;
          incomplete_details?: { reason?: unknown };
        })
      : null;
  if (response?.error && typeof response.error === "object") {
    const message = (response.error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  const reason = response?.incomplete_details?.reason;
  return typeof reason === "string"
    ? `The provider response was incomplete: ${reason}.`
    : "The provider could not complete the response.";
}

function createNdjsonProviderStream(
  providerBody: ReadableStream<Uint8Array>,
  runId: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let sequence = 0;
      let buffer = "";
      let streamBytes = 0;
      let terminal = false;
      let contentDeltaSeen = false;
      let reasoningDeltaSeen = false;
      let chatCompletionFinished = false;
      const emit = (event: Record<string, unknown>) => {
        sequence += 1;
        controller.enqueue(
          encoder.encode(`${JSON.stringify({ ...event, runId, seq: sequence })}\n`)
        );
      };
      const finish = (status: "complete" | "error", error = "") => {
        if (terminal) {
          return;
        }
        terminal = true;
        emit({ type: "done", status, ...(error ? { error } : {}) });
      };
      const handlePayload = (payload: string) => {
        if (!payload || terminal) {
          return;
        }
        if (payload === "[DONE]") {
          finish("complete");
          return;
        }
        let event: ProviderStreamEvent;
        try {
          event = JSON.parse(payload) as ProviderStreamEvent;
        } catch {
          return;
        }
        const type = typeof event.type === "string" ? event.type : "";
        if (!type && event.error) {
          finish("error", terminalError(event));
          return;
        }
        const textEvent = eventText(event);
        if (textEvent) {
          const isDoneText = type.endsWith(".done");
          const alreadyStreamed =
            textEvent.type === "content"
              ? contentDeltaSeen
              : reasoningDeltaSeen;
          if (!isDoneText || !alreadyStreamed) {
            emit(textEvent);
            if (textEvent.type === "content") {
              contentDeltaSeen = true;
            } else {
              reasoningDeltaSeen = true;
            }
          }
        }
        for (const completionEvent of chatCompletionEvents(event)) {
          emit(completionEvent);
          if (completionEvent.type === "content") {
            contentDeltaSeen = true;
          } else {
            reasoningDeltaSeen = true;
          }
        }
        const finishReason = chatCompletionFinishReason(event);
        if (finishReason) {
          if (
            finishReason !== "stop" &&
            finishReason !== "tool_calls" &&
            finishReason !== "function_call"
          ) {
            finish("error", `The provider stopped with ${finishReason}.`);
            return;
          }
          chatCompletionFinished = true;
        }
        if (type === "response.completed" || type === "response.done") {
          const finalText = finalResponseText(event);
          if (!contentDeltaSeen && finalText) {
            emit({ type: "content", text: finalText });
          }
          finish("complete");
        } else if (
          type === "response.failed" ||
          type === "response.incomplete" ||
          type === "response.cancelled" ||
          type === "error"
        ) {
          finish("error", terminalError(event));
        }
      };
      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          handlePayload(trimmed.slice(5).trim());
        }
      };

      void (async () => {
        const reader = providerBody.getReader();
        const decoder = new TextDecoder();
        try {
          while (!terminal) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            streamBytes += value.byteLength;
            if (streamBytes > MAX_DIRECT_STREAM_BYTES) {
              await reader.cancel().catch(() => undefined);
              finish("error", "The provider stream exceeded the browser safety limit.");
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r\n|\r|\n/);
            buffer = lines.pop() ?? "";
            if (
              buffer.length > MAX_DIRECT_SSE_LINE_CHARS ||
              lines.some((line) => line.length > MAX_DIRECT_SSE_LINE_CHARS)
            ) {
              await reader.cancel().catch(() => undefined);
              finish("error", "The provider sent an oversized stream event.");
              break;
            }
            lines.forEach(handleLine);
          }
          buffer += decoder.decode();
          if (buffer.trim()) {
            buffer.split(/\r\n|\r|\n/).forEach(handleLine);
          }
          if (!terminal) {
            finish(
              chatCompletionFinished ? "complete" : "error",
              chatCompletionFinished
                ? ""
                : "The provider stream ended before confirming completion."
            );
          }
        } catch (error) {
          finish(
            "error",
            error instanceof Error
              ? error.message
              : "The browser lost the provider stream."
          );
        } finally {
          reader.releaseLock();
          controller.close();
        }
      })();
    }
  });
}

export async function startBrowserDirectChatRun(
  input: unknown,
  _clientId: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<Response> {
  const payload =
    input && typeof input === "object" ? (input as DirectChatPayload) : {};
  const settings = requireManualSettings(payload.apiSettings);
  const endpoint = providerEndpoint(settings);
  const runId = typeof payload.runId === "string" ? payload.runId : "direct-run";
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        Accept: "text/event-stream",
        "Content-Type": "application/json"
      },
      signal,
      body: JSON.stringify(
        settings.apiStyle === "chat-completions"
          ? {
              model: settings.model,
              messages: createChatCompletionMessages(
                createResponsesInput(payload),
                createDirectInstructions(payload, settings)
              ),
              stream: true,
              max_tokens: 16_000,
              ...(settings.reasoningEffort !== "none"
                ? { reasoning: { effort: settings.reasoningEffort } }
                : {})
            }
          : {
              model: settings.model,
              input: createResponsesInput(payload),
              instructions: createDirectInstructions(payload, settings),
              stream: true,
              max_output_tokens: 16_000,
              ...(settings.reasoningEffort !== "none"
                ? { reasoning: { effort: settings.reasoningEffort } }
                : {})
            }
      )
    });
  } catch (error) {
    throw directFetchError(error);
  }

  if (!response.ok || !response.body) {
    const detail = compactProviderError(await response.text());
    return new Response(
      `Direct provider request failed with HTTP ${response.status}. ${detail}`,
      { status: response.status || 502, statusText: response.statusText }
    );
  }

  return new Response(createNdjsonProviderStream(response.body, runId), {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" }
  });
}

export async function requestBrowserDirectText(
  apiSettings: ApiSettings,
  request: {
    instructions: string;
    input: unknown;
    maxOutputTokens?: number;
  },
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<string> {
  const settings = requireManualSettings(apiSettings);
  const endpoint = providerEndpoint(settings);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      signal,
      body: JSON.stringify(
        settings.apiStyle === "chat-completions"
          ? {
              model: settings.model,
              messages: createChatCompletionMessages(
                request.input,
                request.instructions
              ),
              stream: false,
              max_tokens: request.maxOutputTokens ?? 16_000
            }
          : {
              model: settings.model,
              input: request.input,
              instructions: request.instructions,
              stream: false,
              max_output_tokens: request.maxOutputTokens ?? 16_000
            }
      )
    });
  } catch (error) {
    throw directFetchError(error);
  }

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `Direct provider request failed with HTTP ${response.status}. ${compactProviderError(
        responseText
      )}`
    );
  }

  let payload: ProviderStreamEvent;
  try {
    payload = JSON.parse(responseText) as ProviderStreamEvent;
  } catch {
    throw new Error("The provider returned invalid JSON.");
  }
  const outputText =
    settings.apiStyle === "chat-completions"
      ? (() => {
          const choices = Array.isArray(payload.choices) ? payload.choices : [];
          const message = (
            choices[0] as { message?: { content?: unknown } } | undefined
          )?.message;
          return typeof message?.content === "string" ? message.content : "";
        })()
      : typeof payload.output_text === "string"
        ? payload.output_text
        : finalResponseText({ response: payload });
  if (!outputText.trim()) {
    throw new Error("The provider returned an empty response.");
  }
  return outputText;
}

export async function fetchBrowserDirectModelCatalog(
  apiSettings: ApiSettings,
  fetchImpl: FetchLike = fetch
): Promise<string[]> {
  const settings = requireManualSettings(apiSettings);
  const endpoint = requireDirectProviderUrl(
    settings.modelsEndpoint.trim(),
    "Models Endpoint"
  ).toString();
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        Accept: "application/json"
      }
    });
  } catch (error) {
    throw directFetchError(error);
  }
  const payload = (await response.json().catch(() => ({}))) as {
    data?: unknown;
    models?: unknown;
    error?: { message?: unknown } | string;
  };
  if (!response.ok) {
    const detail =
      typeof payload.error === "string"
        ? payload.error
        : typeof payload.error?.message === "string"
          ? payload.error.message
          : `HTTP ${response.status}`;
    throw new Error(`Unable to fetch the provider model list directly: ${detail}`);
  }
  const candidates = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : [];
  return candidates.flatMap((candidate) => {
    if (typeof candidate === "string") {
      return candidate.trim() ? [candidate.trim()] : [];
    }
    if (!candidate || typeof candidate !== "object") {
      return [];
    }
    const id = (candidate as { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? [id.trim()] : [];
  });
}
