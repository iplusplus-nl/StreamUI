import { bufferToDataUrl, readStoredFile } from "./fileStore.js";

const MAX_SESSION_FILES = 120;
const MAX_FILE_TEXT_CHARS = 120_000;
const MAX_TOOL_TEXT_CHARS = 80_000;
const MAX_DATA_URL_CHARS = 24_000_000;

export type SessionFileKind = "image" | "artifact" | "text";

export type SessionFile = {
  id: string;
  kind: SessionFileKind;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
  sourceMessageId?: string;
  storageKey?: string;
  contentHash?: string;
  accessToken?: string;
  embedUrl?: string;
  downloadUrl?: string;
  draft?: boolean;
  dataUrl?: string;
  text?: string;
  width?: number;
  height?: number;
  summary?: string;
};

export type ResponsesInputContentPart =
  | {
      type: "input_text";
      text: string;
    }
  | {
      type: "input_image";
      image_url: string;
    }
  | {
      type: "input_file";
      filename?: string;
      file_data?: string;
      file_url?: string;
    };

export type ResponsesToolOutput = string | ResponsesInputContentPart[];

export type ReadFileToolResult = {
  output: ResponsesToolOutput;
  followUpContent?: ResponsesInputContentPart[];
};

export type ReadFileToolOptions = {
  allowImageInput?: boolean;
};

export type ResponsesToolDefinition = {
  type: "function";
  name: string;
  description: string;
  strict: null;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
};

export type SessionFileToolStats = {
  lists: number;
  reads: number;
  errors: number;
};

function stringValue(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : fallback;
}

function normalizeSessionFile(input: unknown): SessionFile | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const file = input as Partial<SessionFile>;
  if (file.draft) {
    return null;
  }

  const kind =
    file.kind === "image" || file.kind === "artifact" || file.kind === "text"
      ? file.kind
      : null;
  const id = stringValue(file.id, 120);
  const name = stringValue(file.name, 180);
  if (!kind || !id || !name) {
    return null;
  }

  const rawDataUrl = typeof file.dataUrl === "string" ? file.dataUrl.trim() : "";
  const storageKey = stringValue(file.storageKey, 260);
  const dataUrl =
    rawDataUrl.length <= MAX_DATA_URL_CHARS
      ? rawDataUrl
      : storageKey
        ? ""
        : rawDataUrl;
  const text = stringValue(file.text, MAX_FILE_TEXT_CHARS);
  if (kind === "image" && !dataUrl && !storageKey) {
    return null;
  }
  if ((kind === "artifact" || kind === "text") && !text && !storageKey) {
    return null;
  }

  return {
    id,
    kind,
    name,
    mimeType:
      stringValue(file.mimeType, 120) || (kind === "image" ? "image/png" : "text/plain"),
    size: numberValue(file.size, text.length),
    createdAt: numberValue(file.createdAt, Date.now()),
    sourceMessageId: stringValue(file.sourceMessageId, 160) || undefined,
    storageKey: storageKey || undefined,
    contentHash: stringValue(file.contentHash, 120) || undefined,
    accessToken: stringValue(file.accessToken, 160) || undefined,
    embedUrl: stringValue(file.embedUrl, 2_000) || undefined,
    downloadUrl: stringValue(file.downloadUrl, 2_000) || undefined,
    dataUrl: dataUrl || undefined,
    text: text || undefined,
    width: numberValue(file.width) || undefined,
    height: numberValue(file.height) || undefined,
    summary: stringValue(file.summary, 1_200) || undefined
  };
}

export function normalizeSessionFiles(input: unknown): SessionFile[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const files: SessionFile[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const file = normalizeSessionFile(item);
    if (!file || seen.has(file.id)) {
      continue;
    }
    seen.add(file.id);
    files.push(file);
    if (files.length >= MAX_SESSION_FILES) {
      break;
    }
  }

  return files;
}

export function createSessionFileToolStats(): SessionFileToolStats {
  return {
    lists: 0,
    reads: 0,
    errors: 0
  };
}

function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const keep = Math.max(0, maxChars - 120);
  return `${value.slice(0, keep)}\n\n[... clipped ${value.length - keep} chars ...]`;
}

function listFileEntry(file: SessionFile) {
  return {
    id: file.id,
    kind: file.kind,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    createdAt: file.createdAt,
    sourceMessageId: file.sourceMessageId,
    contentHash: file.contentHash,
    embedUrl: file.embedUrl,
    downloadUrl: file.downloadUrl,
    width: file.width,
    height: file.height,
    summary: file.summary
  };
}

function normalizeImageDataUrl(dataUrl: string, fallbackMimeType: string): string {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=_\-\s]+)$/i.exec(dataUrl.trim());
  if (!match) {
    return dataUrl;
  }

  const mimeType = match[1] || fallbackMimeType;
  const rawBase64 = match[2]
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padding = rawBase64.length % 4 ? "=".repeat(4 - (rawBase64.length % 4)) : "";
  return `data:${mimeType};base64,${rawBase64}${padding}`;
}

export function buildSessionFilesContext(files: SessionFile[]): string {
  if (!files.length) {
    return "Session files:\n- No files are currently attached to this session.";
  }

  return [
    "Session files:",
    "- Use listFiles to inspect available file ids and metadata.",
    "- Use readFile with a file id when you need raw artifact source, text content, or to visually inspect an uploaded image.",
    "- If a file has an embedUrl, you may place that URL directly in generated artifact HTML, for example as <img src=\"...\">. Copy embedUrl exactly.",
    ...files.map((file) => `- [${file.id}] ${file.kind} ${file.name}`)
  ].join("\n");
}

export const listFilesToolDefinition: ResponsesToolDefinition = {
  type: "function",
  name: "listFiles",
  description:
    "List files available in the current ChatHTML session, including uploaded images and prior artifact source files. Use this before readFile when you need file ids or metadata.",
  strict: null,
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
};

export const readFileToolDefinition: ResponsesToolDefinition = {
  type: "function",
  name: "readFile",
  description:
    "Read one file from the current ChatHTML session by id. Artifact and text files return source text. Image files return metadata; the image bytes are attached as a follow-up multimodal input message when the model supports vision.",
  strict: null,
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "The exact file id from listFiles, for example file-artifact-assistant-123."
      }
    },
    required: ["id"],
    additionalProperties: false
  }
};

export function listFilesToolOutput(
  files: SessionFile[],
  stats?: SessionFileToolStats
): string {
  if (stats) {
    stats.lists += 1;
  }

  return JSON.stringify(
    {
      files: files.map(listFileEntry)
    },
    null,
    2
  );
}

export async function readFileToolResult(
  files: SessionFile[],
  input: unknown,
  stats?: SessionFileToolStats,
  options: ReadFileToolOptions = {}
): Promise<ReadFileToolResult> {
  if (stats) {
    stats.reads += 1;
  }

  const object =
    typeof input === "object" && input !== null
      ? (input as { id?: unknown })
      : {};
  const id = stringValue(object.id, 120);
  const file = files.find((candidate) => candidate.id === id);
  if (!file) {
    if (stats) {
      stats.errors += 1;
    }
    return {
      output: JSON.stringify({
        error: `No session file exists with id ${id || "(empty)"}.`,
        availableFileIds: files.map((candidate) => candidate.id)
      })
    };
  }

  const metadata = listFileEntry(file);
  if (file.kind === "image") {
    const allowImageInput = options.allowImageInput ?? true;
    const imageUrl = normalizeImageDataUrl(
      file.storageKey
        ? bufferToDataUrl(
            (await readStoredFile(file.storageKey, file.mimeType)).buffer,
            file.mimeType
          )
        : file.dataUrl
          ? file.dataUrl
          : "",
      file.mimeType
    );
    const output = JSON.stringify(
      {
        file: metadata,
        image: {
          providedAs: imageUrl && allowImageInput
            ? "follow_up_multimodal_message"
            : "metadata_only",
          note: imageUrl && allowImageInput
            ? "The image content is attached in a follow-up multimodal input message so providers do not receive image bytes inside a tool_result payload."
            : imageUrl
              ? "Image bytes are available but were not attached because the selected model is not known to support image input."
              : "Image bytes were unavailable; use embedUrl if present."
        }
      },
      null,
      2
    );

    return {
      output,
      followUpContent: imageUrl && allowImageInput
        ? [
            {
              type: "input_text",
              text: `Image content returned by readFile for session file ${file.id}. Treat this image as the bytes for that session file. Metadata:\n${JSON.stringify(
                { file: metadata },
                null,
                2
              )}`
            },
            {
              type: "input_image",
              image_url: imageUrl
            }
          ]
        : undefined
    };
  }

  const content =
    file.text ??
    (file.storageKey
      ? (await readStoredFile(file.storageKey, file.mimeType)).buffer.toString("utf8")
      : "");

  return {
    output: JSON.stringify(
      {
        file: metadata,
        content: clipText(content, MAX_TOOL_TEXT_CHARS)
      },
      null,
      2
    )
  };
}

export async function readFileToolOutput(
  files: SessionFile[],
  input: unknown,
  stats?: SessionFileToolStats
): Promise<ResponsesToolOutput> {
  return (await readFileToolResult(files, input, stats)).output;
}
