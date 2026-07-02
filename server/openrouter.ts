import type { Request, Response } from "express";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "google/gemini-3.5-flash";
const DEFAULT_REASONING_EFFORT = "low";
const DEFAULT_WEB_TOOLS_ENABLED = true;
const DEFAULT_DATETIME_TOOL_ENABLED = true;
const DEFAULT_WEB_SEARCH_ENGINE = "auto";
const DEFAULT_WEB_SEARCH_MAX_RESULTS = 5;
const DEFAULT_WEB_SEARCH_MAX_TOTAL_RESULTS = 12;
const DEFAULT_WEB_SEARCH_CONTEXT_SIZE = "medium";
const DEFAULT_WEB_FETCH_ENGINE = "auto";
const DEFAULT_WEB_FETCH_MAX_USES = 6;
const DEFAULT_WEB_FETCH_MAX_CONTENT_TOKENS = 50_000;

type ChatRole = "user" | "assistant" | "system";

type ClientChatMessage = {
  role: ChatRole;
  content: string;
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
  const canvas = typeof input === "object" && input !== null ? input as Partial<CanvasContext> : {};
  const viewportWidth = clampNumber(canvas.viewportWidth, 1280, 320, 3840);
  const viewportHeight = clampNumber(canvas.viewportHeight, 720, 320, 2400);
  const canvasWidth = clampNumber(canvas.canvasWidth, Math.min(900, viewportWidth - 96), 280, 1400);
  const initialCanvasHeight = clampNumber(canvas.initialCanvasHeight, Math.round(canvasWidth * 0.62), 180, 1000);
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
- You can use server-side web_search, web_fetch, and datetime tools when the user asks for a page, URL, external resource, or current information.
- If you use web information, render source links inside the HTML. Prefer concrete links and citations over vague "from the web" language.
- The iframe may use HTTPS images, media, links, stylesheets, scripts, and CORS-friendly fetches when they directly help the user's request.
- Prefer server-side web_fetch for reading web pages. Runtime fetch cannot read most ordinary pages because of browser CORS.
- For custom visuals, make progress visible while streaming by alternating small style islands and matching visible HTML.
- After <streamui>, emit visible HTML quickly. If custom CSS is needed, use one tiny <style> block, then immediately emit the matching HTML.
- Keep each custom style island around 600 characters or less. Do not output one huge global CSS block before the visible canvas.
- Unless the user asks for product UI, avoid software cards, dashboards, pricing panels, feature grids, and generic SaaS composition.
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

function writeStreamEvent(res: Response, event: StreamEvent): void {
  if (!event.text) {
    return;
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
    function?: {
      name?: unknown;
    };
  };
  const rawName =
    typeof toolCall.function?.name === "string"
      ? toolCall.function.name
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

function writeToolCallHints(
  value: unknown,
  state: ToolStreamState,
  res: Response
): void {
  if (!Array.isArray(value)) {
    return;
  }

  for (const toolCall of value) {
    const label = describeToolCall(toolCall);
    if (!label || state.seenToolLabels.has(label)) {
      continue;
    }

    state.seenToolLabels.add(label);
    writeStreamEvent(res, { type: "reasoning", text: label });
  }
}

function stringifyReasoning(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const maybeReasoning = value as {
    text?: unknown;
    content?: unknown;
    summary?: unknown;
    encrypted_content?: unknown;
  };

  if (typeof maybeReasoning.text === "string") {
    return maybeReasoning.text;
  }
  if (typeof maybeReasoning.content === "string") {
    return maybeReasoning.content;
  }
  if (typeof maybeReasoning.summary === "string") {
    return maybeReasoning.summary;
  }

  return "";
}

function normalizeReasoningEffort(value: unknown): string {
  const allowed = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

  if (typeof value === "string" && allowed.has(value)) {
    return value;
  }

  return DEFAULT_REASONING_EFFORT;
}

function writeOpenRouterEvent(
  event: string,
  res: Response,
  state: ToolStreamState
): void {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  if (!data || data === "[DONE]") {
    return;
  }

  try {
    const parsed = JSON.parse(data) as {
      choices?: Array<{
        delta?: {
          content?: string;
          reasoning?: unknown;
          reasoning_content?: string;
          tool_calls?: unknown;
        };
        message?: {
          content?: string;
          reasoning?: unknown;
          reasoning_content?: string;
          tool_calls?: unknown;
        };
      }>;
    };
    const choice = parsed.choices?.[0];
    writeToolCallHints(choice?.delta?.tool_calls, state, res);
    writeToolCallHints(choice?.message?.tool_calls, state, res);

    const reasoning =
      choice?.delta?.reasoning_content ??
      stringifyReasoning(choice?.delta?.reasoning) ??
      choice?.message?.reasoning_content ??
      stringifyReasoning(choice?.message?.reasoning);
    const content =
      choice?.delta?.content ??
      choice?.message?.content ??
      "";

    if (reasoning) {
      writeStreamEvent(res, { type: "reasoning", text: reasoning });
    }
    if (content) {
      writeStreamEvent(res, { type: "content", text: content });
    }
  } catch {
    writeStreamEvent(res, { type: "content", text: data });
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

  try {
    const openRouterResponse = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:5173",
        "X-Title": "StreamUI Runtime Demo"
      },
      body: JSON.stringify({
        model,
        stream: true,
        include_reasoning: true,
        reasoning: {
          effort: reasoningEffort,
          exclude: false,
          enabled: true
        },
        ...(tools ? { tools } : {}),
        messages: [
          {
            role: "system",
            content: SYSTEM_PROMPT
          },
          {
            role: "system",
            content: buildCanvasContextPrompt(canvasContext)
          },
          ...messages
        ]
      })
    });

    if (!openRouterResponse.ok || !openRouterResponse.body) {
      const errorText = await openRouterResponse.text();
      res
        .status(openRouterResponse.status)
        .type("text/plain")
        .send(
          errorText ||
            `OpenRouter returned HTTP ${openRouterResponse.status}.`
        );
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const reader = openRouterResponse.body.getReader();
    const decoder = new TextDecoder();
    const toolStreamState: ToolStreamState = {
      seenToolLabels: new Set()
    };
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\n\n/);
      buffer = events.pop() ?? "";

      for (const event of events) {
        writeOpenRouterEvent(event, res, toolStreamState);
      }
    }

    const tail = decoder.decode();
    if (tail) {
      buffer += tail;
    }
    if (buffer.trim()) {
      writeOpenRouterEvent(buffer, res, toolStreamState);
    }

    res.end();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown OpenRouter proxy error.";

    if (!res.headersSent) {
      res.status(500).type("text/plain").send(message);
      return;
    }

    res.write(`\n[proxy error] ${message}`);
    res.end();
  }
}
