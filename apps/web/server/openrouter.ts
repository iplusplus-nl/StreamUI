import type { Request, Response } from "express";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { streamText, type ModelMessage, type TextStreamPart } from "ai";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

const DEFAULT_MODEL = "google/gemini-3.1-pro-preview";
const DEFAULT_REASONING_EFFORT: OpenRouterReasoningEffort = "low";
const DEFAULT_WEB_TOOLS_ENABLED = true;
const DEFAULT_DATETIME_TOOL_ENABLED = true;
const DEFAULT_WEB_SEARCH_ENGINE = "auto";
const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5;
const DEFAULT_WEB_SEARCH_MAX_TOTAL_RESULTS = 12;
const DEFAULT_WEB_SEARCH_CONTEXT_SIZE = "medium";
const DEFAULT_WEB_FETCH_ENGINE = "auto";
const DEFAULT_WEB_FETCH_MAX_USES = 6;
const DEFAULT_WEB_FETCH_MAX_CONTENT_TOKENS = 50_000;
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_DATA_URL_LENGTH = 3_000_000;

type ChatRole = "user" | "assistant" | "system";
type OpenRouterReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "none";

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

type StreamEvent = {
  type: "content" | "reasoning";
  text: string;
};

type ToolStreamState = {
  seenToolLabels: Set<string>;
  contentChars: number;
  contentEvents: number;
  reasoningChars: number;
  reasoningEvents: number;
};

type OpenRouterServerTool =
  | {
      type: "openrouter:web_search";
      parameters: {
        engine: string;
        max_results: number;
        max_total_results: number;
        search_context_size: string;
        allowed_domains?: string[];
        excluded_domains?: string[];
      };
    }
  | {
      type: "openrouter:web_fetch";
      parameters: {
        engine: string;
        max_uses: number;
        max_content_tokens: number;
        allowed_domains?: string[];
        blocked_domains?: string[];
      };
    }
  | {
      type: "openrouter:datetime";
    };

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.round(Math.min(max, Math.max(min, value)));
}

function clampInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number
) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.round(Math.min(max, Math.max(min, parsed)));
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function normalizeChoice<T extends string>(
  value: unknown,
  fallback: T,
  allowed: readonly T[]
): T {
  if (typeof value === "string" && allowed.includes(value.trim() as T)) {
    return value.trim() as T;
  }

  return fallback;
}

function normalizeDomainList(value: unknown): string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const domains = value
    .split(",")
    .map((domain) => domain.trim())
    .filter(Boolean);

  return domains.length ? domains : undefined;
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

function buildOpenRouterTools(): OpenRouterServerTool[] | undefined {
  const webToolsEnabled = normalizeBoolean(
    process.env.OPENROUTER_WEB_TOOLS,
    DEFAULT_WEB_TOOLS_ENABLED
  );
  const datetimeToolEnabled = normalizeBoolean(
    process.env.OPENROUTER_DATETIME_TOOL,
    DEFAULT_DATETIME_TOOL_ENABLED
  );
  const tools: OpenRouterServerTool[] = [];

  if (webToolsEnabled) {
    const allowedDomains = normalizeDomainList(
      process.env.OPENROUTER_WEB_ALLOWED_DOMAINS
    );
    const blockedDomains = normalizeDomainList(
      process.env.OPENROUTER_WEB_BLOCKED_DOMAINS
    );
    const searchEngine = normalizeChoice(
      process.env.OPENROUTER_WEB_SEARCH_ENGINE,
      DEFAULT_WEB_SEARCH_ENGINE,
      ["auto", "native", "exa", "firecrawl", "parallel", "perplexity"] as const
    );
    const fetchEngine = normalizeChoice(
      process.env.OPENROUTER_WEB_FETCH_ENGINE,
      DEFAULT_WEB_FETCH_ENGINE,
      ["auto", "native", "exa", "openrouter", "firecrawl", "parallel"] as const
    );
    const searchContextSize = normalizeChoice(
      process.env.OPENROUTER_WEB_SEARCH_CONTEXT_SIZE,
      DEFAULT_WEB_SEARCH_CONTEXT_SIZE,
      ["low", "medium", "high"] as const
    );

    tools.push({
      type: "openrouter:web_search",
      parameters: {
        engine: searchEngine,
        max_results: clampInteger(
          process.env.OPENROUTER_WEB_SEARCH_MAX_RESULTS,
          DEFAULT_WEB_SEARCH_MAX_RESULTS,
          1,
          25
        ),
        max_total_results: clampInteger(
          process.env.OPENROUTER_WEB_SEARCH_MAX_TOTAL_RESULTS,
          DEFAULT_WEB_SEARCH_MAX_TOTAL_RESULTS,
          1,
          100
        ),
        search_context_size: searchContextSize,
        ...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
        ...(blockedDomains ? { excluded_domains: blockedDomains } : {})
      }
    });

    tools.push({
      type: "openrouter:web_fetch",
      parameters: {
        engine: fetchEngine,
        max_uses: clampInteger(
          process.env.OPENROUTER_WEB_FETCH_MAX_USES,
          DEFAULT_WEB_FETCH_MAX_USES,
          1,
          50
        ),
        max_content_tokens: clampInteger(
          process.env.OPENROUTER_WEB_FETCH_MAX_CONTENT_TOKENS,
          DEFAULT_WEB_FETCH_MAX_CONTENT_TOKENS,
          1_000,
          200_000
        ),
        ...(allowedDomains ? { allowed_domains: allowedDomains } : {}),
        ...(blockedDomains ? { blocked_domains: blockedDomains } : {})
      }
    });
  }

  if (datetimeToolEnabled) {
    tools.push({ type: "openrouter:datetime" });
  }

  return tools.length ? tools : undefined;
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

function buildCanvasContextPrompt(canvas: CanvasContext): string {
  const ratio = (canvas.canvasWidth / canvas.initialCanvasHeight).toFixed(2);

  return `Current StreamUI canvas context:
- The artifact is rendered as the assistant message itself, not as a framed preview card or app panel.
- Current canvas width is about ${canvas.canvasWidth}px inside a ${canvas.viewportWidth}px viewport.
- The initial visible fold is about ${canvas.initialCanvasHeight}px tall, roughly ${ratio}:1 width-to-height.
- The canvas auto-expands downward to fit your content. There is no fixed artifact height.
- Design for a vertical conversation canvas: use width: 100%, responsive max-widths, and natural document flow.
- Do not create internal scroll containers for the main artifact. Avoid fixed heights, 100vh layouts, and overflow: auto on the root.
- For normal replies, use the built-in chat bubble classes: streamui-response and streamui-chat.
- The default reply should usually be:
  <section class="streamui-response"><div class="streamui-chat"><p>...</p></div></section>
- Put all conversational language inside the HTML artifact. Keep <chat></chat> empty.
- Be natural and direct. Do not adopt a special persona.
- For visual, interactive, educational, spatial, or exploratory requests, make a distinctive crafted artifact rather than a conventional rounded-card layout.
- Avoid generic colorful cards, dashboards, KPI tiles, pricing panels, feature grids, and SaaS-like composition unless explicitly requested.
- Prefer art-directed compositions: annotated scenes, editorial spreads, maps, instruments, timelines, specimen sheets, exploded diagrams, posters, stage sets, spatial canvases, layered cutaways, kinetic miniatures, or object-focused interfaces.
- Use cards only when structurally necessary, and make surfaces feel integrated through precise spacing, restrained radius, tactile borders, shadow, texture, unusual geometry, or material contrast.
- Keep the design polished: coherent palette, strong typographic hierarchy, balanced negative space, clear focal point, and details that reward inspection without becoming clutter.
- Keep the artifact focused: choose a strong visual idea and avoid repetitive filler, giant SVG paths, large embedded data, or exhaustive code unless the user explicitly asks for it.
- The user may attach images. Inspect uploaded images directly and treat them as first-class context for analysis, OCR, comparison, critique, or visual redesign requests.
- When useful, combine observations from uploaded images with external web sources in one coherent HTML artifact.
- You can use server-side web_search, web_fetch, and datetime tools when the user asks for a page, URL, external resource, or current information.
- If you use web information, render source links inside the HTML. Prefer concrete links and citations over vague "from the web" language.
- Prefer real external images, media, documents, demos, datasets, official pages, and primary references over invented placeholders when they improve the response.
- For visual or research-like requests, collect several complementary sources or resource types and synthesize them into one coherent HTML artifact.
- When embedding external media, use direct HTTPS URLs, meaningful alt text, lazy loading when possible, captions, and nearby source links.
- The iframe may use HTTPS images, media, links, stylesheets, scripts, and CORS-friendly fetches when they directly help the user's request.
- Prefer server-side web_fetch for reading web pages. Runtime fetch cannot read most ordinary pages because of browser CORS.
- For custom visuals, make progress visible while streaming by alternating small style islands and matching visible HTML.
- After <streamui>, emit visible HTML quickly. If custom CSS is needed, use one tiny <style> block, then immediately emit the matching HTML.
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
}

function describeToolCall(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const toolCall = value as {
    type?: unknown;
    name?: unknown;
    toolName?: unknown;
    function?: {
      name?: unknown;
    };
  };
  const rawName =
    typeof toolCall.function?.name === "string"
      ? toolCall.function.name
      : typeof toolCall.toolName === "string"
        ? toolCall.toolName
        : typeof toolCall.name === "string"
          ? toolCall.name
          : typeof toolCall.type === "string"
            ? toolCall.type
            : "";
  const name = rawName.toLowerCase();

  if (name.includes("web_search")) {
    return "Searching the web...";
  }
  if (name.includes("web_fetch")) {
    return "Fetching the page...";
  }
  if (name.includes("datetime")) {
    return "Checking the current time...";
  }

  return rawName ? `Using ${rawName}...` : "";
}

function writeToolCallHint(
  value: unknown,
  state: ToolStreamState,
  res: Response
): void {
  const label = describeToolCall(value);
  if (!label || state.seenToolLabels.has(label)) {
    return;
  }

  state.seenToolLabels.add(label);
  writeStreamEvent(res, { type: "reasoning", text: label }, state);
}

function normalizeReasoningEffort(value: unknown): OpenRouterReasoningEffort {
  const allowed = new Set<OpenRouterReasoningEffort>([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "none"
  ]);

  if (typeof value === "string" && allowed.has(value as OpenRouterReasoningEffort)) {
    return value as OpenRouterReasoningEffort;
  }

  return DEFAULT_REASONING_EFFORT;
}

function readStreamText(part: TextStreamPart<any>): string {
  if (part.type !== "text-delta" && part.type !== "reasoning-delta") {
    return "";
  }

  const compatPart = part as { text?: unknown; delta?: unknown };
  if (typeof compatPart.text === "string") {
    return compatPart.text;
  }
  if (typeof compatPart.delta === "string") {
    return compatPart.delta;
  }

  return "";
}

function writeAiSdkStreamPart(
  part: TextStreamPart<any>,
  res: Response,
  state: ToolStreamState
): void {
  if (part.type === "tool-input-start" || part.type === "tool-call") {
    writeToolCallHint(part, state, res);
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
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    res
      .status(500)
      .type("text/plain")
      .send(
        "OPENROUTER_API_KEY is not set. Copy .env.example to .env and add your OpenRouter key."
      );
    return;
  }

  const body = req.body as {
    messages?: unknown;
    model?: unknown;
    canvas?: unknown;
    reasoningEffort?: unknown;
  };
  const model =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const messages = normalizeMessages(body.messages);
  const canvasContext = normalizeCanvasContext(body.canvas);
  const reasoningEffort = normalizeReasoningEffort(
    body.reasoningEffort ?? process.env.OPENROUTER_REASONING_EFFORT
  );
  const tools = buildOpenRouterTools();
  const requestId = Math.random().toString(36).slice(2, 9);
  const startedAt = Date.now();

  try {
    console.info(
      `[chat:${requestId}] start model=${model} messages=${messages.length} reasoning=${reasoningEffort}`
    );

    const openrouter = createOpenRouter({
      apiKey,
      appName: "StreamUI Runtime Demo",
      appUrl: "http://localhost:5173",
      compatibility: "strict"
    });

    const result = streamText({
      model: openrouter(model, {
        extraBody: {
          include_reasoning: true,
          reasoning: {
            effort: reasoningEffort,
            exclude: false,
            enabled: true
          },
          ...(tools ? { tools } : {})
        }
      }),
      system: [SYSTEM_PROMPT, buildCanvasContextPrompt(canvasContext)].join(
        "\n\n"
      ),
      messages: messages.map(toModelMessage)
    });

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const toolStreamState: ToolStreamState = {
      seenToolLabels: new Set(),
      contentChars: 0,
      contentEvents: 0,
      reasoningChars: 0,
      reasoningEvents: 0
    };

    for await (const part of result.fullStream) {
      writeAiSdkStreamPart(part, res, toolStreamState);
    }

    res.end();
    console.info(
      `[chat:${requestId}] complete duration_ms=${Date.now() - startedAt} content_chars=${toolStreamState.contentChars} content_events=${toolStreamState.contentEvents} reasoning_chars=${toolStreamState.reasoningChars} reasoning_events=${toolStreamState.reasoningEvents}`
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown OpenRouter proxy error.";
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
