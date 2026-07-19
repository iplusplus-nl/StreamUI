import { CHAT_RUN_CANCELLED_MESSAGE, type ChatRunTerminalOutcome } from "./chatRunFinalization.js";
import { normalizeMemorySettings, type MemoryItem } from "./memoryTools.js";
import {
  getRuntimeApiDefaults,
  normalizeApiStyle,
  readRuntimeApiCredentials,
  type ApiKeySource,
  type ApiStyle
} from "./runtimeApiSettings.js";
import { normalizeSessionFiles, type SessionFile } from "./sessionFileTools.js";
import { normalizeEphemeralFileIds } from "./sessionFileUploadSafety.js";
import { getSessionStateKeyFromClientId } from "./sessions.js";
import type {
  SessionMessageInput,
  SessionMessagePatch
} from "./sessionStateTypes.js";
import type { ResponsesInputMessage } from "./responsesEventReducer.js";
import {
  describeApiCredentialMismatch,
  isOpenAiRuntime,
  isOpenRouterRuntime
} from "./responsesStreamClient.js";

export type ChatRole = "user" | "assistant" | "system";

export type OpenRouterReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "none";

export type RuntimeApiSettings = {
  providerName: string;
  baseUrl: string;
  apiStyle: ApiStyle;
  apiKeySource: ApiKeySource;
  apiKeyEnvironmentName: string;
  apiKey: string;
  model: string;
  reasoningEffort: OpenRouterReasoningEffort;
  uiComplexity: number;
  userPreferencePrompt: string;
  memoryItems: MemoryItem[];
};

export type ClientChatMessage = {
  role: ChatRole;
  content: string;
};

export type CanvasContext = {
  viewportWidth: number;
  viewportHeight: number;
  canvasWidth: number;
  initialCanvasHeight: number;
  devicePixelRatio: number;
};

export type PageThemeMode = "day" | "night";

export type ChatRequestBody = {
  messages?: unknown;
  files?: unknown;
  ephemeralFileIds?: unknown;
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

export type ChatRunInput = {
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
  ephemeralFileIds: string[];
  canvasContext: CanvasContext;
  themeMode: PageThemeMode;
  useOpenRouterReasoning: boolean;
  searchSettings?: unknown;
};

export function stringValue(value: unknown, maxLength = 2_000): string {
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

type ProtocolTagContent = {
  content: string;
  hasOpen: boolean;
  hasClose: boolean;
};

function extractBetweenTag(
  raw: string,
  tagName: "sessiontitle" | "chat"
): ProtocolTagContent {
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

function extractStreamUi(raw: string): ProtocolTagContent {
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

export function buildChatRunMessagePatch(
  raw: string,
  reasoning: string,
  status: "streaming" | "complete" | "error",
  streamSequence: number,
  generationRunId: string,
  error?: string,
  generationOutcome?: ChatRunTerminalOutcome
): SessionMessagePatch {
  const chat = extractBetweenTag(raw, "chat");
  const sessionTitle = extractBetweenTag(raw, "sessiontitle");
  const streamui = extractStreamUi(raw);
  const content =
    chat.content.trim() || (!streamui.hasOpen ? stripProtocolTags(raw) : "");
  const isCancelled = generationOutcome === "cancelled";

  return {
    content:
      content ||
      (isCancelled
        ? CHAT_RUN_CANCELLED_MESSAGE
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
    generationOutcome,
    status,
    ...(error && !isCancelled ? { error } : {})
  };
}

export function canPersistChatRunMessage(
  message: Readonly<{ generationRunId?: string }>,
  runId: string
): boolean {
  return message.generationRunId === runId;
}

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.round(Math.min(max, Math.max(min, value)));
}

export function normalizeCanvasContext(input: unknown): CanvasContext {
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

export function normalizeThemeMode(input: unknown): PageThemeMode {
  return input === "day" || input === "light" ? "day" : "night";
}

export function buildThemeContextPrompt(themeMode: PageThemeMode): string {
  const isNight = themeMode === "night";
  const label = isNight ? "dark" : "light";
  const background = isNight ? "#212121" : "#ffffff";

  return `Current page background preference:
- The user is viewing ChatHTML on a ${label} page background, approximately ${background}.
- Unless the user explicitly asks for a specific background color/theme, or the task clearly benefits from a special backdrop, make the artifact suitable for this ${label} surrounding page.
- For ordinary replies using streamui-response and streamui-chat, rely on the built-in transparent styles.
- For custom visual artifacts, keep the root transparent when possible. If a root surface should match the surrounding app background, use var(--streamui-page-bg) instead of hardcoding ${background}; ChatHTML updates that variable when the user toggles the page theme.
- Use the built-in theme variables for adaptive basics: --streamui-page-bg, --streamui-text, --streamui-muted, --streamui-link, --streamui-button-bg, --streamui-button-text, --streamui-secondary-border, and --streamui-secondary-text.
- Apply the comfortable-legibility contract to final composited colors on their actual immediate backgrounds in this theme, including translucent layers, overlays, gradients, and images.
- Do not assume the opposite page theme unless the user asks for it.`;
}

export function buildCanvasContextPrompt(canvas: CanvasContext): string {
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
- If you use retrieval information, render source links inside the HTML. Every media/source link must use a complete exact http(s) URL supplied by retrieval; never emit href="#", an empty href, javascript:, or a fabricated/placeholder destination.
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

export function normalizeMessages(input: unknown): ClientChatMessage[] {
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

export function toResponsesInputMessage(
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
        text:
          message.content || "Please respond using the current session context."
      }
    ]
  };
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
  if (has("branchRunRollback")) {
    const rollback = message.branchRunRollback;
    const runId =
      rollback && typeof rollback.runId === "string"
        ? rollback.runId.trim().slice(0, 160)
        : "";
    const groupId =
      rollback && typeof rollback.groupId === "string"
        ? rollback.groupId.trim().slice(0, 160)
        : "";
    const variantId =
      rollback && typeof rollback.variantId === "string"
        ? rollback.variantId.trim().slice(0, 160)
        : "";
    const fallbackVariantId =
      rollback && typeof rollback.fallbackVariantId === "string"
        ? rollback.fallbackVariantId.trim().slice(0, 160)
        : "";
    normalized.branchRunRollback =
      runId && groupId && variantId
        ? {
            runId,
            groupId,
            variantId,
            fallbackVariantId: fallbackVariantId || undefined
          }
        : undefined;
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
  if (has("generationOutcome")) {
    normalized.generationOutcome =
      message.generationOutcome === "complete" ||
      message.generationOutcome === "error" ||
      message.generationOutcome === "cancelled"
        ? message.generationOutcome
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

function normalizeReasoningEffort(value: unknown): OpenRouterReasoningEffort {
  const allowed = new Set<OpenRouterReasoningEffort>([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "none"
  ]);

  if (
    typeof value === "string" &&
    allowed.has(value as OpenRouterReasoningEffort)
  ) {
    return value === "xhigh"
      ? "high"
      : (value as OpenRouterReasoningEffort);
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

export function readRuntimeApiSettings(input: unknown): RuntimeApiSettings {
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
  const rawModelValue =
    typeof object.model === "string" ? object.model.trim() : "";
  const modelValue = isOpenAiRuntime(credentials)
    ? rawModelValue.replace(/^openai\//i, "")
    : rawModelValue;
  if (isOpenAiRuntime(credentials) && modelValue.includes("/")) {
    throw new Error(
      "API settings invalid: OpenAI Direct model IDs cannot use another provider prefix."
    );
  }
  const model =
    modelValue ||
    (Object.prototype.hasOwnProperty.call(object, "model")
      ? ""
      : defaults.model);
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
    apiStyle: normalizeApiStyle(object.apiStyle),
    model,
    reasoningEffort: isOpenRouterRuntime(credentials)
      ? normalizeReasoningEffort(
          object.reasoningEffort ?? defaults.reasoningEffort
        )
      : "none",
    uiComplexity: normalizeUiComplexity(
      object.uiComplexity ?? defaults.uiComplexity
    ),
    userPreferencePrompt: memorySettings.userPreferencePrompt,
    memoryItems: memorySettings.memoryItems
  };
}

function createChatRunId(now = Date.now()): string {
  return `run-${now}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createChatRunInput(
  body: ChatRequestBody,
  requestId: string,
  now = Date.now(),
  trustedStateKey?: string
): ChatRunInput {
  const apiSettings = readRuntimeApiSettings(body.apiSettings);
  const model = apiSettings.model;
  const messages = normalizeMessages(body.messages);
  const ephemeralFileIds = normalizeEphemeralFileIds(body.ephemeralFileIds);
  const files = normalizeSessionFiles(body.files);
  const canvasContext = normalizeCanvasContext(body.canvas);
  const themeMode = normalizeThemeMode(body.themeMode);
  const userMessage = normalizeSessionMessageInput(body.userMessage);
  const normalizedAssistantMessage = normalizeSessionMessageInput(
    body.assistantMessage
  );
  const assistantMessage = normalizedAssistantMessage
    ? { ...normalizedAssistantMessage, generationOutcome: undefined }
    : undefined;
  const requestedRunId = stringValue(body.runId, 160);
  const stateKey =
    trustedStateKey || getSessionStateKeyFromClientId(body.clientId);
  const runId =
    requestedRunId ||
    stringValue(assistantMessage?.generationRunId, 160) ||
    createChatRunId(now);

  return {
    requestId,
    startedAt: now,
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
    ephemeralFileIds,
    canvasContext,
    themeMode,
    useOpenRouterReasoning: isOpenRouterRuntime(apiSettings),
    searchSettings: body.searchSettings
  };
}
