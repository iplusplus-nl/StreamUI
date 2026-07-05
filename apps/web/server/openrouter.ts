import type { Request, Response } from "express";
import {
  buildMemoryContextPrompt,
  createMemoryTools,
  createMemoryToolStats,
  normalizeMemorySettings,
  type MemoryItem,
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
  normalizeSessionFiles,
  readFileToolDefinition,
  readFileToolResult,
  type SessionFile,
  type ResponsesInputContentPart,
  type ResponsesToolDefinition,
  type ResponsesToolOutput
} from "./sessionFileTools.js";
import {
  getSessionStateKeyFromClientId,
  patchSessionMessage,
  upsertSessionMessages,
  type SessionMessageInput,
  type SessionMessagePatch,
  type StoredSessionFile
} from "./sessions.js";
import {
  getRuntimeApiDefaults,
  readRuntimeApiCredentials,
  type ApiKeySource
} from "./runtimeApiSettings.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

type ChatRole = "user" | "assistant" | "system";
type OpenRouterReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "none";

type RuntimeApiSettings = {
  providerName: string;
  baseUrl: string;
  apiKeySource: ApiKeySource;
  apiKeyEnvironmentName: string;
  apiKey: string;
  model: string;
  reasoningEffort: OpenRouterReasoningEffort;
  userPreferencePrompt: string;
  memoryItems: MemoryItem[];
};

type ClientChatMessage = {
  role: ChatRole;
  content: string;
};

type ResponsesInputMessage =
  | {
      type: "message";
      role: "user";
      content: ResponsesInputContentPart[];
    }
  | {
      type: "message";
      role: "assistant";
      id: string;
      status: "completed";
      content: Array<{ type: "output_text"; text: string; annotations: unknown[] }>;
    };

type ResponsesFunctionCallItem = {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
};

type ResponsesFunctionCallOutputItem = {
  type: "function_call_output";
  call_id: string;
  output: ResponsesToolOutput;
};

type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem;

type CanvasContext = {
  viewportWidth: number;
  viewportHeight: number;
  canvasWidth: number;
  initialCanvasHeight: number;
  devicePixelRatio: number;
};

type PageThemeMode = "day" | "night";

type StreamEvent =
  | {
      type: "content" | "reasoning";
      text: string;
    }
  | MemoryStreamEvent;

type ChatDoneEvent = {
  type: "done";
  status: "complete" | "error";
  error?: string;
};

type SequencedStreamEvent = (StreamEvent | ChatDoneEvent) & {
  runId: string;
  seq: number;
};

type StreamEventWriter = (event: StreamEvent) => void;

type ToolStreamState = {
  contentChars: number;
  contentEvents: number;
  reasoningChars: number;
  reasoningEvents: number;
};

type ResponsesToolExecutionResult = {
  output: ResponsesToolOutput;
  followUpInput?: ResponsesInputItem[];
};

type ChatRequestBody = {
  messages?: unknown;
  files?: unknown;
  canvas?: unknown;
  themeMode?: unknown;
  apiSettings?: unknown;
  searchSettings?: unknown;
  clientId?: unknown;
  sessionId?: unknown;
  runId?: unknown;
  userMessage?: unknown;
  assistantMessage?: unknown;
};

type ChatRunInput = {
  requestId: string;
  startedAt: number;
  runId: string;
  stateKey: string;
  sessionId?: string;
  userMessage?: SessionMessageInput;
  assistantMessage?: SessionMessageInput;
  apiSettings: RuntimeApiSettings;
  model: string;
  messages: ClientChatMessage[];
  files: SessionFile[];
  canvasContext: CanvasContext;
  themeMode: PageThemeMode;
  useOpenRouterReasoning: boolean;
  searchSettings?: unknown;
};

type ChatRun = {
  id: string;
  input: ChatRunInput;
  events: SequencedStreamEvent[];
  subscribers: Set<(event: SequencedStreamEvent) => void>;
  sequence: number;
  raw: string;
  reasoning: string;
  status: "running" | "complete" | "error";
  error?: string;
  persistTimer?: NodeJS.Timeout;
  persistPromise: Promise<void>;
  cleanupTimer?: NodeJS.Timeout;
};

const chatRuns = new Map<string, ChatRun>();
const CHAT_RUN_TTL_MS = 10 * 60 * 1000;
const STREAM_PERSIST_INTERVAL_MS = 500;

function flushResponse(res: Response): void {
  const flush = (res as Response & { flush?: () => void }).flush;
  if (typeof flush === "function") {
    flush.call(res);
  }
}

function stringValue(value: unknown, maxLength = 2_000): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeStringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const seen = new Set<string>();
  const values: string[] = [];
  for (const item of input) {
    const value = stringValue(item, 180);
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
  }

  return values.length ? values : undefined;
}

function extractBetweenTag(raw: string, tagName: "sessiontitle" | "chat") {
  const openPattern = new RegExp(`<${tagName}\\b[^>]*>`, "i");
  const openMatch = openPattern.exec(raw);
  if (!openMatch || openMatch.index === undefined) {
    return { content: "", hasOpen: false, hasClose: false };
  }

  const start = openMatch.index + openMatch[0].length;
  const closePattern = new RegExp(`</${tagName}>`, "i");
  const closeMatch = closePattern.exec(raw.slice(start));
  const end = closeMatch ? start + closeMatch.index : raw.length;

  return {
    content: raw.slice(start, end),
    hasOpen: true,
    hasClose: Boolean(closeMatch)
  };
}

function extractStreamUi(raw: string) {
  const openPattern = /<streamui\b[^>]*>/i;
  const openMatch = openPattern.exec(raw);
  if (!openMatch || openMatch.index === undefined) {
    return { content: "", hasOpen: false, hasClose: false };
  }

  const start = openMatch.index + openMatch[0].length;
  const closePattern = /<\/streamui>/i;
  const closeMatch = closePattern.exec(raw.slice(start));
  const end = closeMatch ? start + closeMatch.index : raw.length;

  return {
    content: raw.slice(start, end),
    hasOpen: true,
    hasClose: Boolean(closeMatch)
  };
}

function stripProtocolTags(raw: string): string {
  return raw
    .replace(/<sessiontitle\b[^>]*>[\s\S]*?<\/sessiontitle>/gi, "")
    .replace(/<chat\b[^>]*>/gi, "")
    .replace(/<\/chat>/gi, "")
    .replace(/<streamui\b[^>]*>[\s\S]*?<\/streamui>/gi, "")
    .replace(/<streamui\b[^>]*>[\s\S]*$/gi, "")
    .trim();
}

function getStreamUiMessagePatch(
  raw: string,
  reasoning: string,
  status: "streaming" | "complete" | "error",
  streamSequence: number,
  generationRunId: string,
  error?: string
): SessionMessagePatch {
  const chat = extractBetweenTag(raw, "chat");
  const sessionTitle = extractBetweenTag(raw, "sessiontitle");
  const streamui = extractStreamUi(raw);
  const content = chat.content.trim() || (!streamui.hasOpen ? stripProtocolTags(raw) : "");

  return {
    content: content || (status === "error" && !raw ? "I could not complete that request." : ""),
    rawStream: raw,
    reasoning: reasoning || undefined,
    ...(sessionTitle.hasClose && sessionTitle.content.trim()
      ? { sessionTitle: sessionTitle.content.trim() }
      : {}),
    hasStreamUi: streamui.hasOpen,
    streamUiComplete: streamui.hasClose,
    generationRunId,
    streamSequence,
    status,
    ...(error ? { error } : {})
  };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.round(Math.min(max, Math.max(min, value)));
}

function normalizeCanvasContext(input: unknown): CanvasContext {
  const canvas =
    typeof input === "object" && input !== null
      ? (input as Partial<CanvasContext>)
      : {};
  const viewportWidth = clampNumber(canvas.viewportWidth, 1280, 320, 3840);
  const viewportHeight = clampNumber(canvas.viewportHeight, 720, 320, 2400);
  const canvasWidth = clampNumber(
    canvas.canvasWidth,
    Math.min(900, viewportWidth - 96),
    280,
    1400
  );
  const initialCanvasHeight = clampNumber(
    canvas.initialCanvasHeight,
    Math.round(canvasWidth * 0.62),
    180,
    1000
  );
  const devicePixelRatio = clampNumber(canvas.devicePixelRatio, 1, 1, 4);

  return {
    viewportWidth,
    viewportHeight,
    canvasWidth,
    initialCanvasHeight,
    devicePixelRatio
  };
}

function normalizeThemeMode(input: unknown): PageThemeMode {
  if (input === "day" || input === "light") {
    return "day";
  }

  return "night";
}

function buildThemeContextPrompt(themeMode: PageThemeMode): string {
  const isNight = themeMode === "night";
  const label = isNight ? "dark" : "light";
  const background = isNight ? "#050505" : "#ffffff";

  return `Current page background preference:
- The user is viewing StreamUI on a ${label} page background, approximately ${background}.
- Unless the user explicitly asks for a specific background color/theme, or the task clearly benefits from a special backdrop, make the artifact suitable for this ${label} surrounding page.
- For ordinary replies using streamui-response and streamui-chat, rely on the built-in transparent styles.
- For custom visual artifacts, keep the root transparent when possible. If a root surface should match the surrounding app background, use var(--streamui-page-bg) instead of hardcoding ${background}; StreamUI updates that variable when the user toggles the page theme.
- Use the built-in theme variables for adaptive basics: --streamui-page-bg, --streamui-text, --streamui-muted, --streamui-link, --streamui-button-bg, --streamui-button-text, --streamui-secondary-border, and --streamui-secondary-text.
- Do not assume the opposite page theme unless the user asks for it.`;
}

function buildCanvasContextPrompt(canvas: CanvasContext): string {
  const ratio = (canvas.canvasWidth / canvas.initialCanvasHeight).toFixed(2);

  return `Current StreamUI canvas context:
- The artifact is rendered as the assistant message itself, not as a framed preview card or app panel.
- Current canvas width is about ${canvas.canvasWidth}px inside a ${canvas.viewportWidth}px viewport.
- The initial visible fold is about ${canvas.initialCanvasHeight}px tall, roughly ${ratio}:1 width-to-height.
- The canvas auto-expands downward to fit your content. There is no fixed artifact height.
- Design for a vertical conversation canvas: use width: 100%, responsive max-widths, and natural document flow.
- Do not create internal scroll containers for the main artifact. Avoid fixed heights, 100vh layouts, and overflow: auto on the root.
- For normal replies, use the built-in transparent assistant prose classes: streamui-response and streamui-chat.
- The default reply should usually be:
  <section class="streamui-response"><div class="streamui-chat"><p>...</p></div></section>
- For theme-aware custom styling, use the built-in --streamui-* variables. Do not hardcode the page background color when you intend to blend into the surrounding app.
- Put all conversational language inside the HTML artifact. Keep <chat></chat> empty.
- Be natural and direct. Do not adopt a special persona.
- For visual, interactive, educational, spatial, or exploratory requests, make a distinctive crafted artifact rather than a conventional rounded-card layout.
- Avoid generic colorful cards, dashboards, KPI tiles, pricing panels, feature grids, and SaaS-like composition unless explicitly requested.
- Prefer art-directed compositions: annotated scenes, editorial spreads, maps, instruments, timelines, specimen sheets, exploded diagrams, posters, stage sets, spatial canvases, layered cutaways, kinetic miniatures, or object-focused interfaces.
- Use cards only when structurally necessary, and make surfaces feel integrated through precise spacing, restrained radius, tactile borders, shadow, texture, unusual geometry, or material contrast.
- Keep the design polished: coherent palette, strong typographic hierarchy, balanced negative space, clear focal point, and details that reward inspection without becoming clutter.
- Keep the artifact focused: choose a strong visual idea and avoid repetitive filler, giant SVG paths, large embedded data, or exhaustive code unless the user explicitly asks for it.
- The user may attach images. Inspect uploaded images directly and treat them as first-class context for analysis, OCR, comparison, critique, or visual redesign requests.
- When useful, combine observations from uploaded images with retrieve tool sources in one coherent HTML artifact.
- If retrieve tool context is provided, use it for URLs, external resources, current information, source images, and page details.
- If you use retrieval information, render source links inside the HTML. Prefer concrete links and citations over vague "from the web" language.
- Prefer real external images, media, documents, demos, datasets, official pages, and primary references over invented placeholders when they improve the response.
- For visual or research-like requests, synthesize the provided complementary sources or resource types into one coherent HTML artifact.
- When embedding external media, use direct HTTPS URLs, meaningful alt text, lazy loading when possible, captions, and nearby source links.
- For gallery, photo, picture, image, wallpaper, or visual-reference requests, real imagery is required. Use "Verified image URLs" when provided, copy those URLs exactly into <img src>, do not modify provider URL paths, query strings, or CDN parameters, and include source links.
- If retrieval provides too few direct image URLs for the requested gallery, say so inside the artifact and show source links instead of rendering broken image tags.
- The iframe may use HTTPS images, media, links, stylesheets, scripts, and CORS-friendly fetches when they directly help the user's request.
- Prefer retrieve tool excerpts for reading web pages. Runtime fetch cannot read most ordinary pages because of browser CORS.
- For controls that should continue the conversation, use data-streamui-prompt on the clicked element; StreamUI will send that prompt as the next user message and call the model again. Use normal <a href="https://..."> links only for navigation, and ordinary JavaScript-only controls only for local artifact state.
- Do not create default Back/Previous/Return actions after a conversation action. Avoid labels like Back, Previous, Return to list, 返回, 上一步, 回到列表, 返回选择方向, or 返回低因列表; this is a chat, so history is already visible. Continue forward with deeper, comparative, shorter, example, or alternate-angle actions instead.
- For custom visuals, make progress visible while streaming by alternating small style islands and matching visible HTML.
- After <streamui>, emit visible HTML quickly. If custom CSS is needed, use one tiny <style> block, then immediately emit the matching HTML.
- Output exactly one <streamui> block, keep it open until the entire artifact is finished, and never continue HTML outside it.
- Keep each custom style island around 600 characters or less. Do not output one huge global CSS block before the visible canvas.
- Do not use vh, dvh, svh, or lvh units for artifact section heights; the iframe auto-expands, so viewport-height layouts can create resize feedback loops. Prefer intrinsic flow, aspect-ratio, clamp(), min-height in px/rem, or content-driven sizing.
- The first visible artifact should establish a strong visual direction quickly: a focal element, styled title area, scene scaffold, diagram frame, or spatial composition.
- Keep <script> last. The script only runs after the stream is complete.`;
}

function normalizeMessages(input: unknown): ClientChatMessage[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((message): message is Partial<ClientChatMessage> => {
      return (
        typeof message === "object" &&
        message !== null &&
        typeof (message as Partial<ClientChatMessage>).content === "string"
      );
    })
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content).slice(0, 20_000)
    }));
}

function toResponsesInputMessage(
  message: ClientChatMessage,
  index: number
): ResponsesInputMessage {
  if (message.role === "assistant") {
    return {
      type: "message",
      role: "assistant",
      id: `msg_${index}`,
      status: "completed",
      content: [
        {
          type: "output_text",
          text: message.content,
          annotations: []
        }
      ]
    };
  }

  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: message.content || "Please respond using the current session context."
      }
    ]
  };
}

function writeStreamEvent(
  emit: StreamEventWriter,
  event: StreamEvent,
  state?: ToolStreamState
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

function normalizeSessionMessageInput(input: unknown): SessionMessageInput | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const message = input as Partial<SessionMessageInput>;
  if (
    typeof message.id !== "string" ||
    (message.role !== "user" && message.role !== "assistant")
  ) {
    return undefined;
  }

  return {
    id: message.id,
    role: message.role,
    content: typeof message.content === "string" ? message.content : "",
    fileIds: normalizeStringArray(message.fileIds),
    reasoning: typeof message.reasoning === "string" ? message.reasoning : undefined,
    sessionTitle:
      typeof message.sessionTitle === "string" ? message.sessionTitle : undefined,
    rawStream: typeof message.rawStream === "string" ? message.rawStream : undefined,
    hasStreamUi: Boolean(message.hasStreamUi),
    streamUiComplete: Boolean(message.streamUiComplete),
    artifactContext:
      message.artifactContext && typeof message.artifactContext === "object"
        ? message.artifactContext
        : undefined,
    runtimeErrors: Array.isArray(message.runtimeErrors)
      ? message.runtimeErrors
      : undefined,
    repairOfMessageId:
      typeof message.repairOfMessageId === "string"
        ? message.repairOfMessageId
        : undefined,
    repairAttempt:
      typeof message.repairAttempt === "number" &&
      Number.isFinite(message.repairAttempt)
        ? Math.max(1, Math.round(message.repairAttempt))
        : undefined,
    generationRunId:
      typeof message.generationRunId === "string"
        ? message.generationRunId
        : undefined,
    streamSequence:
      typeof message.streamSequence === "number" &&
      Number.isFinite(message.streamSequence)
        ? Math.max(0, Math.round(message.streamSequence))
        : undefined,
    status:
      message.status === "streaming" ||
      message.status === "complete" ||
      message.status === "error"
        ? message.status
        : message.role === "assistant"
          ? "complete"
          : undefined,
    error: typeof message.error === "string" ? message.error : undefined
  };
}

function createChatRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createChatRunInput(body: ChatRequestBody, requestId: string): ChatRunInput {
  const apiSettings = readRuntimeApiSettings(body.apiSettings);
  const model = apiSettings.model;
  const messages = normalizeMessages(body.messages);
  const files = normalizeSessionFiles(body.files);
  const canvasContext = normalizeCanvasContext(body.canvas);
  const themeMode = normalizeThemeMode(body.themeMode);
  const userMessage = normalizeSessionMessageInput(body.userMessage);
  const assistantMessage = normalizeSessionMessageInput(body.assistantMessage);
  const requestedRunId = stringValue(body.runId, 160);
  const stateKey = getSessionStateKeyFromClientId(body.clientId);
  const runId =
    requestedRunId ||
    stringValue(assistantMessage?.generationRunId, 160) ||
    createChatRunId();

  return {
    requestId,
    startedAt: Date.now(),
    runId,
    stateKey,
    sessionId: stringValue(body.sessionId, 160) || undefined,
    userMessage:
      userMessage?.role === "user"
        ? {
            ...userMessage,
            status: "complete"
          }
        : undefined,
    assistantMessage:
      assistantMessage?.role === "assistant"
        ? {
            ...assistantMessage,
            generationRunId: runId,
            streamSequence: assistantMessage.streamSequence ?? 0,
            status: "streaming"
          }
        : undefined,
    apiSettings,
    model,
    messages,
    files,
    canvasContext,
    themeMode,
    useOpenRouterReasoning: isOpenRouterRuntime(apiSettings),
    searchSettings: body.searchSettings
  };
}

function writeNdjsonHeaders(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.socket?.setNoDelay(true);
  res.flushHeaders();
}

function writeResponseEvent(
  res: Response,
  event: SequencedStreamEvent
): boolean {
  if (res.destroyed || res.writableEnded) {
    return false;
  }

  try {
    res.write(`${JSON.stringify(event)}\n`);
    flushResponse(res);
    return true;
  } catch {
    return false;
  }
}

function endResponse(res: Response): void {
  if (!res.destroyed && !res.writableEnded) {
    res.end();
  }
}

function attachChatRun(
  req: Request,
  res: Response,
  run: ChatRun,
  afterSequence: number
): void {
  writeNdjsonHeaders(res);

  let closed = false;
  const close = () => {
    closed = true;
    run.subscribers.delete(write);
  };
  const write = (event: SequencedStreamEvent) => {
    if (closed) {
      return;
    }
    if (!writeResponseEvent(res, event)) {
      close();
      return;
    }
    if (event.type === "done") {
      close();
      endResponse(res);
    }
  };

  req.on("close", close);
  res.on("close", close);

  for (const event of run.events) {
    if (event.seq <= afterSequence) {
      continue;
    }
    write(event);
    if (closed) {
      return;
    }
  }

  if (run.status !== "running") {
    close();
    endResponse(res);
    return;
  }

  run.subscribers.add(write);
}

function appendRunEvent(run: ChatRun, event: StreamEvent | ChatDoneEvent): void {
  const sequenced = {
    ...event,
    runId: run.id,
    seq: run.sequence + 1
  } as SequencedStreamEvent;
  run.sequence = sequenced.seq;
  run.events.push(sequenced);

  for (const subscriber of Array.from(run.subscribers)) {
    subscriber(sequenced);
  }
}

function queueRunPersistence(
  run: ChatRun,
  status: "streaming" | "complete" | "error",
  error?: string
): Promise<void> {
  const sessionId = run.input.sessionId;
  const assistantMessageId = run.input.assistantMessage?.id;
  if (!sessionId || !assistantMessageId) {
    return Promise.resolve();
  }

  const patch = getStreamUiMessagePatch(
    run.raw,
    run.reasoning,
    status,
    run.sequence,
    run.id,
    error
  );
  run.persistPromise = run.persistPromise
    .then(() =>
      patchSessionMessage({
        stateKey: run.input.stateKey,
        sessionId,
        messageId: assistantMessageId,
        patch
      })
    )
    .catch((persistError) => {
      console.warn(
        `[chat:${run.input.requestId}] could not persist stream state`,
        persistError
      );
    });

  return run.persistPromise;
}

function scheduleRunPersistence(run: ChatRun): void {
  if (run.status !== "running" || run.persistTimer) {
    return;
  }

  run.persistTimer = setTimeout(() => {
    run.persistTimer = undefined;
    void queueRunPersistence(run, "streaming");
  }, STREAM_PERSIST_INTERVAL_MS);
}

async function flushRunPersistence(
  run: ChatRun,
  status: "streaming" | "complete" | "error",
  error?: string
): Promise<void> {
  if (run.persistTimer) {
    clearTimeout(run.persistTimer);
    run.persistTimer = undefined;
  }

  await queueRunPersistence(run, status, error);
}

function scheduleRunCleanup(run: ChatRun): void {
  if (run.cleanupTimer) {
    clearTimeout(run.cleanupTimer);
  }

  run.cleanupTimer = setTimeout(() => {
    if (!run.subscribers.size) {
      chatRuns.delete(run.id);
    }
  }, CHAT_RUN_TTL_MS);
}

function emitRunStreamEvent(run: ChatRun, event: StreamEvent): void {
  if (event.type === "content") {
    run.raw += event.text;
  } else if (event.type === "reasoning") {
    run.reasoning += event.text;
  }

  appendRunEvent(run, event);
  scheduleRunPersistence(run);
}

async function persistInitialRunMessages(run: ChatRun): Promise<void> {
  const { sessionId, userMessage, assistantMessage, files } = run.input;
  if (!sessionId || !assistantMessage) {
    return;
  }

  await upsertSessionMessages({
    stateKey: run.input.stateKey,
    sessionId,
    messages: [userMessage, assistantMessage].filter(
      (message): message is SessionMessageInput => Boolean(message)
    ),
    files: files as StoredSessionFile[]
  });
}

function finishChatRun(
  run: ChatRun,
  status: "complete" | "error",
  error?: string
): void {
  run.status = status;
  run.error = error;
  appendRunEvent(run, {
    type: "done",
    status,
    ...(error ? { error } : {})
  });
  void flushRunPersistence(run, status, error).finally(() => {
    scheduleRunCleanup(run);
  });
}

async function executeChatRun(run: ChatRun): Promise<void> {
  try {
    await persistInitialRunMessages(run);
    await runOpenRouterChat(run, (event) => emitRunStreamEvent(run, event));
    finishChatRun(run, "complete");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown chat proxy error.";
    console.error(`[chat:${run.input.requestId}] error ${message}`);
    finishChatRun(run, "error", message);
  }
}

function startChatRun(input: ChatRunInput): ChatRun {
  const run: ChatRun = {
    id: input.runId,
    input,
    events: [],
    subscribers: new Set(),
    sequence: 0,
    raw: input.assistantMessage?.rawStream ?? "",
    reasoning: input.assistantMessage?.reasoning ?? "",
    status: "running",
    persistPromise: Promise.resolve()
  };

  chatRuns.set(run.id, run);
  void executeChatRun(run);
  return run;
}

function getAfterSequence(input: unknown): number {
  const value =
    typeof input === "string"
      ? Number.parseInt(input, 10)
      : typeof input === "number"
        ? input
        : 0;
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function normalizeReasoningEffort(value: unknown): OpenRouterReasoningEffort {
  const allowed = new Set<OpenRouterReasoningEffort>([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "none"
  ]);

  if (typeof value === "string" && allowed.has(value as OpenRouterReasoningEffort)) {
    return value as OpenRouterReasoningEffort;
  }

  throw new Error(
    "API settings invalid: Reasoning must be none, minimal, low, medium, high, or xhigh."
  );
}

function readRuntimeApiSettings(input: unknown): RuntimeApiSettings {
  const defaults = getRuntimeApiDefaults();
  const object =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const credentials = readRuntimeApiCredentials(input);
  const modelValue = typeof object.model === "string" ? object.model.trim() : "";
  const model =
    modelValue ||
    (Object.prototype.hasOwnProperty.call(object, "model") ? "" : defaults.model);
  const missing: string[] = [];

  if (!credentials.baseUrl) {
    missing.push("Base URL");
  }
  if (!credentials.apiKey) {
    missing.push(
      credentials.apiKeySource === "environment"
        ? credentials.apiKeyEnvironmentName
        : "API key"
    );
  }
  if (!model) {
    missing.push("Model");
  }

  if (missing.length) {
    throw new Error(`API settings missing: ${missing.join(", ")}.`);
  }

  const memorySettings = normalizeMemorySettings(object);

  return {
    ...credentials,
    model,
    reasoningEffort: normalizeReasoningEffort(
      object.reasoningEffort ?? defaults.reasoningEffort
    ),
    userPreferencePrompt: memorySettings.userPreferencePrompt,
    memoryItems: memorySettings.memoryItems
  };
}

function isOpenRouterRuntime(settings: RuntimeApiSettings): boolean {
  return (
    /openrouter/i.test(settings.providerName) ||
    settings.baseUrl.toLowerCase().includes("openrouter.ai")
  );
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
- listFiles and readFile tools are available for current-session files, including uploaded images and prior StreamUI artifact raw source. Use readFile when you need to inspect an image or exact artifact code.
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
          "A focused web search query. Use freshness terms only when current information is needed."
      },
      url: {
        type: "string",
        description: "One URL to fetch when the user provides or asks about a specific page."
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
        description: "The exact durable memory to store as a concise standalone sentence."
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

function getResponsesEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

function getResponsesReasoning(
  reasoningEffort: OpenRouterReasoningEffort,
  useOpenRouterReasoning: boolean
) {
  if (!useOpenRouterReasoning || reasoningEffort === "none") {
    return undefined;
  }

  return {
    effort: reasoningEffort === "xhigh" ? "high" : reasoningEffort
  };
}

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

function normalizeResponsesFunctionCall(input: unknown): ResponsesFunctionCallItem | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const item = input as Partial<ResponsesFunctionCallItem>;
  if (
    item.type !== "function_call" ||
    typeof item.call_id !== "string" ||
    typeof item.name !== "string"
  ) {
    return null;
  }

  return {
    type: "function_call",
    id: typeof item.id === "string" ? item.id : undefined,
    call_id: item.call_id,
    name: item.name,
    arguments: typeof item.arguments === "string" ? item.arguments : "{}"
  };
}

function mergeFunctionCall(
  map: Map<string, ResponsesFunctionCallItem>,
  call: ResponsesFunctionCallItem | null
): void {
  if (!call) {
    return;
  }

  const existing = map.get(call.call_id);
  map.set(call.call_id, {
    ...existing,
    ...call,
    arguments: call.arguments || existing?.arguments || "{}"
  });
}

function appendFunctionCallsFromOutput(
  output: unknown,
  map: Map<string, ResponsesFunctionCallItem>
): void {
  if (!Array.isArray(output)) {
    return;
  }

  for (const item of output) {
    mergeFunctionCall(map, normalizeResponsesFunctionCall(item));
  }
}

function getResponsesTextEventKey(data: Record<string, unknown>): string {
  const itemId = typeof data.item_id === "string" ? data.item_id : "";
  const outputIndex =
    typeof data.output_index === "number" ? String(data.output_index) : "";
  const contentIndex =
    typeof data.content_index === "number" ? String(data.content_index) : "";

  return [itemId, outputIndex, contentIndex].filter(Boolean).join(":") || "0";
}

function responsesContentText(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }

  const content = input as {
    type?: unknown;
    text?: unknown;
    content?: unknown;
  };
  if (
    (content.type === "output_text" || content.type === "text") &&
    typeof content.text === "string"
  ) {
    return content.text;
  }

  if (Array.isArray(content.content)) {
    return content.content.map(responsesContentText).filter(Boolean).join("");
  }

  return "";
}

export function extractResponsesOutputText(response: unknown): string {
  if (!response || typeof response !== "object") {
    return "";
  }

  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    return "";
  }

  return output
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }

      const candidate = item as { type?: unknown; content?: unknown };
      if (candidate.type !== "message" || !Array.isArray(candidate.content)) {
        return "";
      }

      return candidate.content.map(responsesContentText).filter(Boolean).join("");
    })
    .filter(Boolean)
    .join("\n");
}

function compactErrorText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripHtmlTags(value: string): string {
  return compactErrorText(
    value
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
  );
}

function looksLikeHtml(value: string): boolean {
  return /<!doctype\s+html|<html\b|<head\b|<body\b|<\/?[a-z][\s\S]*>/i.test(
    value
  );
}

function extractHtmlTitle(value: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(value);
  return match ? stripHtmlTags(match[1]) : "";
}

export function summarizeHttpErrorBody(
  value: string,
  fallback = "The provider returned an error."
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }

  const parsed = safeJsonParse(trimmed);
  const jsonMessage = responsesErrorMessage(parsed);
  if (jsonMessage) {
    return compactErrorText(jsonMessage).slice(0, 500);
  }

  if (looksLikeHtml(trimmed)) {
    const title = extractHtmlTitle(trimmed);
    const text = title || stripHtmlTags(trimmed);
    return (text || fallback).slice(0, 180);
  }

  return compactErrorText(trimmed).slice(0, 500);
}

function formatResponsesHttpError(
  response: { status: number; statusText?: string },
  bodyText: string
): string {
  const statusText = compactErrorText(response.statusText || "");
  const status = `HTTP ${response.status}${statusText ? ` ${statusText}` : ""}`;
  const detail = summarizeHttpErrorBody(bodyText, "");
  const prefix = `Responses API request failed with ${status}.`;

  if (!detail || detail.toLowerCase().includes(String(response.status))) {
    return prefix;
  }

  return `${prefix} ${detail}`;
}

function responsesErrorMessage(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }

  const error = input as {
    message?: unknown;
    code?: unknown;
    type?: unknown;
    error?: unknown;
  };
  if (typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error.error === "string" && error.error.trim()) {
    return error.error.trim();
  }
  if (error.error && typeof error.error === "object") {
    return responsesErrorMessage(error.error);
  }

  const parts = [error.type, error.code]
    .filter(
      (part): part is string =>
        typeof part === "string" && part.trim().length > 0
    )
    .map((part) => part.trim());
  return parts.join(": ");
}

function getResponsesTerminalError(event: Record<string, unknown>): string {
  const directError = responsesErrorMessage(event.error);
  if (directError) {
    return directError;
  }

  const response =
    event.response && typeof event.response === "object"
      ? (event.response as Record<string, unknown>)
      : event;
  const status = typeof response.status === "string" ? response.status : "";
  const incomplete = responsesErrorMessage(response.incomplete_details);
  if (status === "failed" || status === "cancelled" || status === "incomplete") {
    return (
      incomplete ||
      `Responses API returned ${status || "an incomplete response"}.`
    );
  }

  return incomplete;
}

async function streamResponsesOnce({
  endpoint,
  apiSettings,
  input,
  instructions,
  tools,
  emit,
  state,
  useOpenRouterReasoning
}: {
  endpoint: string;
  apiSettings: RuntimeApiSettings;
  input: ResponsesInputItem[];
  instructions: string;
  tools: ResponsesToolDefinition[];
  emit: StreamEventWriter;
  state: ToolStreamState;
  useOpenRouterReasoning: boolean;
}): Promise<ResponsesFunctionCallItem[]> {
  const body: Record<string, unknown> = {
    model: apiSettings.model,
    input,
    instructions,
    tools,
    tool_choice: "auto",
    stream: true,
    max_output_tokens: 9000
  };
  const reasoning = getResponsesReasoning(
    apiSettings.reasoningEffort,
    useOpenRouterReasoning
  );
  if (reasoning) {
    body.reasoning = reasoning;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiSettings.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:5173",
      "X-Title": "StreamUI Runtime Demo"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(formatResponsesHttpError(response, text));
  }

  const decoder = new TextDecoder();
  const calls = new Map<string, ResponsesFunctionCallItem>();
  const callsByOutputIndex = new Map<number, ResponsesFunctionCallItem>();
  const callsByItemId = new Map<string, ResponsesFunctionCallItem>();
  const textDeltaCharsByKey = new Map<string, number>();
  const contentCharsAtStart = state.contentChars;
  let terminalError = "";
  let buffer = "";

  const writeContent = (text: string, key: string) => {
    if (!text) {
      return;
    }

    textDeltaCharsByKey.set(
      key,
      (textDeltaCharsByKey.get(key) ?? 0) + text.length
    );
    writeStreamEvent(emit, { type: "content", text }, state);
  };

  const writeDoneContentIfNeeded = (data: Record<string, unknown>, text: string) => {
    const key = getResponsesTextEventKey(data);
    if (!text || (textDeltaCharsByKey.get(key) ?? 0) > 0) {
      return;
    }

    writeContent(text, key);
  };

  const handleEvent = (event: unknown) => {
    if (!event || typeof event !== "object") {
      return;
    }

    const data = event as Record<string, unknown>;
    const type = data.type;
    if (
      (type === "response.content_part.delta" ||
        type === "response.output_text.delta") &&
      typeof data.delta === "string"
    ) {
      writeContent(data.delta, getResponsesTextEventKey(data));
      return;
    }

    if (type === "response.output_text.done" && typeof data.text === "string") {
      writeDoneContentIfNeeded(data, data.text);
      return;
    }

    if (type === "response.content_part.done") {
      writeDoneContentIfNeeded(data, responsesContentText(data.part));
      return;
    }

    if (type === "response.reasoning.delta" && typeof data.delta === "string") {
      writeStreamEvent(emit, { type: "reasoning", text: data.delta }, state);
      return;
    }

    if (
      type === "response.failed" ||
      type === "response.incomplete" ||
      type === "response.cancelled"
    ) {
      terminalError = getResponsesTerminalError(data);
      return;
    }

    if (type === "response.output_item.added") {
      const call = normalizeResponsesFunctionCall(data.item);
      if (call) {
        const outputIndex =
          typeof data.output_index === "number" ? data.output_index : undefined;
        if (typeof outputIndex === "number") {
          callsByOutputIndex.set(outputIndex, call);
        }
        if (call.id) {
          callsByItemId.set(call.id, call);
        }
      }
      return;
    }

    if (type === "response.function_call_arguments.done") {
      const outputIndex =
        typeof data.output_index === "number" ? data.output_index : undefined;
      const itemId = typeof data.item_id === "string" ? data.item_id : "";
      const target =
        (typeof outputIndex === "number"
          ? callsByOutputIndex.get(outputIndex)
          : undefined) ?? callsByItemId.get(itemId);
      if (target && typeof data.arguments === "string") {
        target.arguments = data.arguments;
      }
      return;
    }

    if (type === "response.output_item.done") {
      mergeFunctionCall(calls, normalizeResponsesFunctionCall(data.item));
      return;
    }

    if (type === "response.done" && data.response && typeof data.response === "object") {
      terminalError = terminalError || getResponsesTerminalError(data);
      appendFunctionCallsFromOutput(
        (data.response as { output?: unknown }).output,
        calls
      );
      if (state.contentChars === contentCharsAtStart) {
        writeStreamEvent(
          emit,
          { type: "content", text: extractResponsesOutputText(data.response) },
          state
        );
      }
    }
  };

  const flushLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      return;
    }
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      return;
    }
    handleEvent(safeJsonParse(payload));
  };

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    lines.forEach(flushLine);
  }

  const tail = decoder.decode();
  if (tail) {
    buffer += tail;
  }
  if (buffer.trim()) {
    buffer.split(/\r?\n/).forEach(flushLine);
  }

  if (terminalError) {
    throw new Error(terminalError);
  }

  return Array.from(calls.values());
}

async function runOpenRouterChat(
  run: ChatRun,
  emit: StreamEventWriter
): Promise<void> {
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
    } = run.input;
    console.info(
      `[chat:${requestId}] start provider=${apiSettings.providerName} base_url=${apiSettings.baseUrl} model=${model} messages=${messages.length} theme=${themeMode} reasoning=${apiSettings.reasoningEffort} key_source=${apiSettings.apiKeySource} key_env=${apiSettings.apiKeyEnvironmentName}`
    );

    const toolStreamState: ToolStreamState = {
      contentChars: 0,
      contentEvents: 0,
      reasoningChars: 0,
      reasoningEvents: 0
    };

    const retrievalStats = createRetrievalToolStats();
    const memoryStats = createMemoryToolStats();
    const fileStats = createSessionFileToolStats();
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
    const tools = {
      ...retrievalTools,
      ...memoryTools
    };
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
          return {
            output: listFilesToolOutput(files, fileStats)
          };
        }
        if (call.name === "readFile") {
          writeStreamEvent(
            emit,
            { type: "reasoning", text: "Reading session file..." },
            toolStreamState
          );
          const result = await readFileToolResult(files, args, fileStats);
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
        nativeToolErrors += 1;
        const message = getErrorMessage(error);
        writeStreamEvent(
          emit,
          { type: "reasoning", text: `Tool error: ${message}` },
          toolStreamState
        );
        return {
          output: JSON.stringify({
            error: message
          })
        };
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
        buildNativeToolPrompt()
      ]
        .filter(Boolean)
        .join("\n\n");
    const responseInput: ResponsesInputItem[] = messages.map(
      toResponsesInputMessage
    );
    const endpoint = getResponsesEndpoint(apiSettings.baseUrl);

    for (
      let step = 0;
      toolMaxSteps === null || step < toolMaxSteps;
      step += 1
    ) {
      nativeSteps += 1;
      const functionCalls = await streamResponsesOnce({
        endpoint,
        apiSettings,
        input: responseInput,
        instructions,
        tools: toolDefinitions,
        emit,
        state: toolStreamState,
        useOpenRouterReasoning
      });

      if (!functionCalls.length) {
        if (toolStreamState.contentChars === 0) {
          throw new Error("The model completed without producing a visible response.");
        }
        break;
      }

      for (const call of functionCalls) {
        responseInput.push(call);
        const toolResult = await executeResponsesTool(call);
        responseInput.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: toolResult.output
        });
        if (toolResult.followUpInput) {
          responseInput.push(...toolResult.followUpInput);
        }
      }
    }

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

export async function handleOpenRouterChat(
  req: Request,
  res: Response
): Promise<void> {
  const body = {
    ...(req.body as ChatRequestBody),
    clientId:
      (req.body as ChatRequestBody)?.clientId ?? req.get("x-streamui-client-id")
  };
  const requestId = Math.random().toString(36).slice(2, 9);

  try {
    const requestedRunId = stringValue(body.runId, 160);
    if (requestedRunId) {
      const existingRun = chatRuns.get(requestedRunId);
      if (existingRun) {
        attachChatRun(req, res, existingRun, getAfterSequence(req.query.after));
        return;
      }
    }

    const input = createChatRunInput(body, requestId);
    const existingRun = chatRuns.get(input.runId);
    const run = existingRun ?? startChatRun(input);
    attachChatRun(req, res, run, getAfterSequence(req.query.after));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown chat proxy error.";
    console.error(`[chat:${requestId}] error ${message}`);
    if (!res.headersSent) {
      res.status(500).type("text/plain").send(message);
      return;
    }
    endResponse(res);
  }
}

export async function handleChatRunEvents(
  req: Request,
  res: Response
): Promise<void> {
  const runId = stringValue(req.params.runId, 160);
  const run = chatRuns.get(runId);
  if (!run) {
    res.status(404).json({ error: "Chat run not found." });
    return;
  }

  attachChatRun(req, res, run, getAfterSequence(req.query.after));
}
