export type WebDemoMessage = {
  role: "user" | "assistant";
  content: string;
};

export type WebDemoRequest = {
  messages: WebDemoMessage[];
  themeMode: "day" | "night";
  canvas: { width: number; height: number };
};

type FetchLike = typeof fetch;

export const WEB_DEMO_SERVICE_URL = import.meta.env?.DEV
  ? "/demo-service"
  : "https://service.aietheia.com";

function completedOutputText(event: unknown): string {
  if (!event || typeof event !== "object") {
    return "";
  }
  const response = (event as { response?: unknown }).response;
  if (!response || typeof response !== "object") {
    return "";
  }
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) {
    return "";
  }
  return output
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const content = (item as { content?: unknown }).content;
      return Array.isArray(content) ? content : [];
    })
    .map((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "output_text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? String((part as { text: string }).text)
        : ""
    )
    .join("");
}

export function webDemoTextFromEvent(event: unknown): {
  delta: string;
  completedText: string;
} {
  if (!event || typeof event !== "object") {
    return { delta: "", completedText: "" };
  }
  const record = event as { type?: unknown; delta?: unknown };
  return {
    delta:
      record.type === "response.output_text.delta" &&
      typeof record.delta === "string"
        ? record.delta
        : "",
    completedText:
      record.type === "response.completed" ? completedOutputText(event) : ""
  };
}

export async function streamWebDemoResponse(
  request: WebDemoRequest,
  signal: AbortSignal,
  onDelta: (delta: string) => void,
  fetchImpl: FetchLike = fetch,
  serviceUrl = WEB_DEMO_SERVICE_URL
): Promise<string> {
  const response = await fetchImpl(`${serviceUrl}/v1/web-demo/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal
  });
  if (!response.ok || !response.body) {
    throw new Error(`Web Demo request failed (${response.status}).`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assembled = "";
  const acceptBlock = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") {
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    const text = webDemoTextFromEvent(event);
    if (text.delta) {
      assembled += text.delta;
      onDelta(text.delta);
      return;
    }
    if (!assembled && text.completedText) {
      assembled = text.completedText;
      onDelta(text.completedText);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      blocks.forEach(acceptBlock);
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      acceptBlock(buffer);
    }
  } finally {
    reader.releaseLock();
  }
  if (!assembled.trim()) {
    throw new Error("The Web Demo returned no visible response.");
  }
  return assembled;
}
