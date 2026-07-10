import type { Request, Response } from "express";
import {
  canPersistGeneratedArtifactBatch,
  finalizeGeneratedArtifactBatchPatch,
  getGeneratedArtifactBatchIdentity
} from "./generatedArtifactBatchPersistence.js";
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
  updateSessionMessageAtomically,
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
import { SYSTEM_PROMPT, buildUiComplexityPrompt } from "./systemPrompt.js";
import { modelLikelySupportsImageInput } from "../src/core/modelCapabilities.js";

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
  uiComplexity: number;
  userPreferencePrompt: string;
  memoryItems: MemoryItem[];
};

export type ResponsesHttpErrorContext = {
  providerName: string;
  baseUrl: string;
  apiKeySource: ApiKeySource;
  apiKeyEnvironmentName: string;
  apiKey: string;
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

type ResponsesTerminalFailure = {
  message: string;
  status?: string;
  incompleteReason?: string;
};

class ResponsesTerminalFailureError extends Error {
  readonly status?: string;
  readonly incompleteReason?: string;

  constructor(failure: ResponsesTerminalFailure) {
    super(failure.message);
    this.name = "ResponsesTerminalFailureError";
    this.status = failure.status;
    this.incompleteReason = failure.incompleteReason;
  }
}

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

type ArtifactEditReference = {
  kind: "element" | "text";
  key: string;
  selector: string;
  label: string;
  preview: string;
  tagName?: string;
  text?: string;
  html?: string;
};

type ArtifactEditRequestBody = {
  source?: unknown;
  prompt?: unknown;
  references?: unknown;
  apiSettings?: unknown;
};

type ArtifactSourceEdit = {
  find?: string;
  target?: "streamui";
  replace: string;
  occurrence?: number;
  note?: string;
};

export type OpenRouterActivitySnapshot = {
  runningChatRuns: number;
  activeChatFinalizations: number;
  activeArtifactEdits: number;
  activeTasks: number;
  idleForMs: number;
  idleSince: string;
  draining: boolean;
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
  abortController: AbortController;
  cancelRequested?: boolean;
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
const CHAT_CANCELLED_MESSAGE = "Generation stopped.";
const RESPONSES_MAX_OUTPUT_TOKENS = 16_000;
const ARTIFACT_EDIT_MAX_OUTPUT_TOKENS = 32_000;
let activeChatFinalizations = 0;
let activeArtifactEdits = 0;
let openRouterIdleSinceMs = Date.now();
let openRouterDraining = false;

function getRunningChatRunCount(): number {
  let count = 0;
  for (const run of chatRuns.values()) {
    if (run.status === "running") {
      count += 1;
    }
  }
  return count;
}

function getOpenRouterActiveTaskCount(): number {
  return getRunningChatRunCount() + activeChatFinalizations + activeArtifactEdits;
}

function refreshOpenRouterIdleState(): void {
  if (getOpenRouterActiveTaskCount() === 0) {
    openRouterIdleSinceMs = Date.now();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getOpenRouterActivitySnapshot(
  nowMs = Date.now()
): OpenRouterActivitySnapshot {
  const runningChatRuns = getRunningChatRunCount();
  const activeTasks = runningChatRuns + activeChatFinalizations + activeArtifactEdits;
  return {
    runningChatRuns,
    activeChatFinalizations,
    activeArtifactEdits,
    activeTasks,
    idleForMs: activeTasks > 0 ? 0 : Math.max(0, nowMs - openRouterIdleSinceMs),
    idleSince: new Date(openRouterIdleSinceMs).toISOString(),
    draining: openRouterDraining
  };
}

export function setOpenRouterDraining(draining: boolean): OpenRouterActivitySnapshot {
  openRouterDraining = draining;
  return getOpenRouterActivitySnapshot();
}

export async function waitForOpenRouterIdle({
  idleMs,
  timeoutMs,
  pollMs = 500
}: {
  idleMs: number;
  timeoutMs: number;
  pollMs?: number;
}): Promise<OpenRouterActivitySnapshot> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const requiredIdleMs = Math.max(0, idleMs);

  while (true) {
    const snapshot = getOpenRouterActivitySnapshot();
    if (snapshot.activeTasks === 0 && snapshot.idleForMs >= requiredIdleMs) {
      return snapshot;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return snapshot;
    }
    await sleep(Math.min(Math.max(50, pollMs), remainingMs));
  }
}

function flushResponse(res: Response): void {
  const flush = (res as Response & { flush?: () => void }).flush;
  if (typeof flush === "function") {
    flush.call(res);
  }
}

function stringValue(value: unknown, maxLength = 2_000): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function rawStringValue(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
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
  const isCancelled = status === "complete" && error === CHAT_CANCELLED_MESSAGE;

  return {
    content:
      content ||
      (isCancelled
        ? CHAT_CANCELLED_MESSAGE
        : status === "error" && !raw
          ? "I could not complete that request."
          : ""),
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
    ...(error && !isCancelled ? { error } : {})
  };
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === CHAT_CANCELLED_MESSAGE)
  );
}

function createAbortError(): Error {
  const error = new Error(CHAT_CANCELLED_MESSAGE);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError();
  }
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
- The user is viewing ChatHTML on a ${label} page background, approximately ${background}.
- Unless the user explicitly asks for a specific background color/theme, or the task clearly benefits from a special backdrop, make the artifact suitable for this ${label} surrounding page.
- For ordinary replies using streamui-response and streamui-chat, rely on the built-in transparent styles.
- For custom visual artifacts, keep the root transparent when possible. If a root surface should match the surrounding app background, use var(--streamui-page-bg) instead of hardcoding ${background}; ChatHTML updates that variable when the user toggles the page theme.
- Use the built-in theme variables for adaptive basics: --streamui-page-bg, --streamui-text, --streamui-muted, --streamui-link, --streamui-button-bg, --streamui-button-text, --streamui-secondary-border, and --streamui-secondary-text.
- Do not assume the opposite page theme unless the user asks for it.`;
}

function buildCanvasContextPrompt(canvas: CanvasContext): string {
  const ratio = (canvas.canvasWidth / canvas.initialCanvasHeight).toFixed(2);

  return `Current ChatHTML canvas context:
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
- Honor requested quantity. If the user asks for one object, scene, chart, game, or device, render one primary subject. Only show multiple views, variants, before/after states, or duplicated objects when the user asks for them, and label/arrange them intentionally.
- IDs must be unique across the artifact. Never emit two elements with the same id. Use classes for repeated styling and reserve ids for one-off script targets only.
- Do not create a styled empty placeholder and then later emit another element for the same visual. If you need a JavaScript mount point, keep the placeholder unstyled or populate that exact element; do not duplicate it.
- Budget fixed dimensions against the ${canvas.canvasWidth}px canvas: prefer max-width:min(100%, ...), box-sizing:border-box, aspect-ratio, and responsive media queries over rigid widths that can spill out.
- The root composition should not cause horizontal overflow. Avoid child widths plus padding/borders that exceed the root, long unwrapped labels, and absolutely positioned parts that escape the subject.
- Make the first viewport look intentional: the main subject should be visible, centered or deliberately placed, and not preceded by a large blank shell, empty frame, or duplicate scaffold.
- Silently review the final HTML/CSS before closing </streamui>: unique ids, no accidental duplicate primary subjects, no empty styled placeholders, no unintended horizontal overflow, no clipped or overlapping text, and the latest user request is visibly satisfied.
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
- For controls that should continue the conversation, use data-streamui-prompt on the clicked element; ChatHTML will send that prompt as the next user message and call the model again. Use normal <a href="https://..."> links only for navigation, and ordinary JavaScript-only controls only for local artifact state.
- For artifact-local copy/download/open-link controls, use ChatHTML capability attributes instead of browser permission APIs: data-streamui-copy-target="#id" or data-streamui-copy="text"; data-streamui-download-target="#id" with data-streamui-filename and optional data-streamui-mime-type; data-streamui-open-url="https://example.com" for button-style open actions. Use data-streamui-label for concise confirmation context.
- Never call navigator.clipboard, create hidden copy textareas, or use browser permission APIs. ChatHTML asks the user to confirm capability actions and the host app performs them.
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

export function normalizeSessionMessageInput(
  input: unknown
): SessionMessageInput | undefined {
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

  const normalized: SessionMessageInput = {
    id: message.id,
    role: message.role
  };
  const has = (key: keyof SessionMessageInput) =>
    Object.prototype.hasOwnProperty.call(message, key);

  if (has("content")) {
    normalized.content =
      typeof message.content === "string" ? message.content : "";
  }
  if (has("fileIds")) {
    normalized.fileIds = normalizeStringArray(message.fileIds);
  }
  if (has("reasoning")) {
    normalized.reasoning =
      typeof message.reasoning === "string" ? message.reasoning : undefined;
  }
  if (has("sessionTitle")) {
    normalized.sessionTitle =
      typeof message.sessionTitle === "string"
        ? message.sessionTitle
        : undefined;
  }
  if (has("rawStream")) {
    normalized.rawStream =
      typeof message.rawStream === "string" ? message.rawStream : undefined;
  }
  if (has("hasStreamUi")) {
    normalized.hasStreamUi = Boolean(message.hasStreamUi);
  }
  if (has("streamUiComplete")) {
    normalized.streamUiComplete = Boolean(message.streamUiComplete);
  }
  if (has("artifactContext")) {
    normalized.artifactContext =
      message.artifactContext && typeof message.artifactContext === "object"
        ? message.artifactContext
        : undefined;
  }
  if (has("runtimeErrors")) {
    normalized.runtimeErrors = Array.isArray(message.runtimeErrors)
      ? message.runtimeErrors
      : undefined;
  }
  if (has("repairOfMessageId")) {
    normalized.repairOfMessageId =
      typeof message.repairOfMessageId === "string"
        ? message.repairOfMessageId
        : undefined;
  }
  if (has("repairAttempt")) {
    normalized.repairAttempt =
      typeof message.repairAttempt === "number" &&
      Number.isFinite(message.repairAttempt)
        ? Math.max(1, Math.round(message.repairAttempt))
        : undefined;
  }
  if (has("branchGroupId")) {
    normalized.branchGroupId =
      typeof message.branchGroupId === "string"
        ? message.branchGroupId
        : undefined;
  }
  if (has("branchVariantId")) {
    normalized.branchVariantId =
      typeof message.branchVariantId === "string"
        ? message.branchVariantId
        : undefined;
  }
  if (has("branchAnchor")) {
    normalized.branchAnchor = message.branchAnchor ? true : undefined;
  }
  if (has("artifactEditBaseRawStream")) {
    normalized.artifactEditBaseRawStream =
      typeof message.artifactEditBaseRawStream === "string"
        ? message.artifactEditBaseRawStream
        : undefined;
  }
  if (has("artifactEdits")) {
    normalized.artifactEdits = Array.isArray(message.artifactEdits)
      ? message.artifactEdits
      : undefined;
  }
  if (has("activeArtifactEditId")) {
    normalized.activeArtifactEditId =
      typeof message.activeArtifactEditId === "string"
        ? message.activeArtifactEditId
        : undefined;
  }
  if (has("generationRunId")) {
    normalized.generationRunId =
      typeof message.generationRunId === "string"
        ? message.generationRunId
        : undefined;
  }
  if (has("streamSequence")) {
    normalized.streamSequence =
      typeof message.streamSequence === "number" &&
      Number.isFinite(message.streamSequence)
        ? Math.max(0, Math.round(message.streamSequence))
        : undefined;
  }
  if (has("status")) {
    normalized.status =
      message.status === "streaming" ||
      message.status === "complete" ||
      message.status === "error"
        ? message.status
        : message.role === "assistant"
          ? "complete"
          : undefined;
  }
  if (has("error")) {
    normalized.error =
      typeof message.error === "string" ? message.error : undefined;
  }

  return normalized;
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

  // Express may emit request "close" once the POST body has been consumed.
  // Keep the stream subscription alive until the response itself closes.
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

  const streamPatch = getStreamUiMessagePatch(
    run.raw,
    run.reasoning,
    status,
    run.sequence,
    run.id,
    error
  );
  const artifactBatchIdentity = getGeneratedArtifactBatchIdentity(
    run.input.assistantMessage
  );
  run.persistPromise = run.persistPromise
    .then(async () => {
      if (artifactBatchIdentity) {
        await updateSessionMessageAtomically({
          stateKey: run.input.stateKey,
          sessionId,
          messageId: assistantMessageId,
          update: (currentMessage) => {
            if (
              !canPersistGeneratedArtifactBatch(
                currentMessage,
                run.id,
                artifactBatchIdentity
              )
            ) {
              return undefined;
            }

            return finalizeGeneratedArtifactBatchPatch({
              assistantMessage: currentMessage,
              patch: streamPatch,
              status,
              error,
              expectedIdentity: artifactBatchIdentity
            });
          }
        });
        return;
      }

      await patchSessionMessage({
        stateKey: run.input.stateKey,
        sessionId,
        messageId: assistantMessageId,
        patch: streamPatch
      });
    })
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
  if (run.status !== "running") {
    return;
  }

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
  if (run.status !== "running") {
    return;
  }

  run.status = status;
  run.error = error;
  appendRunEvent(run, {
    type: "done",
    status,
    ...(status === "error" && error ? { error } : {})
  });
  activeChatFinalizations += 1;
  void flushRunPersistence(run, status, error).finally(() => {
    activeChatFinalizations = Math.max(0, activeChatFinalizations - 1);
    scheduleRunCleanup(run);
    refreshOpenRouterIdleState();
  });
}

function cancelChatRun(run: ChatRun): boolean {
  if (run.status !== "running") {
    return false;
  }

  run.cancelRequested = true;
  run.abortController.abort();
  finishChatRun(run, "complete", CHAT_CANCELLED_MESSAGE);
  return true;
}

async function executeChatRun(run: ChatRun): Promise<void> {
  try {
    await persistInitialRunMessages(run);
    await runOpenRouterChat(run, (event) => emitRunStreamEvent(run, event));
    finishChatRun(run, "complete");
  } catch (error) {
    if (run.status !== "running") {
      return;
    }
    if (run.cancelRequested || isAbortError(error)) {
      finishChatRun(run, "complete", CHAT_CANCELLED_MESSAGE);
      return;
    }

    const message =
      error instanceof Error ? error.message : "Unknown chat proxy error.";
    const responsesFailure =
      error instanceof ResponsesTerminalFailureError ? error : null;
    const stats = [
      `[chat:${run.input.requestId}] error ${message}`,
      responsesFailure?.status
        ? `responses_status=${responsesFailure.status}`
        : "",
      responsesFailure?.status === "incomplete"
        ? `incomplete_reason=${responsesFailure.incompleteReason || "unknown"}`
        : ""
    ].filter(Boolean);
    console.error(stats.join(" "));
    finishChatRun(run, "error", message);
  }
}

function startChatRun(input: ChatRunInput): ChatRun {
  const run: ChatRun = {
    id: input.runId,
    input,
    abortController: new AbortController(),
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

function normalizeUiComplexity(value: unknown, fallback = 50): number {
  const numericValue =
    typeof value === "string" && value.trim()
      ? Number(value)
      : typeof value === "number"
        ? value
        : fallback;

  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(100, Math.max(0, Math.round(numericValue)));
}

function readRuntimeApiSettings(input: unknown): RuntimeApiSettings {
  const defaults = getRuntimeApiDefaults();
  const object =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const credentials = readRuntimeApiCredentials(input);
  if (credentials.apiKeySource === "managed") {
    throw new Error(
      "Managed ChatHTML Cloud requests require a hosted ChatHTML Cloud backend. Use OpenRouter/OpenAI with your own API key in the open-source server."
    );
  }
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

  const credentialMismatch = describeApiCredentialMismatch(credentials);
  if (credentialMismatch) {
    throw new Error(credentialMismatch);
  }

  const memorySettings = normalizeMemorySettings(object);

  return {
    ...credentials,
    model,
    reasoningEffort: normalizeReasoningEffort(
      object.reasoningEffort ?? defaults.reasoningEffort
    ),
    uiComplexity: normalizeUiComplexity(
      object.uiComplexity ?? defaults.uiComplexity
    ),
    userPreferencePrompt: memorySettings.userPreferencePrompt,
    memoryItems: memorySettings.memoryItems
  };
}

function isOpenRouterRuntime(
  settings: Pick<RuntimeApiSettings, "providerName" | "baseUrl">
): boolean {
  return (
    /openrouter/i.test(settings.providerName) ||
    settings.baseUrl.toLowerCase().includes("openrouter.ai")
  );
}

function isOpenAiRuntime(
  settings: Pick<RuntimeApiSettings, "providerName" | "baseUrl">
): boolean {
  return (
    /openai/i.test(settings.providerName) ||
    settings.baseUrl.toLowerCase().includes("api.openai.com")
  );
}

function getApiKeyDisplayName(
  settings: Pick<
    ResponsesHttpErrorContext,
    "apiKeySource" | "apiKeyEnvironmentName"
  >
): string {
  return settings.apiKeySource === "manual"
    ? "manual API key"
    : settings.apiKeyEnvironmentName || "configured API key";
}

function getApiKeyUpdateAction(
  settings: Pick<
    ResponsesHttpErrorContext,
    "apiKeySource" | "apiKeyEnvironmentName"
  >
): string {
  const label = getApiKeyDisplayName(settings);
  return settings.apiKeySource === "manual"
    ? "Update it in Settings."
    : `Update ${label} and restart the server.`;
}

function looksLikeOpenRouterKey(apiKey: string): boolean {
  return /^sk-or-/i.test(apiKey.trim());
}

function looksLikeOpenAiKey(apiKey: string): boolean {
  return /^sk-(?!or-)/i.test(apiKey.trim());
}

export function describeApiCredentialMismatch(
  settings: ResponsesHttpErrorContext
): string {
  const label = getApiKeyDisplayName(settings);

  if (isOpenRouterRuntime(settings) && looksLikeOpenAiKey(settings.apiKey)) {
    return `API credential mismatch: ${label} looks like an OpenAI key, but the Base URL points to OpenRouter (${settings.baseUrl}). Use an OpenRouter key from https://openrouter.ai/keys (usually starts with sk-or-) or switch the provider/base URL to OpenAI.`;
  }

  if (isOpenAiRuntime(settings) && looksLikeOpenRouterKey(settings.apiKey)) {
    return `API credential mismatch: ${label} looks like an OpenRouter key, but the Base URL points to OpenAI (${settings.baseUrl}). Use an OpenAI API key or switch the provider/base URL to OpenRouter.`;
  }

  return "";
}

function getUnauthorizedCredentialHint(
  status: number,
  settings: ResponsesHttpErrorContext
): string {
  if (status !== 401) {
    return "";
  }

  const label = getApiKeyDisplayName(settings);
  const action = getApiKeyUpdateAction(settings);

  if (isOpenRouterRuntime(settings)) {
    return `Check ${label}: OpenRouter returns 401 for invalid or wrong-platform keys. Use an OpenRouter key from https://openrouter.ai/keys (usually starts with sk-or-). ${action}`;
  }

  if (isOpenAiRuntime(settings)) {
    return `Check ${label}: the OpenAI endpoint requires an OpenAI API key, not an OpenRouter key. ${action}`;
  }

  return `Check ${label}: the provider rejected the configured API key. ${action}`;
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

function getStringProperty(
  input: Record<string, unknown>,
  names: string[]
): string {
  for (const name of names) {
    const value = input[name];
    if (typeof value === "string") {
      return value;
    }
  }

  return "";
}

function isResponsesReasoningEvent(type: unknown): type is string {
  return typeof type === "string" && type.toLowerCase().includes("reasoning");
}

export function extractResponsesReasoningDelta(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "";
  }

  const data = event as Record<string, unknown>;
  const type = data.type;
  if (!isResponsesReasoningEvent(type) || !type.endsWith(".delta")) {
    return "";
  }

  const delta = data.delta;
  if (typeof delta === "string") {
    return delta;
  }
  if (delta && typeof delta === "object") {
    return getStringProperty(delta as Record<string, unknown>, [
      "text",
      "summary_text",
      "content"
    ]);
  }

  return getStringProperty(data, ["text", "summary_text", "content"]);
}

export function extractResponsesReasoningDoneText(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "";
  }

  const data = event as Record<string, unknown>;
  const type = data.type;
  if (!isResponsesReasoningEvent(type) || !type.endsWith(".done")) {
    return "";
  }

  return getStringProperty(data, ["text", "summary_text", "content"]);
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

export function formatResponsesHttpError(
  response: { status: number; statusText?: string },
  bodyText: string,
  settings?: ResponsesHttpErrorContext
): string {
  const statusText = compactErrorText(response.statusText || "");
  const status = `HTTP ${response.status}${statusText ? ` ${statusText}` : ""}`;
  const detail = summarizeHttpErrorBody(bodyText, "");
  const prefix = `Responses API request failed with ${status}.`;
  const hint = settings
    ? getUnauthorizedCredentialHint(response.status, settings)
    : "";
  const visibleDetail =
    detail && !detail.toLowerCase().includes(String(response.status))
      ? detail
      : "";

  return [prefix, visibleDetail, hint].filter(Boolean).join(" ");
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

function getResponsesEventStatus(
  event: Record<string, unknown>,
  response: Record<string, unknown>
): string {
  const responseStatus =
    typeof response.status === "string" ? response.status.trim() : "";
  if (responseStatus) {
    return responseStatus;
  }

  const eventType = typeof event.type === "string" ? event.type : "";
  if (eventType === "response.failed") {
    return "failed";
  }
  if (eventType === "response.cancelled") {
    return "cancelled";
  }
  if (eventType === "response.incomplete") {
    return "incomplete";
  }
  return "";
}

function responsesIncompleteReason(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }

  const details = input as { reason?: unknown; error?: unknown };
  const reason = stringValue(details.reason, 160);
  if (reason) {
    return reason;
  }
  if (details.error && typeof details.error === "object") {
    return responsesIncompleteReason(details.error);
  }
  return "";
}

function getResponsesTerminalFailure(
  event: Record<string, unknown>
): ResponsesTerminalFailure | undefined {
  const response =
    event.response && typeof event.response === "object"
      ? (event.response as Record<string, unknown>)
      : event;
  const status = getResponsesEventStatus(event, response);
  const incompleteDetails = response.incomplete_details ?? event.incomplete_details;
  const incompleteReason = responsesIncompleteReason(incompleteDetails);

  if (status === "incomplete") {
    return {
      message: "Responses API returned incomplete.",
      status,
      incompleteReason
    };
  }

  const directError = responsesErrorMessage(event.error);
  if (directError) {
    return { message: directError, status, incompleteReason };
  }

  const incomplete = responsesErrorMessage(incompleteDetails);
  if (status === "failed" || status === "cancelled" || status === "incomplete") {
    return {
      message:
        incomplete ||
        `Responses API returned ${status || "an incomplete response"}.`,
      status,
      incompleteReason
    };
  }

  return incomplete
    ? {
        message: incomplete,
        status,
        incompleteReason
      }
    : undefined;
}

async function streamResponsesOnce({
  endpoint,
  apiSettings,
  input,
  instructions,
  tools,
  emit,
  state,
  signal,
  useOpenRouterReasoning,
  maxOutputTokens = RESPONSES_MAX_OUTPUT_TOKENS
}: {
  endpoint: string;
  apiSettings: RuntimeApiSettings;
  input: ResponsesInputItem[];
  instructions: string;
  tools: ResponsesToolDefinition[];
  emit: StreamEventWriter;
  state: ToolStreamState;
  signal: AbortSignal;
  useOpenRouterReasoning: boolean;
  maxOutputTokens?: number;
}): Promise<ResponsesFunctionCallItem[]> {
  throwIfAborted(signal);

  const body: Record<string, unknown> = {
    model: apiSettings.model,
    input,
    instructions,
    stream: true,
    max_output_tokens: maxOutputTokens
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
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
      "X-Title": "ChatHTML Runtime Demo"
    },
    signal,
    body: JSON.stringify(body)
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(formatResponsesHttpError(response, text, apiSettings));
  }

  const decoder = new TextDecoder();
  const calls = new Map<string, ResponsesFunctionCallItem>();
  const callsByOutputIndex = new Map<number, ResponsesFunctionCallItem>();
  const callsByItemId = new Map<string, ResponsesFunctionCallItem>();
  const textDeltaCharsByKey = new Map<string, number>();
  const reasoningDeltaCharsByKey = new Map<string, number>();
  const contentCharsAtStart = state.contentChars;
  let terminalFailure: ResponsesTerminalFailure | undefined;
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

  const writeReasoning = (text: string, key: string) => {
    if (!text) {
      return;
    }

    reasoningDeltaCharsByKey.set(
      key,
      (reasoningDeltaCharsByKey.get(key) ?? 0) + text.length
    );
    writeStreamEvent(emit, { type: "reasoning", text }, state);
  };

  const writeDoneReasoningIfNeeded = (
    data: Record<string, unknown>,
    text: string
  ) => {
    const key = getResponsesTextEventKey(data);
    if (!text || (reasoningDeltaCharsByKey.get(key) ?? 0) > 0) {
      return;
    }

    writeReasoning(text, key);
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

    const reasoningDelta = extractResponsesReasoningDelta(data);
    if (reasoningDelta) {
      writeReasoning(reasoningDelta, getResponsesTextEventKey(data));
      return;
    }

    const reasoningDoneText = extractResponsesReasoningDoneText(data);
    if (reasoningDoneText) {
      writeDoneReasoningIfNeeded(data, reasoningDoneText);
      return;
    }

    if (
      type === "response.failed" ||
      type === "response.incomplete" ||
      type === "response.cancelled"
    ) {
      terminalFailure = getResponsesTerminalFailure(data);
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
      terminalFailure = terminalFailure ?? getResponsesTerminalFailure(data);
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
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      lines.forEach(flushLine);
    }
  } finally {
    if (signal.aborted) {
      await reader.cancel().catch(() => undefined);
    }
  }

  const tail = decoder.decode();
  if (tail) {
    buffer += tail;
  }
  if (buffer.trim()) {
    buffer.split(/\r?\n/).forEach(flushLine);
  }

  if (terminalFailure) {
    throw new ResponsesTerminalFailureError(terminalFailure);
  }

  return Array.from(calls.values());
}

function normalizeArtifactEditReference(input: unknown): ArtifactEditReference | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const reference = input as Partial<ArtifactEditReference>;
  const kind =
    reference.kind === "element" || reference.kind === "text"
      ? reference.kind
      : null;
  const key = stringValue(reference.key, 240);
  const selector = stringValue(reference.selector, 500);
  if (!kind || !key || !selector) {
    return null;
  }

  return {
    kind,
    key,
    selector,
    label: stringValue(reference.label, 160) || "Reference",
    preview: stringValue(reference.preview, 500),
    tagName: stringValue(reference.tagName, 80) || undefined,
    text: stringValue(reference.text, 2_000) || undefined,
    html: rawStringValue(reference.html, 8_000) || undefined
  };
}

function normalizeArtifactEditReferences(input: unknown): ArtifactEditReference[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seen = new Set<string>();
  const references: ArtifactEditReference[] = [];
  for (const item of input) {
    const reference = normalizeArtifactEditReference(item);
    if (!reference || seen.has(reference.key)) {
      continue;
    }
    seen.add(reference.key);
    references.push(reference);
    if (references.length >= 8) {
      break;
    }
  }

  return references;
}

function extractJsonObjectText(value: string): string {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function normalizeArtifactSourceEdits(input: unknown): ArtifactSourceEdit[] {
  if (!input || typeof input !== "object") {
    return [];
  }

  const objectInput = input as Partial<ArtifactSourceEdit> & { edits?: unknown };
  const editsInput = Array.isArray(input)
    ? input
    : Array.isArray(objectInput.edits)
      ? objectInput.edits
      : typeof objectInput.replace === "string"
        ? [objectInput]
        : [];
  if (!editsInput.length) {
    return [];
  }

  const edits: ArtifactSourceEdit[] = [];
  for (const item of editsInput) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const edit = item as Partial<ArtifactSourceEdit>;
    const target = edit.target === "streamui" ? edit.target : undefined;
    const find = typeof edit.find === "string" ? edit.find : "";
    if (typeof edit.replace !== "string" || (!find && target !== "streamui")) {
      continue;
    }

    const occurrence =
      typeof edit.occurrence === "number" && Number.isFinite(edit.occurrence)
        ? Math.max(1, Math.round(edit.occurrence))
        : undefined;
    edits.push({
      ...(find ? { find } : {}),
      ...(target ? { target } : {}),
      replace: edit.replace,
      occurrence,
      note: stringValue(edit.note, 240) || undefined
    });
    if (edits.length >= 24) {
      break;
    }
  }

  return edits;
}

function extractStreamUiBlockText(value: string): string {
  const match = /<streamui\b[^>]*>[\s\S]*?<\/streamui>/i.exec(value);
  return match ? match[0] : "";
}

function logTextPreview(value: string, maxLength = 600): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim().slice(0, maxLength));
}

export function recoverArtifactSourceEditsFromModelText(
  rawModelText: string,
  parsed: unknown
): {
  edits: ArtifactSourceEdit[];
  recovery: "none" | "raw_streamui";
} {
  const edits = normalizeArtifactSourceEdits(parsed);
  if (edits.length) {
    return { edits, recovery: "none" };
  }

  const replacement = extractStreamUiBlockText(rawModelText);
  if (!replacement) {
    return { edits: [], recovery: "none" };
  }

  return {
    edits: [
      {
        target: "streamui",
        replace: replacement,
        note: "Recovered complete streamui replacement from model output."
      }
    ],
    recovery: "raw_streamui"
  };
}

function countOccurrences(source: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let index = 0;
  while (index <= source.length) {
    const found = source.indexOf(needle, index);
    if (found < 0) {
      break;
    }
    count += 1;
    index = found + needle.length;
  }

  return count;
}

function findOccurrenceIndex(
  source: string,
  needle: string,
  occurrence: number
): number {
  let index = 0;
  let seen = 0;
  while (index <= source.length) {
    const found = source.indexOf(needle, index);
    if (found < 0) {
      return -1;
    }
    seen += 1;
    if (seen === occurrence) {
      return found;
    }
    index = found + needle.length;
  }

  return -1;
}

function findStreamUiBlockRange(source: string): { start: number; end: number } | null {
  const match = /<streamui\b[^>]*>[\s\S]*?<\/streamui>/i.exec(source);
  if (!match || match.index === undefined) {
    return null;
  }
  return { start: match.index, end: match.index + match[0].length };
}

export function applyArtifactSourceEdits(
  source: string,
  edits: ArtifactSourceEdit[]
): {
  rawStream: string;
  applied: Array<{
    note?: string;
    occurrence?: number;
    findLength: number;
    replaceLength: number;
  }>;
} {
  if (!edits.length) {
    throw new Error("The model did not return any source edits.");
  }

  let current = source;
  const applied: Array<{
    note?: string;
    occurrence?: number;
    findLength: number;
    replaceLength: number;
  }> = [];

  edits.forEach((edit, index) => {
    if (edit.target === "streamui") {
      const range = findStreamUiBlockRange(current);
      if (!range) {
        throw new Error(`Edit ${index + 1} could not find the streamui artifact block.`);
      }
      if (!/<streamui\b/i.test(edit.replace) || !/<\/streamui>/i.test(edit.replace)) {
        throw new Error(`Edit ${index + 1} replacement must include a streamui artifact block.`);
      }
      const existing = current.slice(range.start, range.end);
      if (existing === edit.replace) {
        throw new Error(`Edit ${index + 1} does not change the source.`);
      }
      current =
        current.slice(0, range.start) +
        edit.replace +
        current.slice(range.end);
      applied.push({
        note: edit.note,
        findLength: existing.length,
        replaceLength: edit.replace.length
      });
      return;
    }

    const find = edit.find ?? "";
    if (!find) {
      throw new Error(`Edit ${index + 1} has an empty find string.`);
    }
    if (find === edit.replace) {
      throw new Error(`Edit ${index + 1} does not change the source.`);
    }

    const matches = countOccurrences(current, find);
    if (matches === 0) {
      throw new Error(`Edit ${index + 1} did not match the current source.`);
    }
    if (!edit.occurrence && matches > 1) {
      throw new Error(
        `Edit ${index + 1} matched ${matches} places. The model must specify occurrence.`
      );
    }

    const occurrence =
      edit.occurrence && edit.occurrence > matches && matches === 1
        ? 1
        : edit.occurrence ?? 1;
    if (occurrence > matches) {
      throw new Error(
        `Edit ${index + 1} requested occurrence ${occurrence}, but only ${matches} matched.`
      );
    }

    const start = findOccurrenceIndex(current, find, occurrence);
    if (start < 0) {
      throw new Error(`Edit ${index + 1} could not be applied.`);
    }

    current =
      current.slice(0, start) +
      edit.replace +
      current.slice(start + find.length);
    applied.push({
      note: edit.note,
      occurrence: edit.occurrence && edit.occurrence > matches ? occurrence : edit.occurrence,
      findLength: find.length,
      replaceLength: edit.replace.length
    });
  });

  if (current === source) {
    throw new Error("The source edits did not change the artifact.");
  }
  if (/<streamui\b/i.test(source) && !/<streamui\b/i.test(current)) {
    throw new Error("The source edits removed the streamui artifact block.");
  }

  return { rawStream: current, applied };
}

function buildArtifactEditInstructions(): string {
  return `You edit existing ChatHTML artifact source with precise patches.

Return only JSON with this exact shape:
{"summary":"short change summary","edits":[{"find":"exact source substring","replace":"replacement substring","occurrence":1,"note":"optional"},{"target":"streamui","replace":"<streamui>complete replacement artifact block</streamui>","note":"optional"}]}

Rules:
- Apply the user's request by editing ORIGINAL_SOURCE, not by regenerating the whole artifact.
- Every find value must be an exact contiguous substring from ORIGINAL_SOURCE or from the source after earlier edits.
- Keep edits small and targeted. Use multiple edits when that is clearer.
- The user's prompt decides the edit scope. Selected references are anchors for intent and disambiguation, not boundaries.
- Do not limit changes to selected elements/text unless the user explicitly asks to change only the selection.
- For broad requests such as "change the whole page" or "make the entire artifact about X", prefer one {"target":"streamui","replace":"..."} edit containing the complete replacement <streamui>...</streamui> block.
- Use exact find/replace edits for small or localized changes.
- If a find substring appears more than once, include a 1-based occurrence number.
- Preserve valid ChatHTML protocol tags, especially <chat> and <streamui>.
- Use selected references as anchors. DOM html/text may differ from source after parsing, so match against ORIGINAL_SOURCE carefully.
- Do not include markdown or comments outside JSON. A full rewritten artifact is allowed only inside edits[].replace when target is "streamui".`;
}

async function runArtifactEditModel({
  apiSettings,
  source,
  prompt,
  references,
  signal
}: {
  apiSettings: RuntimeApiSettings;
  source: string;
  prompt: string;
  references: ArtifactEditReference[];
  signal: AbortSignal;
}): Promise<{
  summary: string;
  edits: ArtifactSourceEdit[];
  rawModelText: string;
  recovery: "none" | "raw_streamui";
}> {
  const endpoint = getResponsesEndpoint(apiSettings.baseUrl);
  const state: ToolStreamState = {
    contentChars: 0,
    contentEvents: 0,
    reasoningChars: 0,
    reasoningEvents: 0
  };
  let rawModelText = "";
  await streamResponsesOnce({
    endpoint,
    apiSettings,
    input: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "USER_PROMPT:",
              prompt,
              "",
              "SELECTED_REFERENCES_JSON:",
              JSON.stringify(references, null, 2),
              "",
              "ORIGINAL_SOURCE:",
              source
            ].join("\n")
          }
        ]
      }
    ],
    instructions: buildArtifactEditInstructions(),
    tools: [],
    emit: (event) => {
      if (event.type === "content") {
        rawModelText += event.text;
      }
    },
    state,
    signal,
    useOpenRouterReasoning: false,
    maxOutputTokens: ARTIFACT_EDIT_MAX_OUTPUT_TOKENS
  });

  const parsed = safeJsonParse(extractJsonObjectText(rawModelText));
  const recovered = recoverArtifactSourceEditsFromModelText(rawModelText, parsed);
  const summary =
    parsed && typeof parsed === "object"
      ? stringValue((parsed as { summary?: unknown }).summary, 500)
      : "";

  return {
    summary,
    edits: recovered.edits,
    rawModelText,
    recovery: recovered.recovery
  };
}

export async function handleArtifactEdit(
  req: Request,
  res: Response
): Promise<void> {
  const body = req.body as ArtifactEditRequestBody;
  const requestId = Math.random().toString(36).slice(2, 9);
  const abortController = new AbortController();
  let completed = false;
  let countedAsActiveTask = false;

  res.on("close", () => {
    if (!completed) {
      abortController.abort();
    }
  });

  try {
    const source = typeof body.source === "string" ? body.source : "";
    const prompt = stringValue(body.prompt, 8_000);
    const references = normalizeArtifactEditReferences(body.references);
    if (!source.trim()) {
      res.status(400).json({ error: "Artifact source is required." });
      completed = true;
      return;
    }
    if (source.length > 2_000_000) {
      res.status(413).json({ error: "Artifact source is too large to edit safely." });
      completed = true;
      return;
    }
    if (!prompt) {
      res.status(400).json({ error: "Edit prompt is required." });
      completed = true;
      return;
    }
    if (!references.length) {
      res.status(400).json({ error: "At least one artifact reference is required." });
      completed = true;
      return;
    }
    if (openRouterDraining) {
      res.status(503).json({
        error: "Server is draining for deployment. Try again shortly.",
        activity: getOpenRouterActivitySnapshot()
      });
      completed = true;
      return;
    }

    const apiSettings = readRuntimeApiSettings(body.apiSettings);
    activeArtifactEdits += 1;
    countedAsActiveTask = true;
    console.info(
      `[artifact-edit:${requestId}] start provider=${apiSettings.providerName} base_url=${apiSettings.baseUrl} model=${apiSettings.model} source_chars=${source.length} references=${references.length}`
    );
    const startedAt = Date.now();
    const result = await runArtifactEditModel({
      apiSettings,
      source,
      prompt,
      references,
      signal: abortController.signal
    });
    if (result.recovery !== "none") {
      console.warn(
        `[artifact-edit:${requestId}] recovered_${result.recovery} raw_model_chars=${result.rawModelText.length} raw_model_preview=${logTextPreview(result.rawModelText)}`
      );
    } else if (!result.edits.length) {
      console.warn(
        `[artifact-edit:${requestId}] empty_edits raw_model_chars=${result.rawModelText.length} raw_model_preview=${logTextPreview(result.rawModelText)}`
      );
    }
    const applied = applyArtifactSourceEdits(source, result.edits);
    completed = true;
    console.info(
      `[artifact-edit:${requestId}] complete duration_ms=${Date.now() - startedAt} edits=${applied.applied.length}`
    );
    res.json({
      rawStream: applied.rawStream,
      summary: result.summary,
      edits: applied.applied
    });
  } catch (error) {
    completed = true;
    const message =
      error instanceof Error ? error.message : "The artifact edit failed.";
    const responsesFailure =
      error instanceof ResponsesTerminalFailureError ? error : null;
    const stats = [
      `[artifact-edit:${requestId}] error ${message}`,
      responsesFailure?.status
        ? `responses_status=${responsesFailure.status}`
        : "",
      responsesFailure?.status === "incomplete"
        ? `incomplete_reason=${responsesFailure.incompleteReason || "unknown"}`
        : ""
    ].filter(Boolean);
    console.error(stats.join(" "));
    if (!res.headersSent) {
      res.status(responsesFailure ? 502 : 500).json({ error: message });
    }
  } finally {
    if (countedAsActiveTask) {
      activeArtifactEdits = Math.max(0, activeArtifactEdits - 1);
      refreshOpenRouterIdleState();
    }
  }
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
      `[chat:${requestId}] start provider=${apiSettings.providerName} base_url=${apiSettings.baseUrl} model=${model} messages=${messages.length} theme=${themeMode} reasoning=${apiSettings.reasoningEffort} ui_complexity=${apiSettings.uiComplexity} key_source=${apiSettings.apiKeySource} key_env=${apiSettings.apiKeyEnvironmentName}`
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
        buildUiComplexityPrompt(apiSettings.uiComplexity),
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
      throwIfAborted(run.abortController.signal);
      nativeSteps += 1;
      const functionCalls = await streamResponsesOnce({
        endpoint,
        apiSettings,
        input: responseInput,
        instructions,
        tools: toolDefinitions,
        emit,
        state: toolStreamState,
        signal: run.abortController.signal,
        useOpenRouterReasoning
      });

      throwIfAborted(run.abortController.signal);

      if (!functionCalls.length) {
        if (toolStreamState.contentChars === 0) {
          throw new Error("The model completed without producing a visible response.");
        }
        break;
      }

      for (const call of functionCalls) {
        throwIfAborted(run.abortController.signal);
        responseInput.push(call);
        const toolResult = await executeResponsesTool(call);
        throwIfAborted(run.abortController.signal);
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
      (req.body as ChatRequestBody)?.clientId ??
      req.get("x-chathtml-client-id") ??
      req.get("x-streamui-client-id")
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
    if (!existingRun && openRouterDraining) {
      res.status(503).json({
        error: "Server is draining for deployment. Try again shortly.",
        activity: getOpenRouterActivitySnapshot()
      });
      return;
    }
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

export async function handleCancelChatRun(
  req: Request,
  res: Response
): Promise<void> {
  const runId = stringValue(req.params.runId, 160);
  const run = chatRuns.get(runId);
  if (!run) {
    res.status(404).json({ error: "Chat run not found." });
    return;
  }

  const cancelled = cancelChatRun(run);
  res.json({
    ok: true,
    runId: run.id,
    status: run.status,
    cancelled
  });
}
