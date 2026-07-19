import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import type { Request, Response } from "express";
import {
  buildArtifactEditInstructions,
  createArtifactEditHandler,
  type ArtifactEditStreamOptions,
  type ArtifactEditLogger,
  type ArtifactEditServicePorts
} from "./artifactEditService.js";
import { ResponsesTerminalFailureError } from "./responsesEventReducer.js";
import type {
  ResponsesStreamApiSettings
} from "./responsesStreamClient.js";

const apiSettings: ResponsesStreamApiSettings & { apiStyle: "responses" } = {
  providerName: "Test Provider",
  baseUrl: "https://api.example.test/v1",
  apiKeySource: "manual",
  apiKeyEnvironmentName: "",
  apiKey: "secret",
  model: "test/model",
  reasoningEffort: "none",
  apiStyle: "responses"
};

function requestBody(): Record<string, unknown> {
  return {
    source: "<chat>Original</chat><streamui><div>Old</div></streamui>",
    prompt: "Change Old to New",
    references: [
      {
        kind: "element",
        key: "selection-1",
        selector: "div",
        label: "Old",
        preview: "Old"
      }
    ],
    apiSettings: { model: "test/model" }
  };
}

function request(body = requestBody()): Request {
  return { body } as Request;
}

function responseHarness() {
  const emitter = new EventEmitter();
  const statuses: number[] = [];
  const bodies: unknown[] = [];
  const response = Object.assign(emitter, {
    headersSent: false,
    status(code: number) {
      statuses.push(code);
      return response;
    },
    json(body: unknown) {
      bodies.push(body);
      response.headersSent = true;
      return response;
    }
  }) as unknown as Response;

  return { emitter, response, statuses, bodies };
}

function serviceHarness({
  draining = false,
  stream
}: {
  draining?: boolean;
  stream(options: ArtifactEditStreamOptions): Promise<unknown>;
}) {
  let active = 0;
  let begins = 0;
  let releases = 0;
  let runtimeReads = 0;
  const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  const logger: ArtifactEditLogger = {
    info: (message) => logs.info.push(String(message)),
    warn: (message) => logs.warn.push(String(message)),
    error: (message) => logs.error.push(String(message))
  };
  const ports: ArtifactEditServicePorts = {
    runtimeSettings: {
      read: () => {
        runtimeReads += 1;
        return apiSettings;
      }
    },
    responses: {
      getEndpoint: (baseUrl, apiStyle) =>
        apiStyle === "chat-completions"
          ? `${baseUrl}/chat/completions`
          : `${baseUrl}/responses`,
      stream
    },
    activity: {
      isDraining: () => draining,
      getSnapshot: () => ({ draining, activeArtifactEdits: active }),
      begin: () => {
        begins += 1;
        active += 1;
        let released = false;
        return () => {
          if (released) {
            throw new Error("activity released twice");
          }
          released = true;
          releases += 1;
          active -= 1;
        };
      }
    },
    logger,
    createRequestId: () => "request-1",
    now: () => 100
  };

  return {
    handler: createArtifactEditHandler(ports),
    activity: () => ({ active, begins, releases }),
    runtimeReads: () => runtimeReads,
    logs
  };
}

describe("artifact edit service", () => {
  it("keeps direct artifact edits within the shared comfortable-legibility contract", () => {
    const instructions = buildArtifactEditInstructions();

    assert.match(instructions, /4\.5:1 for normal text/i);
    assert.match(instructions, /3:1 for large text/i);
    assert.match(instructions, /actual immediate rendered background/i);
    assert.match(instructions, /Preserve the requested hues[\s\S]*art direction/i);
    assert.match(instructions, /not a request for maximum contrast/i);
    assert.match(instructions, /only when they are genuinely nonessential/i);
    assert.match(instructions, /Never add inline event-handler attributes/i);
    assert.match(instructions, /addEventListener/i);
  });

  it("rejects a valid request while draining without reading settings or counting activity", async () => {
    const service = serviceHarness({
      draining: true,
      stream: async () => {
        throw new Error("stream must not run");
      }
    });
    const response = responseHarness();

    await service.handler(request(), response.response);

    assert.deepEqual(response.statuses, [503]);
    assert.deepEqual(response.bodies, [
      {
        error: "Server is draining for deployment. Try again shortly.",
        activity: { draining: true, activeArtifactEdits: 0 }
      }
    ]);
    assert.equal(service.runtimeReads(), 0);
    assert.deepEqual(service.activity(), { active: 0, begins: 0, releases: 0 });
  });

  it("runs the Responses client, applies edits, and releases activity", async () => {
    let received: ArtifactEditStreamOptions | undefined;
    const service = serviceHarness({
      stream: async (options) => {
        received = options;
        options.emit({
          type: "content",
          text: '{"summary":"Updated hero","edits":[{"find":"Old","replace":"New"}]}'
        });
        return [];
      }
    });
    const response = responseHarness();

    await service.handler(request(), response.response);

    assert.equal(received?.endpoint, "https://api.example.test/v1/responses");
    assert.equal(received?.maxOutputTokens, 32_000);
    assert.equal(received?.useOpenRouterReasoning, false);
    const firstInput = received?.input[0];
    const firstContent =
      firstInput?.type === "message" && firstInput.role === "user"
        ? firstInput.content[0]
        : undefined;
    const promptText =
      firstContent?.type === "input_text" ? firstContent.text : "";
    assert.match(promptText, /SELECTED_REFERENCES_JSON:[\s\S]*ORIGINAL_SOURCE:/);
    assert.equal(response.statuses.length, 0);
    assert.equal(response.bodies.length, 1);
    const body = response.bodies[0] as {
      rawStream: string;
      summary: string;
      edits: Array<{ findLength: number; replaceLength: number }>;
    };
    assert.equal(
      body.rawStream,
      "<chat>Original</chat><streamui><div>New</div></streamui>"
    );
    assert.equal(body.summary, "Updated hero");
    assert.deepEqual(body.edits.map(({ findLength, replaceLength }) => ({
      findLength,
      replaceLength
    })), [{ findLength: 3, replaceLength: 3 }]);
    assert.deepEqual(service.activity(), { active: 0, begins: 1, releases: 1 });
  });

  it("maps Responses terminal failures to 502 and releases activity", async () => {
    const service = serviceHarness({
      stream: async () => {
        throw new ResponsesTerminalFailureError({
          message: "Provider stopped before completing the edit.",
          status: "incomplete",
          incompleteReason: "max_output_tokens"
        });
      }
    });
    const response = responseHarness();

    await service.handler(request(), response.response);

    assert.deepEqual(response.statuses, [502]);
    assert.deepEqual(response.bodies, [
      { error: "Provider stopped before completing the edit." }
    ]);
    assert.deepEqual(service.activity(), { active: 0, begins: 1, releases: 1 });
    assert.match(service.logs.error[0], /responses_status=incomplete/);
    assert.match(service.logs.error[0], /incomplete_reason=max_output_tokens/);
  });

  it("aborts an in-flight Responses request on close and releases activity without writing", async () => {
    let receivedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const service = serviceHarness({
      stream: (options) => {
        receivedSignal = options.signal;
        markStarted?.();
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => {
              const error = new Error("Generation stopped.");
              error.name = "AbortError";
              reject(error);
            },
            { once: true }
          );
        });
      }
    });
    const response = responseHarness();

    const handling = service.handler(request(), response.response);
    await started;
    response.emitter.emit("close");
    await handling;

    assert.equal(receivedSignal?.aborted, true);
    assert.deepEqual(response.statuses, []);
    assert.deepEqual(response.bodies, []);
    assert.deepEqual(service.activity(), { active: 0, begins: 1, releases: 1 });
  });
});
