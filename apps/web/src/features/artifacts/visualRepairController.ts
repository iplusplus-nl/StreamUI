import type {
  ImageAttachment,
  UploadedSessionFile
} from "../../core/imageAttachments";
import type {
  ChatSession,
  ClientMessage,
  SessionState
} from "../../domain/chat/sessionModel";
import type {
  PageThemeMode,
  RenderSnapshot
} from "../../runtime/streamui/types";
import { getVisibleSessionMessages } from "../chat/branching";
import type {
  ChatGenerationLease,
  LocalGenerationLease
} from "../chat/generationActivityCoordinator";
import {
  getArtifactEditRawStream,
  getResolvedArtifactEditId,
  hasPendingArtifactEditVariant
} from "./artifactEditModel";
import type {
  StartGeneratedArtifactBatchInput,
  StartGeneratedArtifactBatchResult
} from "./generatedArtifactBatchController";
import { buildVisualRepairPrompt } from "./visualRepair";

export type VisualRepairTarget = {
  sessionId: string;
  assistantId: string;
};

export type StartVisualRepairInput = VisualRepairTarget & {
  snapshot: RenderSnapshot;
  width: number;
};

export type VisualRepairOutcome =
  | "finished"
  | "busy"
  | "invalid"
  | "missing"
  | "stale"
  | "authentication-required"
  | "failed"
  | "cancelled";

export type VisualRepairRequestContext = {
  model: string;
  requiresAuthentication: boolean;
};

export type VisualRepairControllerPorts = {
  getState(): SessionState;
  getThemeMode(): PageThemeMode;
  resolveRequestContext(session: ChatSession): VisualRepairRequestContext;
  isBusy(): boolean;
  tryAcquireLocal(ownerId: string): LocalGenerationLease | undefined;
  promoteLocalToChat(
    lease: LocalGenerationLease,
    runId: string
  ): ChatGenerationLease | undefined;
  startGeneratedBatch(
    input: StartGeneratedArtifactBatchInput
  ): StartGeneratedArtifactBatchResult;
  openAuthentication(): void;
  captureScreenshot(
    snapshot: RenderSnapshot,
    width: number,
    themeMode: PageThemeMode,
    assistantId: string
  ): Promise<ImageAttachment>;
  stageScreenshot(
    target: VisualRepairTarget,
    attachment: ImageAttachment
  ): Promise<UploadedSessionFile>;
  discardScreenshot(target: VisualRepairTarget, fileId: string): Promise<void>;
  getDiagnostics(
    snapshot: RenderSnapshot,
    width: number,
    themeMode: PageThemeMode
  ): string;
  supportsImageInput(model: string): boolean;
  createId(prefix: string): string;
  onRunningChange(running: boolean): void;
  warn(message: string, error?: unknown): void;
};

export type VisualRepairController = {
  start(input: StartVisualRepairInput): Promise<VisualRepairOutcome>;
  cancelActive(): boolean;
  isRunning(): boolean;
  getActiveRun(): (VisualRepairTarget & { runId: string }) | undefined;
  activate(): void;
  dispose(): void;
};

type VisualRepairRevision = {
  sourceUserMessageId: string;
  sourceUserContent: string;
  sourceUserFileIds: string;
  activeEditId?: string;
  source: string;
  snapshotRaw: string;
};

type VisualRepairTask = {
  target: VisualRepairTarget;
  revision: VisualRepairRevision;
  lifecycleGeneration: number;
  controller: AbortController;
  localLease: LocalGenerationLease;
  runId: string;
  requestModel: string;
  themeMode: PageThemeMode;
  phase: "preparing" | "running";
  stagedFileId?: string;
  cleanupPromise?: Promise<void>;
  runAccepted: boolean;
  requestOwnsScreenshot: boolean;
  chatLease?: ChatGenerationLease;
};

function findTarget(
  state: SessionState,
  target: VisualRepairTarget
): {
  session: ChatSession;
  assistant: ClientMessage;
  revision: VisualRepairRevision;
} | undefined {
  const session = state.sessions.find(
    (candidate) => candidate.id === target.sessionId
  );
  if (!session) {
    return undefined;
  }
  const visibleMessages = getVisibleSessionMessages(session);
  const assistantIndex = visibleMessages.findIndex(
    (message) =>
      message.id === target.assistantId && message.role === "assistant"
  );
  if (assistantIndex < 0) {
    return undefined;
  }
  let userIndex = -1;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (visibleMessages[index].role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) {
    return undefined;
  }

  const assistant = visibleMessages[assistantIndex];
  const activeEditId = getResolvedArtifactEditId(assistant);
  const source = getArtifactEditRawStream(assistant, activeEditId) ?? "";
  if (
    !source.trim() ||
    assistant.status === "streaming" ||
    assistant.artifactEdits?.some(hasPendingArtifactEditVariant)
  ) {
    return undefined;
  }

  return {
    session,
    assistant,
    revision: {
      sourceUserMessageId: visibleMessages[userIndex].id,
      sourceUserContent: visibleMessages[userIndex].content,
      sourceUserFileIds: JSON.stringify(
        visibleMessages[userIndex].fileIds ?? []
      ),
      activeEditId,
      source,
      snapshotRaw: assistant.snapshot?.raw ?? ""
    }
  };
}

function sameRevision(
  state: SessionState,
  task: VisualRepairTask
): ReturnType<typeof findTarget> {
  const current = findTarget(state, task.target);
  if (
    !current ||
    current.revision.sourceUserMessageId !== task.revision.sourceUserMessageId ||
    current.revision.sourceUserContent !== task.revision.sourceUserContent ||
    current.revision.sourceUserFileIds !== task.revision.sourceUserFileIds ||
    current.revision.activeEditId !== task.revision.activeEditId ||
    current.revision.source !== task.revision.source ||
    current.revision.snapshotRaw !== task.revision.snapshotRaw
  ) {
    return undefined;
  }
  return current;
}

export function createVisualRepairController(
  ports: VisualRepairControllerPorts
): VisualRepairController {
  let active: VisualRepairTask | null = null;
  let disposed = false;
  let lifecycleGeneration = 0;

  const isCurrent = (task: VisualRepairTask) =>
    !disposed &&
    active === task &&
    lifecycleGeneration === task.lifecycleGeneration &&
    !task.controller.signal.aborted;

  const discardStagedScreenshot = (task: VisualRepairTask): Promise<void> => {
    if (task.requestOwnsScreenshot) {
      return Promise.resolve();
    }
    if (task.cleanupPromise) {
      return task.cleanupPromise;
    }
    const fileId = task.stagedFileId;
    if (!fileId) {
      return Promise.resolve();
    }

    const cleanup = (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await ports.discardScreenshot(task.target, fileId);
          task.stagedFileId = undefined;
          return;
        } catch (error) {
          lastError = error;
        }
      }
      task.stagedFileId = undefined;
      ports.warn(
        "Could not delete the temporary visual repair screenshot.",
        lastError
      );
    })();
    task.cleanupPromise = cleanup.finally(() => {
      task.cleanupPromise = undefined;
    });
    return task.cleanupPromise;
  };

  const finish = (task: VisualRepairTask) => {
    if (active !== task) {
      return;
    }
    active = null;
    task.localLease.release();
    task.chatLease?.release();
    ports.onRunningChange(false);
  };

  const cancelPreparingTask = (task: VisualRepairTask) => {
    task.controller.abort();
    if (active === task) {
      active = null;
      task.localLease.release();
      ports.onRunningChange(false);
    }
    void discardStagedScreenshot(task);
  };

  return {
    async start(input) {
      if (disposed) {
        return "cancelled";
      }
      if (active || ports.isBusy()) {
        return "busy";
      }
      if (input.snapshot.status !== "complete") {
        return "invalid";
      }

      const target: VisualRepairTarget = {
        sessionId: input.sessionId,
        assistantId: input.assistantId
      };
      const initial = findTarget(ports.getState(), target);
      if (!initial) {
        return "missing";
      }
      if (
        initial.revision.snapshotRaw &&
        initial.revision.snapshotRaw !== input.snapshot.raw
      ) {
        return "stale";
      }
      const initialContext = ports.resolveRequestContext(initial.session);
      if (initialContext.requiresAuthentication) {
        ports.openAuthentication();
        return "authentication-required";
      }

      const ownerId = ports.createId("visual-repair");
      const localLease = ports.tryAcquireLocal(ownerId);
      if (!localLease) {
        return "busy";
      }
      let task: VisualRepairTask;
      try {
        task = {
          target,
          revision: initial.revision,
          lifecycleGeneration,
          controller: new AbortController(),
          localLease,
          runId: ports.createId("run"),
          requestModel: initialContext.model,
          themeMode: ports.getThemeMode(),
          phase: "preparing",
          runAccepted: false,
          requestOwnsScreenshot: false
        };
      } catch (error) {
        localLease.release();
        ports.warn("Could not initialize visual artifact repair.", error);
        return "failed";
      }
      active = task;

      try {
        ports.onRunningChange(true);
        const exportWidth = Math.max(
          320,
          Math.min(1100, Math.round(input.width || 900))
        );
        const themeMode = task.themeMode;
        const canUseScreenshot = ports.supportsImageInput(
          initialContext.model
        );
        let diagnostics: string | undefined;
        let attachment: ImageAttachment | undefined;

        if (canUseScreenshot) {
          const captured = await ports.captureScreenshot(
            input.snapshot,
            exportWidth,
            themeMode,
            input.assistantId
          );
          const captureTarget = isCurrent(task)
            ? sameRevision(ports.getState(), task)
            : undefined;
          if (!captureTarget) {
            finish(task);
            return task.controller.signal.aborted ? "cancelled" : "stale";
          }
          const captureContext = ports.resolveRequestContext(
            captureTarget.session
          );
          if (captureContext.requiresAuthentication) {
            finish(task);
            ports.openAuthentication();
            return "authentication-required";
          }
          if (
            captureContext.model !== task.requestModel ||
            ports.getThemeMode() !== task.themeMode
          ) {
            finish(task);
            return "stale";
          }

          const staged = await ports.stageScreenshot(target, captured);
          task.stagedFileId = staged.id;
          attachment = {
            ...captured,
            id: staged.id,
            name: staged.name,
            mimeType: staged.mimeType,
            size: staged.size,
            width: staged.width,
            height: staged.height,
            sessionFile: staged,
            ownerSessionId: target.sessionId
          };
          if (!isCurrent(task) || !sameRevision(ports.getState(), task)) {
            await discardStagedScreenshot(task);
            finish(task);
            return task.controller.signal.aborted ? "cancelled" : "stale";
          }
        } else {
          diagnostics = ports.getDiagnostics(
            input.snapshot,
            exportWidth,
            themeMode
          );
        }

        const live = sameRevision(ports.getState(), task);
        if (!isCurrent(task) || !live) {
          await discardStagedScreenshot(task);
          finish(task);
          return task.controller.signal.aborted ? "cancelled" : "stale";
        }
        const liveContext = ports.resolveRequestContext(live.session);
        if (liveContext.requiresAuthentication) {
          await discardStagedScreenshot(task);
          finish(task);
          ports.openAuthentication();
          return "authentication-required";
        }
        if (
          liveContext.model !== task.requestModel ||
          ports.getThemeMode() !== task.themeMode
        ) {
          await discardStagedScreenshot(task);
          finish(task);
          return "stale";
        }

        const chatLease = ports.promoteLocalToChat(localLease, task.runId);
        if (!chatLease) {
          await discardStagedScreenshot(task);
          finish(task);
          return "busy";
        }
        task.chatLease = chatLease;
        task.phase = "running";
        const activeAssistant = live.assistant;
        const result = ports.startGeneratedBatch({
          sessionId: target.sessionId,
          assistantId: target.assistantId,
          sourceUserMessageId: task.revision.sourceUserMessageId,
          prompt: buildVisualRepairPrompt({
            diagnostics,
            hasScreenshot: canUseScreenshot,
            width: exportWidth
          }),
          attachments: attachment ? [attachment] : [],
          assistantPatch: {
            repairOfMessageId:
              activeAssistant.repairOfMessageId || activeAssistant.id,
            repairAttempt: (activeAssistant.repairAttempt ?? 0) + 1
          },
          initialReasoning:
            "Captured the rendered artifact screenshot for visual repair.",
          historyMode: "through-target-assistant",
          runId: task.runId,
          chatActivityLease: chatLease,
          ephemeralAttachments: Boolean(attachment),
          onRunAccepted: () => {
            task.runAccepted = true;
            task.requestOwnsScreenshot = Boolean(task.stagedFileId);
          }
        });
        if (result.status !== "started") {
          await discardStagedScreenshot(task);
          finish(task);
          return result.status === "busy" ? "busy" : "failed";
        }

        const completion = await result.completion;
        await discardStagedScreenshot(task);
        finish(task);
        return completion.status === "fulfilled" && task.runAccepted
          ? "finished"
          : "failed";
      } catch (error) {
        const cancelled = !isCurrent(task) || task.controller.signal.aborted;
        await discardStagedScreenshot(task);
        if (!cancelled) {
          ports.warn("Could not run visual artifact repair.", error);
        }
        finish(task);
        return cancelled ? "cancelled" : "failed";
      }
    },

    cancelActive() {
      if (!active || active.phase === "running") {
        return false;
      }
      cancelPreparingTask(active);
      return true;
    },

    isRunning() {
      return !disposed && active !== null;
    },

    getActiveRun() {
      return !disposed && active?.phase === "running"
        ? { ...active.target, runId: active.runId }
        : undefined;
    },

    activate() {
      disposed = false;
      ports.onRunningChange(Boolean(active));
    },

    dispose() {
      disposed = true;
      lifecycleGeneration += 1;
      if (active?.phase === "preparing") {
        cancelPreparingTask(active);
      } else if (active) {
        ports.onRunningChange(false);
      }
    }
  };
}
