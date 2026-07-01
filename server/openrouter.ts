import type { Request, Response } from "express";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "z-ai/glm-5.2";
const DEFAULT_REASONING_EFFORT = "low";

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

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.round(Math.min(max, Math.max(min, value)));
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
- The artifact is rendered as the assistant message itself, not as a framed preview card.
- Current canvas width is about ${canvas.canvasWidth}px inside a ${canvas.viewportWidth}px viewport.
- The initial visible fold is about ${canvas.initialCanvasHeight}px tall, roughly ${ratio}:1 width-to-height.
- The canvas auto-expands downward to fit your content. There is no fixed artifact height.
- Design for a vertical conversation canvas: use width: 100%, responsive max-widths, and natural document flow.
- Do not create internal scroll containers for the main artifact. Avoid fixed heights, 100vh layouts, and overflow: auto on the root.
- Make progress visible while streaming by alternating small style islands and matching controls.
- After <streamui>, emit one tiny <style> block for the first visible section, then immediately emit that section's HTML.
- Keep each style island around 600 characters or less. If a section needs more styling, first render the minimal visible control, then add enhancement style islands later.
- Repeat this pattern for each new section or control: short scoped <style>, then the matching HTML. Do not output one huge global CSS block before the UI.
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

function writeOpenRouterEvent(event: string, res: Response): void {
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
        };
        message?: {
          content?: string;
          reasoning?: unknown;
          reasoning_content?: string;
        };
      }>;
    };
    const choice = parsed.choices?.[0];
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
        writeOpenRouterEvent(event, res);
      }
    }

    const tail = decoder.decode();
    if (tail) {
      buffer += tail;
    }
    if (buffer.trim()) {
      writeOpenRouterEvent(buffer, res);
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
