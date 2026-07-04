import type { Request, Response } from "express";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { streamText, type ModelMessage, type TextStreamPart } from "ai";
import { buildAgentLoopPrompt, runStreamUiAgentLoop } from "./agentLoop.js";
import {
  readRuntimeApiCredentials,
  type ApiKeySource
} from "./runtimeApiSettings.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_DATA_URL_LENGTH = 3_000_000;
const MAX_USER_PREFERENCE_LENGTH = 4_000;

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
  userPreference: string;
};

type ClientImageAttachment = {
  name?: string;
  mimeType?: string;
  size?: number;
  dataUrl: string;
};

type ClientChatMessage = {
  role: ChatRole;
  content: string;
  images?: ClientImageAttachment[];
};

type CanvasContext = {
  viewportWidth: number;
  viewportHeight: number;
  canvasWidth: number;
  initialCanvasHeight: number;
  devicePixelRatio: number;
};

type PageThemeMode = "day" | "night";

type StreamEvent = {
  type: "content" | "reasoning";
  text: string;
};

type ToolStreamState = {
  contentChars: number;
  contentEvents: number;
  reasoningChars: number;
  reasoningEvents: number;
};

function flushResponse(res: Response): void {
  const flush = (res as Response & { flush?: () => void }).flush;
  if (typeof flush === "function") {
    flush.call(res);
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.round(Math.min(max, Math.max(min, value)));
}

function normalizeUploadedImages(input: unknown): ClientImageAttachment[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .slice(0, MAX_IMAGES_PER_MESSAGE)
    .filter((image): image is Partial<ClientImageAttachment> => {
      return typeof image === "object" && image !== null;
    })
    .map((image) => ({
      name: typeof image.name === "string" ? image.name.slice(0, 160) : undefined,
      mimeType:
        typeof image.mimeType === "string" ? image.mimeType.slice(0, 80) : undefined,
      size:
        typeof image.size === "number" && Number.isFinite(image.size)
          ? image.size
          : undefined,
      dataUrl: typeof image.dataUrl === "string" ? image.dataUrl : ""
    }))
    .filter((image) => {
      return (
        image.dataUrl.length <= MAX_IMAGE_DATA_URL_LENGTH &&
        /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(
          image.dataUrl
        )
      );
    });
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

function normalizeUserPreference(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }

  return input.trim().slice(0, MAX_USER_PREFERENCE_LENGTH);
}

function buildUserPreferencePrompt(userPreference: string): string {
  if (!userPreference) {
    return "";
  }

  return `用户偏好:
The following text is persistent user-provided guidance. Follow it when relevant unless it conflicts with higher-priority instructions.

${userPreference}`;
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
- When useful, combine observations from uploaded images with injected retrieval sources in one coherent HTML artifact.
- If independent StreamUI retrieval context is provided, use it for URLs, external resources, current information, source images, and page details.
- If you use retrieval information, render source links inside the HTML. Prefer concrete links and citations over vague "from the web" language.
- Prefer real external images, media, documents, demos, datasets, official pages, and primary references over invented placeholders when they improve the response.
- For visual or research-like requests, synthesize the provided complementary sources or resource types into one coherent HTML artifact.
- When embedding external media, use direct HTTPS URLs, meaningful alt text, lazy loading when possible, captions, and nearby source links.
- For gallery, photo, picture, image, wallpaper, or visual-reference requests, real imagery is required. Use "Verified image URLs" when provided, copy those URLs exactly into <img src>, do not modify provider URL paths, query strings, or CDN parameters, and include source links.
- If retrieval provides too few direct image URLs for the requested gallery, say so inside the artifact and show source links instead of rendering broken image tags.
- The iframe may use HTTPS images, media, links, stylesheets, scripts, and CORS-friendly fetches when they directly help the user's request.
- Prefer injected retrieval excerpts for reading web pages. Runtime fetch cannot read most ordinary pages because of browser CORS.
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
      content: String(message.content).slice(0, 20_000),
      images:
        message.role === "assistant"
          ? []
          : normalizeUploadedImages((message as { images?: unknown }).images)
    }));
}

function toModelMessage(message: ClientChatMessage): ModelMessage {
  const images = message.images ?? [];
  if (!images.length || message.role !== "user") {
    return {
      role: message.role,
      content: message.content
    };
  }

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: message.content || "Please respond to the attached image."
      },
      ...images.map((image) => ({
        type: "image" as const,
        image: image.dataUrl,
        mediaType: image.mimeType
      }))
    ]
  };
}

function toPlannerMessage(message: ClientChatMessage): ModelMessage {
  const imageCount = message.images?.length ?? 0;
  const imageNote = imageCount
    ? `\n\n[${imageCount} uploaded image attachment(s) will be available to the final generator.]`
    : "";
  const content =
    `${message.content}${imageNote}`.trim() ||
    "The user sent an empty message.";

  return {
    role: message.role,
    content
  };
}

function writeStreamEvent(
  res: Response,
  event: StreamEvent,
  state?: ToolStreamState
): void {
  if (!event.text) {
    return;
  }

  if (state) {
    if (event.type === "content") {
      state.contentChars += event.text.length;
      state.contentEvents += 1;
    } else {
      state.reasoningChars += event.text.length;
      state.reasoningEvents += 1;
    }
  }

  res.write(`${JSON.stringify(event)}\n`);
  flushResponse(res);
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
  const object =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const credentials = readRuntimeApiCredentials(input);
  const model = typeof object.model === "string" ? object.model.trim() : "";
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

  return {
    ...credentials,
    model,
    reasoningEffort: normalizeReasoningEffort(object.reasoningEffort),
    userPreference: normalizeUserPreference(object.userPreference)
  };
}

function isOpenRouterRuntime(settings: RuntimeApiSettings): boolean {
  return (
    /openrouter/i.test(settings.providerName) ||
    settings.baseUrl.toLowerCase().includes("openrouter.ai")
  );
}

function buildPlannerModelOptions(useOpenRouterReasoning: boolean) {
  if (!useOpenRouterReasoning) {
    return undefined;
  }

  return {
    extraBody: {
      reasoning: {
        effort: "minimal",
        exclude: true,
        enabled: true
      }
    }
  };
}

function buildFinalModelOptions(
  reasoningEffort: OpenRouterReasoningEffort,
  useOpenRouterReasoning: boolean
) {
  if (!useOpenRouterReasoning || reasoningEffort === "none") {
    return undefined;
  }

  return {
    extraBody: {
      include_reasoning: true,
      reasoning: {
        effort: reasoningEffort,
        exclude: false,
        enabled: true
      }
    }
  };
}

function readStreamText(part: TextStreamPart<any>): string {
  if (part.type !== "text-delta" && part.type !== "reasoning-delta") {
    return "";
  }

  const compatPart = part as {
    text?: unknown;
    delta?: unknown;
    textDelta?: unknown;
  };
  if (typeof compatPart.text === "string") {
    return compatPart.text;
  }
  if (typeof compatPart.delta === "string") {
    return compatPart.delta;
  }
  if (typeof compatPart.textDelta === "string") {
    return compatPart.textDelta;
  }

  return "";
}

function writeAiSdkStreamPart(
  part: TextStreamPart<any>,
  res: Response,
  state: ToolStreamState
): void {
  if (part.type === "tool-input-start" || part.type === "tool-call") {
    return;
  }

  if (part.type === "reasoning-delta") {
    writeStreamEvent(
      res,
      { type: "reasoning", text: readStreamText(part) },
      state
    );
    return;
  }

  if (part.type === "text-delta") {
    writeStreamEvent(
      res,
      { type: "content", text: readStreamText(part) },
      state
    );
    return;
  }

  if (part.type === "error") {
    throw part.error instanceof Error
      ? part.error
      : new Error("OpenRouter stream returned an error.");
  }
}

export async function handleOpenRouterChat(
  req: Request,
  res: Response
): Promise<void> {
  const body = req.body as {
    messages?: unknown;
    canvas?: unknown;
    themeMode?: unknown;
    apiSettings?: unknown;
    searchSettings?: unknown;
  };
  const requestId = Math.random().toString(36).slice(2, 9);
  const startedAt = Date.now();

  try {
    const apiSettings = readRuntimeApiSettings(body.apiSettings);
    const model = apiSettings.model;
    const messages = normalizeMessages(body.messages);
    const canvasContext = normalizeCanvasContext(body.canvas);
    const themeMode = normalizeThemeMode(body.themeMode);
    const useOpenRouterReasoning = isOpenRouterRuntime(apiSettings);
    console.info(
      `[chat:${requestId}] start provider=${apiSettings.providerName} base_url=${apiSettings.baseUrl} model=${model} messages=${messages.length} theme=${themeMode} reasoning=${apiSettings.reasoningEffort} key_source=${apiSettings.apiKeySource} key_env=${apiSettings.apiKeyEnvironmentName}`
    );

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.socket?.setNoDelay(true);
    res.flushHeaders();

    const toolStreamState: ToolStreamState = {
      contentChars: 0,
      contentEvents: 0,
      reasoningChars: 0,
      reasoningEvents: 0
    };

    const provider = createOpenRouter({
      apiKey: apiSettings.apiKey,
      baseURL: apiSettings.baseUrl,
      appName: "StreamUI Runtime Demo",
      appUrl: "http://localhost:5173",
      compatibility: useOpenRouterReasoning ? "strict" : "compatible"
    });

    const agentLoop = await runStreamUiAgentLoop({
      model: provider(model, buildPlannerModelOptions(useOpenRouterReasoning)),
      messages: messages.map(toPlannerMessage),
      retrievalMessages: messages.map((message) => ({
        role: message.role,
        content: message.content
      })),
      searchSettings: body.searchSettings,
      onStatus: (text) => {
        writeStreamEvent(res, { type: "reasoning", text }, toolStreamState);
      }
    });

    const result = streamText({
      model: provider(
        model,
        buildFinalModelOptions(apiSettings.reasoningEffort, useOpenRouterReasoning)
      ),
      system: [
        SYSTEM_PROMPT,
        buildUserPreferencePrompt(apiSettings.userPreference),
        buildThemeContextPrompt(themeMode),
        buildCanvasContextPrompt(canvasContext),
        buildAgentLoopPrompt(agentLoop)
      ]
        .filter(Boolean)
        .join("\n\n"),
      messages: messages.map(toModelMessage)
    });

    for await (const part of result.fullStream) {
      writeAiSdkStreamPart(part, res, toolStreamState);
    }

    res.end();
    console.info(
      `[chat:${requestId}] complete duration_ms=${Date.now() - startedAt} agent_steps=${agentLoop.steps.length} retrieval_used=${agentLoop.retrievalContext.used} retrieval_sources=${agentLoop.retrievalContext.sources.length} content_chars=${toolStreamState.contentChars} content_events=${toolStreamState.contentEvents} reasoning_chars=${toolStreamState.reasoningChars} reasoning_events=${toolStreamState.reasoningEvents}`
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown chat proxy error.";
    console.error(`[chat:${requestId}] error ${message}`);

    if (!res.headersSent) {
      res.status(500).type("text/plain").send(message);
      return;
    }

    writeStreamEvent(res, {
      type: "content",
      text: `\n\n[proxy error] ${message}`
    });
    res.end();
  }
}
