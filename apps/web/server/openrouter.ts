import type { Request, Response } from "express";
import { getAuthenticatedStateKey } from "./chatHtmlService.js";
import {
  canPersistGeneratedArtifactBatch,
  finalizeGeneratedArtifactBatchPatch,
  getGeneratedArtifactBatchIdentity
} from "./generatedArtifactBatchPersistence.js";
import {
  CHAT_RUN_CANCELLED_MESSAGE,
  createChatRunTerminalTransition,
  finalizeChatRunTerminal,
  type ChatRunTerminalOutcome
} from "./chatRunFinalization.js";
import {
  createChatRunTerminalCoordinator,
  type ChatRunTerminalCoordinator,
  type ChatRunTerminalResult
} from "./chatRunTerminalCoordinator.js";
import { createChatRunCancellationHandler } from "./chatRunCancellationRoute.js";
import {
  createChatRunCancellationIntentRegistry,
  executeAcceptedChatRun
} from "./chatRunCancellationIntent.js";
import {
  ActiveEphemeralFileDeletionError,
  activeEphemeralFileRegistry,
  cleanupReleasedEphemeralFiles,
  type ActiveEphemeralFileLease
} from "./activeEphemeralFileRegistry.js";
import { createArtifactEditHandler } from "./artifactEditService.js";
import {
  selectDurableSessionFiles,
  selectEphemeralSessionFileIdentities
} from "./sessionFileUploadSafety.js";
import {
  deleteEphemeralSessionFiles,
  updateSessionMessageAtomically,
  upsertSessionMessages,
  type SessionMessageInput,
  type StoredSessionFile
} from "./sessions.js";
import {
  ResponsesTerminalFailureError
} from "./responsesEventReducer.js";
import {
  getResponsesEndpoint,
  streamResponsesOnce
} from "./responsesStreamClient.js";
import {
  getChatCompletionsEndpoint,
  streamChatCompletionsOnce
} from "./chatCompletionsStreamClient.js";
import {
  buildChatRunMessagePatch,
  canPersistChatRunMessage,
  createChatRunInput,
  readRuntimeApiSettings,
  stringValue,
  type ChatRequestBody,
  type ChatRunInput
} from "./chatRunRequestModel.js";
import {
  runOpenRouterChatExecution,
  type ChatStreamEvent
} from "./openrouterChatExecution.js";

export {
  applyArtifactSourceEdits,
  recoverArtifactSourceEditsFromModelText
} from "./artifactSourceEdits.js";
export type { ArtifactSourceEdit } from "./artifactSourceEdits.js";
export {
  extractResponsesOutputText,
  extractResponsesReasoningDelta,
  extractResponsesReasoningDoneText
} from "./responsesEventReducer.js";
export {
  describeApiCredentialMismatch,
  formatResponsesHttpError,
  summarizeHttpErrorBody
} from "./responsesStreamClient.js";
export type { ResponsesHttpErrorContext } from "./responsesStreamClient.js";
export {
  buildChatRunMessagePatch,
  canPersistChatRunMessage,
  normalizeSessionMessageInput
} from "./chatRunRequestModel.js";

type StreamEvent = ChatStreamEvent;

type ChatDoneEvent = {
  type: "done";
  status: ChatRunTerminalOutcome;
  error?: string;
};

type SequencedStreamEvent = (StreamEvent | ChatDoneEvent) & {
  runId: string;
  seq: number;
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

type ChatRun = {
  id: string;
  input: ChatRunInput;
  abortController: AbortController;
  terminalCoordinator: ChatRunTerminalCoordinator;
  events: SequencedStreamEvent[];
  subscribers: Set<(event: SequencedStreamEvent) => void>;
  sequence: number;
  raw: string;
  reasoning: string;
  status: "running" | "complete" | "error";
  error?: string;
  persistTimer?: NodeJS.Timeout;
  persistPromise: Promise<void>;
  executionSettled: Promise<void>;
  settleExecution(): void;
  ephemeralFileLease: ActiveEphemeralFileLease;
  cleanupTimer?: NodeJS.Timeout;
};

const chatRuns = new Map<string, ChatRun>();
const chatRunCancellationIntents =
  createChatRunCancellationIntentRegistry();
const CHAT_RUN_TTL_MS = 10 * 60 * 1000;
const STREAM_PERSIST_INTERVAL_MS = 500;
let activeChatFinalizations = 0;
let activeArtifactEdits = 0;
let openRouterIdleSinceMs = Date.now();
let openRouterDraining = false;

function chatRunKey(stateKey: string, runId: string): string {
  return JSON.stringify([stateKey, runId]);
}

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

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message === CHAT_RUN_CANCELLED_MESSAGE)
  );
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
  error?: string,
  generationOutcome?: ChatRunTerminalOutcome
): Promise<void> {
  const sessionId = run.input.sessionId;
  const assistantMessageId = run.input.assistantMessage?.id;
  if (!sessionId || !assistantMessageId) {
    return Promise.resolve();
  }

  const streamPatch = buildChatRunMessagePatch(
    run.raw,
    run.reasoning,
    status,
    run.sequence,
    run.id,
    error,
    generationOutcome
  );
  const artifactBatchIdentity = getGeneratedArtifactBatchIdentity(
    run.input.assistantMessage
  );
  const operation = run.persistPromise.then(async () => {
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

    await updateSessionMessageAtomically({
      stateKey: run.input.stateKey,
      sessionId,
      messageId: assistantMessageId,
      update: (currentMessage) =>
        canPersistChatRunMessage(currentMessage, run.id)
          ? streamPatch
          : undefined
    });
  });
  run.persistPromise = operation.catch((persistError) => {
    console.warn(
      `[chat:${run.input.requestId}] could not persist stream state`,
      persistError
    );
  });

  return operation;
}

function scheduleRunPersistence(run: ChatRun): void {
  if (run.status !== "running" || run.persistTimer) {
    return;
  }

  run.persistTimer = setTimeout(() => {
    run.persistTimer = undefined;
    void queueRunPersistence(run, "streaming").catch(() => undefined);
  }, STREAM_PERSIST_INTERVAL_MS);
}

async function flushRunPersistence(
  run: ChatRun,
  status: "streaming" | "complete" | "error",
  error?: string,
  generationOutcome?: ChatRunTerminalOutcome
): Promise<void> {
  if (run.persistTimer) {
    clearTimeout(run.persistTimer);
    run.persistTimer = undefined;
  }

  await queueRunPersistence(run, status, error, generationOutcome);
}

function scheduleRunCleanup(run: ChatRun): void {
  if (run.cleanupTimer) {
    clearTimeout(run.cleanupTimer);
  }

  run.cleanupTimer = setTimeout(() => {
    if (!run.subscribers.size) {
      chatRuns.delete(chatRunKey(run.input.stateKey, run.id));
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
  const {
    sessionId,
    userMessage,
    assistantMessage,
    files,
    ephemeralFileIds
  } = run.input;
  if (!sessionId || !assistantMessage) {
    return;
  }

  await upsertSessionMessages({
    stateKey: run.input.stateKey,
    sessionId,
    messages: [userMessage, assistantMessage].filter(
      (message): message is SessionMessageInput => Boolean(message)
    ),
    files: selectDurableSessionFiles(
      files as StoredSessionFile[],
      ephemeralFileIds
    )
  });
}

async function cleanupRunEphemeralFiles(
  run: ChatRun,
  inactiveStorageKeys: readonly string[]
): Promise<void> {
  const sessionId = run.input.sessionId;
  if (!sessionId) {
    return;
  }

  const inactiveStorageKeySet = new Set(inactiveStorageKeys);
  const expectedFiles = selectEphemeralSessionFileIdentities(
    run.input.files,
    run.input.ephemeralFileIds
  ).filter((file) => inactiveStorageKeySet.has(file.storageKey));
  if (!expectedFiles.length) {
    return;
  }

  await deleteEphemeralSessionFiles({
    stateKey: run.input.stateKey,
    sessionId,
    expectedFiles
  });
}

function finishChatRun(
  run: ChatRun,
  outcome: ChatRunTerminalOutcome,
  error?: string
): ChatRunTerminalResult {
  const result = run.terminalCoordinator.transition(outcome, error);
  if (!result.transitioned) {
    return result;
  }

  activeChatFinalizations += 1;
  void finalizeChatRunTerminal({
    outcome: result.outcome,
    persistTerminalState: () => result.persistence,
    waitForExecution: () => run.executionSettled,
    cleanupEphemeralFiles: () =>
      cleanupReleasedEphemeralFiles(
        run.ephemeralFileLease,
        (inactiveStorageKeys) =>
          cleanupRunEphemeralFiles(run, inactiveStorageKeys)
      )
  })
    .catch((finalizationError) => {
      console.warn(
        `[chat:${run.input.requestId}] could not finalize run resources`,
        finalizationError
      );
    })
    .finally(() => {
      run.ephemeralFileLease.release();
      activeChatFinalizations = Math.max(0, activeChatFinalizations - 1);
      scheduleRunCleanup(run);
      refreshOpenRouterIdleState();
    });
  return result;
}

function cancelChatRun(run: ChatRun): ChatRunTerminalResult {
  const result = finishChatRun(run, "cancelled");
  if (result.transitioned) {
    run.abortController.abort();
  }
  return result;
}

async function executeChatRun(
  run: ChatRun,
  preCancelled: boolean
): Promise<void> {
  try {
    await executeAcceptedChatRun({
      preCancelled,
      persistInitial: () => persistInitialRunMessages(run),
      persistCancelled: async () => {
        await cancelChatRun(run).persistence;
      },
      executeProvider: async () => {
        await runOpenRouterChatExecution({
          input: run.input,
          signal: run.abortController.signal,
          emit: (event) => emitRunStreamEvent(run, event)
        });
        finishChatRun(run, "complete");
      }
    });
  } catch (error) {
    if (run.status !== "running") {
      return;
    }
    if (isAbortError(error)) {
      finishChatRun(run, "cancelled");
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
  } finally {
    run.settleExecution();
  }
}

function startChatRun(input: ChatRunInput): ChatRun {
  let settleExecution: () => void = () => {};
  const executionSettled = new Promise<void>((resolve) => {
    settleExecution = resolve;
  });
  const ephemeralFiles = selectEphemeralSessionFileIdentities(
    input.files,
    input.ephemeralFileIds
  );
  let run: ChatRun;
  const terminalCoordinator = createChatRunTerminalCoordinator({
    onTransition: (claim) => {
      const transition = createChatRunTerminalTransition(
        claim.outcome,
        claim.error
      );
      run.status = transition.persistence.status;
      run.error = transition.persistence.error;
      appendRunEvent(run, transition.streamEvent);
    },
    persist: (claim) => {
      const transition = createChatRunTerminalTransition(
        claim.outcome,
        claim.error
      );
      return flushRunPersistence(
        run,
        transition.persistence.status,
        transition.persistence.error,
        transition.outcome
      );
    }
  });
  run = {
    id: input.runId,
    input,
    abortController: new AbortController(),
    terminalCoordinator,
    events: [],
    subscribers: new Set(),
    sequence: 0,
    raw: input.assistantMessage?.rawStream ?? "",
    reasoning: input.assistantMessage?.reasoning ?? "",
    status: "running",
    persistPromise: Promise.resolve(),
    executionSettled,
    settleExecution,
    ephemeralFileLease: activeEphemeralFileRegistry.register({
      stateKey: input.stateKey,
      sessionId: input.sessionId ?? "",
      storageKeys: ephemeralFiles.map((file) => file.storageKey)
    })
  };

  const storageKey = chatRunKey(run.input.stateKey, run.id);
  chatRuns.set(storageKey, run);
  const preCancelled = chatRunCancellationIntents.consume(storageKey);
  void executeChatRun(run, preCancelled);
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

function beginArtifactEditActivity(): () => void {
  activeArtifactEdits += 1;
  let released = false;

  return () => {
    if (released) {
      return;
    }
    released = true;
    activeArtifactEdits = Math.max(0, activeArtifactEdits - 1);
    refreshOpenRouterIdleState();
  };
}

const artifactEditHandler = createArtifactEditHandler({
  runtimeSettings: {
    read: readRuntimeApiSettings
  },
  responses: {
    getEndpoint: (baseUrl, apiStyle) =>
      apiStyle === "chat-completions"
        ? getChatCompletionsEndpoint(baseUrl)
        : getResponsesEndpoint(baseUrl),
    stream: (options) =>
      options.apiSettings.apiStyle === "chat-completions"
        ? streamChatCompletionsOnce(options)
        : streamResponsesOnce(options)
  },
  activity: {
    isDraining: () => openRouterDraining,
    getSnapshot: getOpenRouterActivitySnapshot,
    begin: beginArtifactEditActivity
  }
});

export async function handleArtifactEdit(
  req: Request,
  res: Response
): Promise<void> {
  await artifactEditHandler(req, res);
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
  const stateKey = getAuthenticatedStateKey(req);

  try {
    const requestedRunId = stringValue(body.runId, 160);
    if (requestedRunId) {
      const existingRun = chatRuns.get(chatRunKey(stateKey, requestedRunId));
      if (existingRun) {
        attachChatRun(res, existingRun, getAfterSequence(req.query.after));
        return;
      }
    }

    const input = createChatRunInput(body, requestId, Date.now(), stateKey);
    const existingRun = chatRuns.get(chatRunKey(stateKey, input.runId));
    if (!existingRun && openRouterDraining) {
      res.status(503).json({
        error: "Server is draining for deployment. Try again shortly.",
        activity: getOpenRouterActivitySnapshot()
      });
      return;
    }
    const run = existingRun ?? startChatRun(input);
    attachChatRun(res, run, getAfterSequence(req.query.after));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown chat proxy error.";
    console.error(`[chat:${requestId}] error ${message}`);
    if (!res.headersSent) {
      res
        .status(error instanceof ActiveEphemeralFileDeletionError ? 409 : 500)
        .type("text/plain")
        .send(message);
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
  const run = chatRuns.get(chatRunKey(getAuthenticatedStateKey(req), runId));
  if (!run) {
    res.status(404).json({ error: "Chat run not found." });
    return;
  }

  attachChatRun(res, run, getAfterSequence(req.query.after));
}

export const handleCancelChatRun = createChatRunCancellationHandler({
  findRun: (runId, req) => {
    const run = chatRuns.get(
      chatRunKey(getAuthenticatedStateKey(req), runId)
    );
    return run
      ? {
          runId: run.id,
          requestId: run.input.requestId,
          cancel: () => cancelChatRun(run)
        }
      : undefined;
  },
  registerUnknownRunCancellation: (runId, req) =>
    chatRunCancellationIntents.register(
      chatRunKey(getAuthenticatedStateKey(req), runId)
    )
});
