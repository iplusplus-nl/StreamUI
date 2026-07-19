import type { Request, Response } from "express";
import {
  applyArtifactSourceEdits,
  parseArtifactSourceEditModelText,
  recoverArtifactSourceEditsFromModelText,
  type ArtifactSourceEdit
} from "./artifactSourceEdits.js";
import {
  normalizeArtifactEditRequest,
  type ArtifactEditReference
} from "./artifactEditRequest.js";
import { ResponsesTerminalFailureError } from "./responsesEventReducer.js";
import type {
  ResponsesStreamApiSettings,
  ResponsesStreamState,
  StreamResponsesOnceOptions
} from "./responsesStreamClient.js";
import type { ApiStyle } from "./runtimeApiSettings.js";
import { COMFORTABLE_LEGIBILITY_PROMPT } from "../src/server/visualLegibilityPolicy.js";

const ARTIFACT_EDIT_MAX_OUTPUT_TOKENS = 32_000;

export type ArtifactEditRuntimeSettingsPort = {
  read(input: unknown): ResponsesStreamApiSettings & { apiStyle: ApiStyle };
};

export type ArtifactEditStreamOptions = Omit<
  StreamResponsesOnceOptions,
  "apiSettings"
> & {
  apiSettings: ResponsesStreamApiSettings & { apiStyle: ApiStyle };
};

export type ArtifactEditResponsesPort = {
  getEndpoint(baseUrl: string, apiStyle: ApiStyle): string;
  stream(options: ArtifactEditStreamOptions): Promise<unknown>;
};

export type ArtifactEditActivityPort = {
  isDraining(): boolean;
  getSnapshot(): unknown;
  begin(): () => void;
};

export type ArtifactEditLogger = Pick<Console, "info" | "warn" | "error">;

export type ArtifactEditServicePorts = {
  runtimeSettings: ArtifactEditRuntimeSettingsPort;
  responses: ArtifactEditResponsesPort;
  activity: ArtifactEditActivityPort;
  logger?: ArtifactEditLogger;
  createRequestId?(): string;
  now?(): number;
};

export type ArtifactEditModelResult = {
  summary: string;
  edits: ArtifactSourceEdit[];
  rawModelText: string;
  recovery: "none" | "raw_streamui";
};

function trimmedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function logTextPreview(value: string, maxLength = 600): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim().slice(0, maxLength));
}

export function buildArtifactEditInstructions(): string {
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
- Never add inline event-handler attributes such as onclick, onchange, oninput, or onsubmit; the renderer removes them. Bind artifact interactions from the final script with addEventListener.

${COMFORTABLE_LEGIBILITY_PROMPT}

- Do not include markdown or comments outside JSON. A full rewritten artifact is allowed only inside edits[].replace when target is "streamui".`;
}

export async function runArtifactEditModel(
  {
    apiSettings,
    source,
    prompt,
    references,
    signal
  }: {
    apiSettings: ResponsesStreamApiSettings & { apiStyle: ApiStyle };
    source: string;
    prompt: string;
    references: ArtifactEditReference[];
    signal: AbortSignal;
  },
  responses: ArtifactEditResponsesPort
): Promise<ArtifactEditModelResult> {
  const state: ResponsesStreamState = {
    contentChars: 0,
    contentEvents: 0,
    reasoningChars: 0,
    reasoningEvents: 0
  };
  let rawModelText = "";
  await responses.stream({
    endpoint: responses.getEndpoint(apiSettings.baseUrl, apiSettings.apiStyle),
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

  const parsed = parseArtifactSourceEditModelText(rawModelText);
  const recovered = recoverArtifactSourceEditsFromModelText(rawModelText, parsed);
  const summary =
    parsed && typeof parsed === "object"
      ? trimmedString((parsed as { summary?: unknown }).summary, 500)
      : "";

  return {
    summary,
    edits: recovered.edits,
    rawModelText,
    recovery: recovered.recovery
  };
}

export function createArtifactEditHandler(ports: ArtifactEditServicePorts) {
  const logger = ports.logger ?? console;
  const createRequestId =
    ports.createRequestId ?? (() => Math.random().toString(36).slice(2, 9));
  const now = ports.now ?? Date.now;

  return async function handleArtifactEdit(
    req: Request,
    res: Response
  ): Promise<void> {
    const requestId = createRequestId();
    const abortController = new AbortController();
    let completed = false;
    let connectionClosed = false;
    let releaseActivity: (() => void) | undefined;

    res.on("close", () => {
      connectionClosed = true;
      if (!completed) {
        abortController.abort();
      }
    });

    try {
      const request = normalizeArtifactEditRequest(req.body);
      if (!request.ok) {
        completed = true;
        res.status(request.status).json({ error: request.error });
        return;
      }
      if (ports.activity.isDraining()) {
        completed = true;
        res.status(503).json({
          error: "Server is draining for deployment. Try again shortly.",
          activity: ports.activity.getSnapshot()
        });
        return;
      }

      const apiSettings = ports.runtimeSettings.read(request.value.apiSettings);
      releaseActivity = ports.activity.begin();
      logger.info(
        `[artifact-edit:${requestId}] start provider=${apiSettings.providerName} base_url=${apiSettings.baseUrl} model=${apiSettings.model} source_chars=${request.value.source.length} references=${request.value.references.length}`
      );
      const startedAt = now();
      const result = await runArtifactEditModel(
        {
          apiSettings,
          source: request.value.source,
          prompt: request.value.prompt,
          references: request.value.references,
          signal: abortController.signal
        },
        ports.responses
      );
      if (result.recovery !== "none") {
        logger.warn(
          `[artifact-edit:${requestId}] recovered_${result.recovery} raw_model_chars=${result.rawModelText.length} raw_model_preview=${logTextPreview(result.rawModelText)}`
        );
      } else if (!result.edits.length) {
        logger.warn(
          `[artifact-edit:${requestId}] empty_edits raw_model_chars=${result.rawModelText.length} raw_model_preview=${logTextPreview(result.rawModelText)}`
        );
      }
      const applied = applyArtifactSourceEdits(request.value.source, result.edits);
      completed = true;
      logger.info(
        `[artifact-edit:${requestId}] complete duration_ms=${now() - startedAt} edits=${applied.applied.length}`
      );
      if (!connectionClosed) {
        res.json({
          rawStream: applied.rawStream,
          summary: result.summary,
          edits: applied.applied
        });
      }
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
      logger.error(stats.join(" "));
      if (!connectionClosed && !res.headersSent) {
        res.status(responsesFailure ? 502 : 500).json({ error: message });
      }
    } finally {
      releaseActivity?.();
    }
  };
}
