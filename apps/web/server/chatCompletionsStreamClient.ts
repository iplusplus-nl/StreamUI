import { createProviderAuthorizationHeaders } from "./providerEndpointTrust.js";
import {
  ResponsesTerminalFailureError,
  extractResponsesErrorMessage,
  type ResponsesFunctionCallItem,
  type ResponsesInputItem,
  type ResponsesStreamEvent
} from "./responsesEventReducer.js";
import {
  RESPONSES_DEFAULT_MAX_OUTPUT_TOKENS,
  RESPONSES_MAX_ERROR_BODY_BYTES,
  RESPONSES_MAX_SSE_LINE_CHARS,
  RESPONSES_MAX_STREAM_BYTES,
  summarizeHttpErrorBody,
  type ResponsesStreamApiSettings,
  type ResponsesStreamState
} from "./responsesStreamClient.js";
import type {
  ResponsesInputContentPart,
  ResponsesToolDefinition,
  ResponsesToolOutput
} from "./sessionFileTools.js";

export type StreamChatCompletionsOnceOptions = {
  endpoint: string;
  apiSettings: ResponsesStreamApiSettings;
  input: ResponsesInputItem[];
  instructions: string;
  tools: ResponsesToolDefinition[];
  emit(event: ResponsesStreamEvent): void;
  state: ResponsesStreamState;
  signal: AbortSignal;
  useOpenRouterReasoning: boolean;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
};

type ChatCompletionContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "auto" };
    };

type ChatCompletionMessage = Record<string, unknown>;

type ToolCallAccumulator = {
  id: string;
  name: string;
  arguments: string;
};

export function getChatCompletionsEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function inputContentPart(
  part: ResponsesInputContentPart
): ChatCompletionContentPart | null {
  if (part.type === "input_text") {
    return { type: "text", text: part.text };
  }
  if (part.type === "input_image") {
    return {
      type: "image_url",
      image_url: { url: part.image_url, detail: "auto" }
    };
  }
  if (part.file_url) {
    return { type: "text", text: `Attached file: ${part.file_url}` };
  }
  if (part.filename) {
    return { type: "text", text: `Attached file: ${part.filename}` };
  }
  return null;
}

function userMessageContent(
  content: ResponsesInputContentPart[]
): string | ChatCompletionContentPart[] {
  const parts = content
    .map(inputContentPart)
    .filter(Boolean) as ChatCompletionContentPart[];
  if (parts.length === 1 && parts[0]?.type === "text") {
    return parts[0].text;
  }
  return parts;
}

function toolOutputText(output: ResponsesToolOutput): string {
  if (typeof output === "string") {
    return output;
  }
  return output
    .map((part) => {
      if (part.type === "input_text") {
        return part.text;
      }
      if (part.type === "input_image") {
        return `[Image: ${part.image_url}]`;
      }
      return part.file_url || part.filename || "[File]";
    })
    .join("\n");
}

export function createChatCompletionsMessages(
  input: ResponsesInputItem[],
  instructions: string
): ChatCompletionMessage[] {
  const messages: ChatCompletionMessage[] = instructions
    ? [{ role: "system", content: instructions }]
    : [];

  for (let index = 0; index < input.length; index += 1) {
    const item = input[index];
    if (item.type === "message") {
      if (item.role === "user") {
        messages.push({
          role: "user",
          content: userMessageContent(item.content)
        });
      } else {
        messages.push({
          role: "assistant",
          content: item.content.map((part) => part.text).join("")
        });
      }
      continue;
    }

    if (item.type === "function_call") {
      const calls: ResponsesFunctionCallItem[] = [];
      const outputs: Array<
        Extract<ResponsesInputItem, { type: "function_call_output" }>
      > = [];
      while (index < input.length && input[index]?.type !== "message") {
        const toolItem = input[index];
        if (!toolItem) {
          break;
        }
        if (toolItem.type === "function_call") {
          calls.push(toolItem);
        } else if (toolItem.type === "function_call_output") {
          outputs.push(toolItem);
        }
        index += 1;
      }
      index -= 1;
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: calls.map((call) => ({
          id: call.call_id,
          type: "function",
          function: { name: call.name, arguments: call.arguments }
        }))
      });
      outputs.forEach((output) => {
        messages.push({
          role: "tool",
          tool_call_id: output.call_id,
          content: toolOutputText(output.output)
        });
      });
      continue;
    }

    messages.push({
      role: "tool",
      tool_call_id: item.call_id,
      content: toolOutputText(item.output)
    });
  }

  return messages;
}

function createChatCompletionsTools(tools: ResponsesToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
}

function createAbortError(): Error {
  const error = new Error("Generation stopped.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError();
  }
}

function writeEvent(
  emit: (event: ResponsesStreamEvent) => void,
  state: ResponsesStreamState,
  type: ResponsesStreamEvent["type"],
  text: string
): void {
  if (!text) {
    return;
  }
  if (type === "content") {
    state.contentChars += text.length;
    state.contentEvents += 1;
  } else {
    state.reasoningChars += text.length;
    state.reasoningEvents += 1;
  }
  emit({ type, text });
}

function stringDelta(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .flatMap((part) => {
      if (typeof part === "string") {
        return [part];
      }
      if (!part || typeof part !== "object") {
        return [];
      }
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("");
}

function mergeToolCallDelta(
  calls: Map<number, ToolCallAccumulator>,
  value: unknown
): void {
  if (!Array.isArray(value)) {
    return;
  }
  value.forEach((candidate, fallbackIndex) => {
    if (!candidate || typeof candidate !== "object") {
      return;
    }
    const delta = candidate as {
      index?: unknown;
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const index =
      typeof delta.index === "number" && Number.isFinite(delta.index)
        ? delta.index
        : fallbackIndex;
    const current = calls.get(index) ?? { id: "", name: "", arguments: "" };
    if (typeof delta.id === "string") {
      current.id = delta.id;
    }
    if (typeof delta.function?.name === "string") {
      current.name += delta.function.name;
    }
    if (typeof delta.function?.arguments === "string") {
      current.arguments += delta.function.arguments;
    }
    calls.set(index, current);
  });
}

async function readResponseText(
  response: Response,
  maxBytes = RESPONSES_MAX_ERROR_BODY_BYTES
): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return `${text}${decoder.decode()}`;
      }
      const remaining = maxBytes - totalBytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          text += decoder.decode(value.subarray(0, remaining), { stream: true });
        }
        await reader.cancel().catch(() => undefined);
        return `${text}${decoder.decode()} [response body truncated]`;
      }
      totalBytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function formatHttpError(response: Response, text: string): string {
  const status = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
  const detail = summarizeHttpErrorBody(text, "");
  return [
    `Chat Completions API request failed with ${status}.`,
    detail
  ]
    .filter(Boolean)
    .join(" ");
}

export async function streamChatCompletionsOnce({
  endpoint,
  apiSettings,
  input,
  instructions,
  tools,
  emit,
  state,
  signal,
  useOpenRouterReasoning,
  maxOutputTokens = RESPONSES_DEFAULT_MAX_OUTPUT_TOKENS,
  fetchImpl = globalThis.fetch
}: StreamChatCompletionsOnceOptions): Promise<ResponsesFunctionCallItem[]> {
  throwIfAborted(signal);
  const body: Record<string, unknown> = {
    model: apiSettings.model,
    messages: createChatCompletionsMessages(input, instructions),
    stream: true,
    max_tokens: maxOutputTokens
  };
  if (tools.length) {
    body.tools = createChatCompletionsTools(tools);
    body.tool_choice = "auto";
  }
  if (useOpenRouterReasoning && apiSettings.reasoningEffort !== "none") {
    body.reasoning = {
      effort:
        apiSettings.reasoningEffort === "xhigh"
          ? "high"
          : apiSettings.reasoningEffort
    };
  }

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        ...createProviderAuthorizationHeaders(
          apiSettings,
          endpoint,
          "chat-completions"
        ),
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:5173",
        "X-Title": "ChatHTML Runtime Demo"
      },
      redirect: "error",
      signal,
      body: JSON.stringify(body)
    });
  } catch (error) {
    if (signal.aborted) {
      throw createAbortError();
    }
    throw error;
  }

  if (!response.ok || !response.body) {
    throw new Error(formatHttpError(response, await readResponseText(response)));
  }

  const calls = new Map<number, ToolCallAccumulator>();
  const finishReasons = new Set<string>();
  let buffer = "";
  let totalStreamBytes = 0;
  let doneSentinelReceived = false;
  let streamError = "";
  const decoder = new TextDecoder();

  const handlePayload = (payload: string): void => {
    if (payload === "[DONE]") {
      doneSentinelReceived = true;
      return;
    }
    let event: { choices?: unknown; error?: unknown };
    try {
      event = JSON.parse(payload) as { choices?: unknown; error?: unknown };
    } catch {
      return;
    }
    if (event.error) {
      streamError =
        extractResponsesErrorMessage(event.error) ||
        "The provider returned a streaming error.";
      return;
    }
    if (!Array.isArray(event.choices)) {
      return;
    }
    for (const candidate of event.choices) {
      if (!candidate || typeof candidate !== "object") {
        continue;
      }
      const choice = candidate as {
        delta?: Record<string, unknown>;
        finish_reason?: unknown;
      };
      const delta = choice.delta ?? {};
      writeEvent(emit, state, "content", stringDelta(delta.content));
      writeEvent(
        emit,
        state,
        "reasoning",
        stringDelta(delta.reasoning ?? delta.reasoning_content)
      );
      mergeToolCallDelta(calls, delta.tool_calls);
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        finishReasons.add(choice.finish_reason);
      }
    }
  };

  const handleLine = (line: string): void => {
    if (line.length > RESPONSES_MAX_SSE_LINE_CHARS) {
      throw new Error(
        `Chat Completions stream contains a line longer than ${RESPONSES_MAX_SSE_LINE_CHARS} characters.`
      );
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) {
      handlePayload(trimmed.slice(5).trim());
    }
  };

  const flushCompleteLines = (): void => {
    const lines = buffer.split(/\r\n|\r|\n/);
    buffer = lines.pop() ?? "";
    lines.forEach(handleLine);
  };

  const reader = response.body.getReader();
  let readerCancelPromise: Promise<void> | undefined;
  const cancelReader = (): Promise<void> => {
    readerCancelPromise ??= reader.cancel().catch(() => undefined);
    return readerCancelPromise;
  };
  const handleAbort = (): void => {
    void cancelReader();
  };
  signal.addEventListener("abort", handleAbort, { once: true });

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) {
        break;
      }
      totalStreamBytes += value.byteLength;
      if (totalStreamBytes > RESPONSES_MAX_STREAM_BYTES) {
        await cancelReader();
        throw new Error(
          `Chat Completions stream exceeds the ${RESPONSES_MAX_STREAM_BYTES} byte limit.`
        );
      }
      buffer += decoder.decode(value, { stream: true });
      flushCompleteLines();
      if (buffer.length > RESPONSES_MAX_SSE_LINE_CHARS) {
        await cancelReader();
        throw new Error(
          `Chat Completions stream contains a line longer than ${RESPONSES_MAX_SSE_LINE_CHARS} characters.`
        );
      }
    }
  } catch (error) {
    if (signal.aborted) {
      throw createAbortError();
    }
    await cancelReader();
    throw error;
  } finally {
    signal.removeEventListener("abort", handleAbort);
    if (signal.aborted) {
      await cancelReader();
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    buffer.split(/\r\n|\r|\n/).forEach(handleLine);
  }

  const failureReason = [...finishReasons].find(
    (reason) => reason !== "stop" && reason !== "tool_calls" && reason !== "function_call"
  );
  if (streamError) {
    throw new ResponsesTerminalFailureError({
      message: streamError,
      status: "failed"
    });
  }
  if (failureReason) {
    throw new ResponsesTerminalFailureError({
      message: `Chat Completions API stopped with ${failureReason}.`,
      status: "incomplete",
      incompleteReason: failureReason
    });
  }
  if (!doneSentinelReceived && !finishReasons.size) {
    throw new ResponsesTerminalFailureError({
      message: "Chat Completions API stream ended before a terminal event.",
      status: "incomplete",
      incompleteReason: "stream_eof"
    });
  }

  return [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, call]) => ({
      type: "function_call" as const,
      id: call.id || `call_${index}`,
      call_id: call.id || `call_${index}`,
      name: call.name,
      arguments: call.arguments || "{}"
    }))
    .filter((call) => call.name);
}
