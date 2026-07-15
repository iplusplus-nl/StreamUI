import { useCallback, useRef, useState } from "react";
import type {
  ChatSession,
  SessionState
} from "../../domain/chat/sessionModel";
import type { PageThemeMode } from "../../runtime/streamui/types";
import {
  cancelChatRun,
  type CancelChatRunResult
} from "./chatApi";
import { settleAuthoritativeChatRun } from "./chatRunAuthoritativeSettlement";
import {
  createChatRunCancellationController,
  isExactChatRunTerminalMessage,
  type ChatRunCancellationControllerOptions,
  type ChatRunCancellationTarget
} from "./chatRunCancellationController";
import type { ChatRunExecutionController } from "./chatRunExecutionController";
import type { ChatRunReconnectScheduler } from "./chatRunReconnectScheduler";
import type { ChatRunRuntimeRegistry } from "./chatRunRuntimeRegistry";
import { loadChatRunServerMessage } from "./chatRunServerMessage";
import { getStreamingChatRunTargets } from "./chatRunTargetState";
import type { GenerationActivityCoordinator } from "./generationActivityCoordinator";
import type { SessionSaveOutcome } from "../sessions/sessionSaveCoordinator";

type CurrentRef<T> = { current: T };

export function collectChatRunCancellationTargets(
  activeSession: ChatSession | undefined,
  activeVisualRun: ChatRunCancellationTarget | undefined
): ChatRunCancellationTarget[] {
  const targetsByRunId = new Map<string, ChatRunCancellationTarget>();
  for (const target of [
    ...getStreamingChatRunTargets(activeSession),
    ...(activeVisualRun ? [activeVisualRun] : [])
  ]) {
    targetsByRunId.set(target.runId, target);
  }
  return Array.from(targetsByRunId.values());
}

export type UseChatRunCancellationOptions = {
  sessionStateRef: CurrentRef<SessionState>;
  activeSessionIdRef: CurrentRef<string>;
  sessionClientIdRef: CurrentRef<string>;
  cancelledRunIdsRef: CurrentRef<Set<string>>;
  runConnectionsRef: CurrentRef<Map<string, AbortController>>;
  themeMode: PageThemeMode;
  runtimeRegistry: ChatRunRuntimeRegistry<ChatRunExecutionController>;
  reconnectScheduler: Pick<ChatRunReconnectScheduler, "cancel">;
  generationActivity: Pick<GenerationActivityCoordinator, "finishChatRun">;
  updateState(
    updater: SessionState | ((current: SessionState) => SessionState)
  ): void;
  saveNow(): Promise<SessionSaveOutcome>;
  cancelActiveArtifactEdit(): boolean;
  cancelActiveVisualRepair(): boolean;
  getActiveVisualRepairRun(): ChatRunCancellationTarget | undefined;
  browserDirect?: boolean;
  warn?(message: string, error: unknown): void;
};

export function useChatRunCancellation({
  sessionStateRef,
  activeSessionIdRef,
  sessionClientIdRef,
  cancelledRunIdsRef,
  runConnectionsRef,
  themeMode,
  runtimeRegistry,
  reconnectScheduler,
  generationActivity,
  updateState,
  saveNow,
  cancelActiveArtifactEdit,
  cancelActiveVisualRepair,
  getActiveVisualRepairRun,
  browserDirect = false,
  warn = (message, error) => console.warn(message, error)
}: UseChatRunCancellationOptions): () => Promise<void> {
  const settle = useCallback<ChatRunCancellationControllerOptions["settle"]>(
    (target, result, message) =>
      settleAuthoritativeChatRun(target, result, message, {
        getRuntime: (identity) => runtimeRegistry.get(identity),
        updateState,
        getThemeMode: () => themeMode,
        cancelReconnect: (runId) => reconnectScheduler.cancel(runId),
        getConnection: (runId) => runConnectionsRef.current.get(runId),
        removeConnection: (runId, connection) => {
          if (runConnectionsRef.current.get(runId) === connection) {
            runConnectionsRef.current.delete(runId);
          }
        },
        finishActivity: (runId) => generationActivity.finishChatRun(runId),
        saveNow,
        warn
      }),
    [
      generationActivity,
      reconnectScheduler,
      runConnectionsRef,
      runtimeRegistry,
      saveNow,
      themeMode,
      updateState,
      warn
    ]
  );

  const reconcile = useCallback<
    ChatRunCancellationControllerOptions["reconcile"]
  >(
    async (target) => {
      const message = await loadChatRunServerMessage({
        clientId: sessionClientIdRef.current,
        sessionId: target.sessionId,
        assistantId: target.assistantId
      });
      for (const outcome of ["cancelled", "complete", "error"] as const) {
        if (!isExactChatRunTerminalMessage(target, outcome, message)) {
          continue;
        }
        const result: CancelChatRunResult = {
          runId: target.runId,
          outcome,
          transitioned: false
        };
        await settle(target, result, message);
        return;
      }
      await runtimeRegistry.getExecution(target)?.reconcileNow();
    },
    [runtimeRegistry, sessionClientIdRef, settle]
  );

  const portsRef = useRef<ChatRunCancellationControllerOptions | undefined>(
    undefined
  );
  portsRef.current = {
    waitUntilAccepted: (target) =>
      runtimeRegistry.get(target)?.waitUntilAccepted() ?? Promise.resolve(true),
    request: (target, signal) =>
      cancelChatRun(target.runId, sessionClientIdRef.current, fetch, signal),
    loadMessage: (target) =>
      loadChatRunServerMessage({
        clientId: sessionClientIdRef.current,
        sessionId: target.sessionId,
        assistantId: target.assistantId
      }),
    settle,
    reconcile,
    onError: (scope, error) => {
      warn(`Could not ${scope} ChatHTML run cancellation.`, error);
    }
  };
  const [controller] = useState(() =>
    createChatRunCancellationController({
      waitUntilAccepted: (target) =>
        portsRef.current!.waitUntilAccepted(target),
      request: (target, signal) => portsRef.current!.request(target, signal),
      loadMessage: (target) => portsRef.current!.loadMessage(target),
      settle: (target, result, message) =>
        portsRef.current!.settle(target, result, message),
      reconcile: (target) => portsRef.current!.reconcile(target),
      onError: (scope, error, target) =>
        portsRef.current!.onError?.(scope, error, target)
    })
  );

  return useCallback(async () => {
    const activeSession = sessionStateRef.current.sessions.find(
      (session) => session.id === activeSessionIdRef.current
    );
    const activeVisualRun = getActiveVisualRepairRun();
    const targets = collectChatRunCancellationTargets(
      activeSession,
      activeVisualRun
    );
    const cancelledLocalArtifactEdit = cancelActiveArtifactEdit();
    const cancelledVisualRepair = cancelActiveVisualRepair();
    if (!targets.length && !cancelledLocalArtifactEdit && !cancelledVisualRepair) {
      return;
    }

    if (browserDirect) {
      targets.forEach((target) => {
        runConnectionsRef.current.get(target.runId)?.abort();
      });
      return;
    }

    targets.forEach((target) => cancelledRunIdsRef.current.add(target.runId));
    try {
      await Promise.all(targets.map((target) => controller.cancel(target)));
    } finally {
      targets.forEach((target) =>
        cancelledRunIdsRef.current.delete(target.runId)
      );
    }
  }, [
    activeSessionIdRef,
    browserDirect,
    cancelActiveArtifactEdit,
    cancelActiveVisualRepair,
    cancelledRunIdsRef,
    controller,
    getActiveVisualRepairRun,
    runConnectionsRef,
    sessionStateRef
  ]);
}
