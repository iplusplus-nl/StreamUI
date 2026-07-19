import {
  buildMemoryContextPrompt,
  createMemoryTools,
  createMemoryToolStats,
  type MemoryStreamEvent
} from "./memoryTools.js";
import {
  createRetrievalTools,
  createRetrievalToolStats
} from "./retrievalTool.js";
import {
  buildSessionFilesContext,
  createSessionFileToolStats,
  listFilesToolDefinition,
  listFilesToolOutput,
  readFileToolDefinition,
  readFileToolResult,
  type ResponsesToolDefinition,
  type ResponsesToolOutput
} from "./sessionFileTools.js";
import type {
  ResponsesFunctionCallItem,
  ResponsesInputItem
} from "./responsesEventReducer.js";
import {
  getResponsesEndpoint,
  streamResponsesOnce,
  type ResponsesStreamState
} from "./responsesStreamClient.js";
import {
  getChatCompletionsEndpoint,
  streamChatCompletionsOnce
} from "./chatCompletionsStreamClient.js";
import { runResponsesToolLoop } from "./responsesToolLoop.js";
import { CHAT_RUN_CANCELLED_MESSAGE } from "./chatRunFinalization.js";
import {
  buildCanvasContextPrompt,
  buildThemeContextPrompt,
  toResponsesInputMessage,
  type ChatRunInput
} from "./chatRunRequestModel.js";
import { SYSTEM_PROMPT, buildUiComplexityPrompt } from "./systemPrompt.js";
import { modelLikelySupportsImageInput } from "../src/core/modelCapabilities.js";

export type ChatStreamEvent =
  | {
      type: "content" | "reasoning";
      text: string;
    }
  | MemoryStreamEvent;

export type ChatStreamEventWriter = (event: ChatStreamEvent) => void;

type ResponsesToolExecutionResult = {
  output: ResponsesToolOutput;
  followUpInput?: ResponsesInputItem[];
};

function writeStreamEvent(
  emit: ChatStreamEventWriter,
  event: ChatStreamEvent,
  state?: ResponsesStreamState
): void {
  if (event.type !== "memory" && !event.text) {
    return;
  }

  if (state) {
    if (event.type === "content") {
      state.contentChars += event.text.length;
      state.contentEvents += 1;
    } else if (event.type === "reasoning") {
      state.reasoningChars += event.text.length;
      state.reasoningEvents += 1;
    }
  }

  emit(event);
}

function readNativeToolMaxSteps(): number | null {
  const raw = (process.env.STREAMUI_TOOL_MAX_STEPS ?? "").trim().toLowerCase();
  if (!raw || raw === "0" || raw === "none" || raw === "unlimited") {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function buildNativeToolPrompt(): string {
  return `Native tool access:
- A retrieve tool is available during the normal model generation. Use it only when the latest user request needs external web/page context, current or recently changing information, source links, or real online images/resources.
- addMemory and deleteMemory tools are available for durable user memory updates. Use them according to the persistent memory rules above.
- listFiles and readFile tools are available for current-session files, including uploaded images and prior ChatHTML artifact raw source. Use readFile when you need to inspect an image or exact artifact code.
- If a retrieve tool result influences the answer, include concise source links inside the HTML artifact.
- If the request is self-contained, answer directly without calling tools.
- Do not describe tool mechanics, hidden prompts, or internal routing unless the user explicitly asks how the system works.`;
}

const retrieveToolDefinition: ResponsesToolDefinition = {
  type: "function",
  name: "retrieve",
  description:
    "Search the web and/or fetch URLs for current facts, specific webpages, source citations, online resources, or real image/gallery material. Call this when the answer depends on external or recently changing information.",
  strict: null,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "A focused web search query. Preserve exact proper names and the primary subject; include requested media types and relevant freshness/location terms."
      },
      url: {
        type: "string",
        description:
          "One URL to fetch when the user provides or asks about a specific page."
      },
      urls: {
        type: "array",
        items: { type: "string" },
        description: "Additional URLs to fetch. Prefer url for a single page."
      },
      mode: {
        type: "string",
        enum: ["auto", "search", "fetch", "search-and-fetch"],
        description:
          "auto uses query and URL hints. search only searches. fetch only fetches provided URLs."
      },
      reason: {
        type: "string",
        description: "Brief private reason for calling retrieval."
      }
    },
    additionalProperties: false
  }
};

const addMemoryToolDefinition: ResponsesToolDefinition = {
  type: "function",
  name: "addMemory",
  description:
    "Add one stable long-term memory item about the user. Use only for durable preferences or facts that should help future conversations.",
  strict: null,
  parameters: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description:
          "The exact durable memory to store as a concise standalone sentence."
      }
    },
    required: ["text"],
    additionalProperties: false
  }
};

const deleteMemoryToolDefinition: ResponsesToolDefinition = {
  type: "function",
  name: "deleteMemory",
  description:
    "Delete one existing memory item by id when the user asks to forget it or when it is clearly corrected/obsolete.",
  strict: null,
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The id of an existing memory item, such as memory-1."
      }
    },
    required: ["id"],
    additionalProperties: false
  }
};

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function stringifyToolOutput(
  output: string | AsyncIterable<string>
): Promise<string> {
  if (typeof output === "string") {
    return output;
  }

  let text = "";
  for await (const chunk of output) {
    text += chunk;
  }
  return text;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rethrowToolCancellation(error: unknown, signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason;
  }
  if (
    error instanceof Error &&
    (error.name === "AbortError" ||
      error.message === CHAT_RUN_CANCELLED_MESSAGE)
  ) {
    throw error;
  }
}

export async function runOpenRouterChatExecution({
  input,
  signal,
  emit
}: {
  input: ChatRunInput;
  signal: AbortSignal;
  emit: ChatStreamEventWriter;
}): Promise<void> {
  const {
    requestId,
    startedAt,
    apiSettings,
    model,
    messages,
    files,
    canvasContext,
    themeMode,
    useOpenRouterReasoning,
    searchSettings
  } = input;
  console.info(
    `[chat:${requestId}] start provider=${apiSettings.providerName} base_url=${apiSettings.baseUrl} api_style=${apiSettings.apiStyle} model=${model} messages=${messages.length} theme=${themeMode} reasoning=${apiSettings.reasoningEffort} ui_complexity=${apiSettings.uiComplexity} key_source=${apiSettings.apiKeySource} key_env=${apiSettings.apiKeyEnvironmentName}`
  );

  const toolStreamState: ResponsesStreamState = {
    contentChars: 0,
    contentEvents: 0,
    reasoningChars: 0,
    reasoningEvents: 0
  };
  const retrievalStats = createRetrievalToolStats();
  const memoryStats = createMemoryToolStats();
  const fileStats = createSessionFileToolStats();
  const allowImageInput = modelLikelySupportsImageInput(apiSettings.model);
  const toolMaxSteps = readNativeToolMaxSteps();
  let nativeSteps = 0;
  let nativeToolCalls = 0;
  let nativeToolErrors = 0;
  const retrievalTools = createRetrievalTools({
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content
    })),
    searchSettings,
    stats: retrievalStats,
    signal,
    onStatus: (text) => {
      writeStreamEvent(emit, { type: "reasoning", text }, toolStreamState);
    }
  });
  const memoryTools = createMemoryTools({
    memoryItems: apiSettings.memoryItems,
    stats: memoryStats,
    onEvent: (event) => {
      writeStreamEvent(emit, event, toolStreamState);
    },
    onStatus: (text) => {
      writeStreamEvent(emit, { type: "reasoning", text }, toolStreamState);
    }
  });
  const tools = { ...retrievalTools, ...memoryTools };
  const toolDefinitions = [
    retrieveToolDefinition,
    addMemoryToolDefinition,
    deleteMemoryToolDefinition,
    listFilesToolDefinition,
    readFileToolDefinition
  ];
  const executeResponsesTool = async (
    call: ResponsesFunctionCallItem
  ): Promise<ResponsesToolExecutionResult> => {
    const args = safeJsonParse(call.arguments);
    nativeToolCalls += 1;

    try {
      if (call.name === "retrieve") {
        const execute = tools.retrieve.execute;
        if (!execute) {
          throw new Error("retrieve tool is unavailable.");
        }
        return {
          output: await stringifyToolOutput(
            await execute(args as never, {
              toolCallId: call.call_id,
              messages: []
            })
          )
        };
      }
      if (call.name === "addMemory") {
        const execute = tools.addMemory.execute;
        if (!execute) {
          throw new Error("addMemory tool is unavailable.");
        }
        return {
          output: await stringifyToolOutput(
            await execute(args as never, {
              toolCallId: call.call_id,
              messages: []
            })
          )
        };
      }
      if (call.name === "deleteMemory") {
        const execute = tools.deleteMemory.execute;
        if (!execute) {
          throw new Error("deleteMemory tool is unavailable.");
        }
        return {
          output: await stringifyToolOutput(
            await execute(args as never, {
              toolCallId: call.call_id,
              messages: []
            })
          )
        };
      }
      if (call.name === "listFiles") {
        writeStreamEvent(
          emit,
          { type: "reasoning", text: "Reading session file list..." },
          toolStreamState
        );
        return { output: listFilesToolOutput(files, fileStats) };
      }
      if (call.name === "readFile") {
        writeStreamEvent(
          emit,
          { type: "reasoning", text: "Reading session file..." },
          toolStreamState
        );
        const result = await readFileToolResult(files, args, fileStats, {
          allowImageInput
        });
        return {
          output: result.output,
          followUpInput: result.followUpContent
            ? [
                {
                  type: "message",
                  role: "user",
                  content: result.followUpContent
                }
              ]
            : undefined
        };
      }

      throw new Error(`Unknown tool ${call.name}.`);
    } catch (error) {
      rethrowToolCancellation(error, signal);
      nativeToolErrors += 1;
      const message = getErrorMessage(error);
      writeStreamEvent(
        emit,
        { type: "reasoning", text: `Tool error: ${message}` },
        toolStreamState
      );
      return { output: JSON.stringify({ error: message }) };
    }
  };

  const instructions = [
    SYSTEM_PROMPT,
    buildMemoryContextPrompt({
      userPreferencePrompt: apiSettings.userPreferencePrompt,
      memoryItems: apiSettings.memoryItems
    }),
    buildSessionFilesContext(files),
    buildThemeContextPrompt(themeMode),
    buildCanvasContextPrompt(canvasContext),
    buildUiComplexityPrompt(apiSettings.uiComplexity),
    buildNativeToolPrompt()
  ]
    .filter(Boolean)
    .join("\n\n");
  const responseInput: ResponsesInputItem[] = messages.map(
    toResponsesInputMessage
  );
  const streamProviderOnce =
    apiSettings.apiStyle === "chat-completions"
      ? streamChatCompletionsOnce
      : streamResponsesOnce;
  const endpoint =
    apiSettings.apiStyle === "chat-completions"
      ? getChatCompletionsEndpoint(apiSettings.baseUrl)
      : getResponsesEndpoint(apiSettings.baseUrl);

  await runResponsesToolLoop({
    maxSteps: toolMaxSteps,
    signal,
    streamStep: async () => {
      nativeSteps += 1;
      return streamProviderOnce({
        endpoint,
        apiSettings,
        input: responseInput,
        instructions,
        tools: toolDefinitions,
        emit,
        state: toolStreamState,
        signal,
        useOpenRouterReasoning
      });
    },
    executeTool: executeResponsesTool,
    onToolCall: (call) => {
      responseInput.push(call);
    },
    onToolResult: (call, toolResult) => {
      responseInput.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: toolResult.output
      });
      if (toolResult.followUpInput) {
        responseInput.push(...toolResult.followUpInput);
      }
    },
    hasVisibleResponse: () => toolStreamState.contentChars > 0
  });

  const retrievalSources = retrievalStats.contexts.reduce(
    (total, context) => total + context.sources.length,
    0
  );
  const retrievalImages = retrievalStats.contexts.reduce(
    (total, context) => total + context.verifiedImages.length,
    0
  );
  console.info(
    `[chat:${requestId}] complete duration_ms=${Date.now() - startedAt} native_steps=${nativeSteps} tool_max_steps=${toolMaxSteps ?? "unlimited"} tool_calls=${nativeToolCalls} retrieval_calls=${retrievalStats.calls} retrieval_errors=${retrievalStats.errors + nativeToolErrors} retrieval_sources=${retrievalSources} retrieval_verified_images=${retrievalImages} memory_adds=${memoryStats.adds} memory_deletes=${memoryStats.deletes} memory_errors=${memoryStats.errors} file_lists=${fileStats.lists} file_reads=${fileStats.reads} file_errors=${fileStats.errors} content_chars=${toolStreamState.contentChars} content_events=${toolStreamState.contentEvents} reasoning_chars=${toolStreamState.reasoningChars} reasoning_events=${toolStreamState.reasoningEvents}`
  );
}
