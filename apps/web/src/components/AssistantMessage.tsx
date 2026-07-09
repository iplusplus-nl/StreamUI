import { MessagePrimitive } from "@assistant-ui/react";
import {
  ChevronLeft,
  ChevronRight,
  MousePointer2,
  RotateCcw,
  Wand2
} from "lucide-react";
import { useMemo } from "react";
import type {
  ArtifactSelection,
  ArtifactSelectionPayload
} from "../core/artifactSelection";
import { stripInternalArtifactContextText } from "../features/chat/internalArtifactContext";
import { extractStreamUiParts } from "../runtime/streamui/protocol";
import { createStreamingRenderer } from "../runtime/streamui/streamingRenderer";
import type {
  PageThemeMode,
  RenderError,
  RenderSnapshot,
  StreamUiAction
} from "../runtime/streamui/types";
import { AssistantPreviewBubble } from "./AssistantPreviewBubble";
import { AssistantTextBubble } from "./AssistantTextBubble";
import { RawStreamPanel } from "./RawStreamPanel";
import { ReasoningPanel } from "./ReasoningPanel";

type AssistantMessageProps = {
  id: string;
  content: string;
  reasoning?: string;
  rawStream?: string;
  hasStreamUi?: boolean;
  snapshot?: RenderSnapshot;
  runtimeErrors?: RenderError[];
  themeMode: PageThemeMode;
  showRawStream: boolean;
  status?: "streaming" | "complete" | "error";
  error?: string;
  artifactSelections?: ArtifactSelection[];
  artifactBusySelections?: Array<
    Pick<ArtifactSelectionPayload, "key" | "kind" | "selector">
  >;
  isArtifactSelectionModeActive?: boolean;
  branchInfo?: {
    groupId: string;
    activeIndex: number;
    total: number;
    previousVariantId?: string;
    nextVariantId?: string;
  };
  artifactVersionInfo?: {
    activeIndex: number;
    total: number;
    previousEditId?: string | null;
    nextEditId?: string | null;
    disabled?: boolean;
  };
  activeReasoningMessageId?: string;
  onRuntimeError(id: string, error: RenderError): void;
  onArtifactAction(id: string, action: StreamUiAction): void;
  onArtifactSelection(id: string, selection: ArtifactSelectionPayload): void;
  onArtifactSelectionModeChange(id: string, enabled: boolean): void;
  onOpenReasoningActivity(id: string): void;
  onVisualRepair(id: string, snapshot: RenderSnapshot, width: number): void;
  onRegenerate(id: string): void;
  onSelectBranch(groupId: string, variantId: string): void;
  onSelectArtifactEdit(id: string, editId?: string): void;
};

function hasLikelyVisibleStreamUiContent(rawStream?: string): boolean {
  if (!rawStream) {
    return false;
  }

  const parts = extractStreamUiParts(rawStream);
  if (!parts.hasStreamUi) {
    return false;
  }

  return Boolean(
    parts.streamui
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<style\b[\s\S]*$/gi, "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<script\b[\s\S]*$/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .trim()
  );
}

export function AssistantMessage({
  id,
  content,
  reasoning,
  rawStream,
  hasStreamUi,
  snapshot,
  runtimeErrors,
  themeMode,
  showRawStream,
  status,
  error,
  artifactSelections = [],
  artifactBusySelections = [],
  isArtifactSelectionModeActive = false,
  branchInfo,
  artifactVersionInfo,
  activeReasoningMessageId,
  onRuntimeError,
  onArtifactAction,
  onArtifactSelection,
  onArtifactSelectionModeChange,
  onOpenReasoningActivity,
  onVisualRepair,
  onRegenerate,
  onSelectBranch,
  onSelectArtifactEdit
}: AssistantMessageProps) {
  const resolvedSnapshot = useMemo(() => {
    const withRuntimeErrors = (
      candidate: RenderSnapshot | undefined
    ): RenderSnapshot | undefined => {
      if (!candidate || !runtimeErrors?.length) {
        return candidate;
      }

      const existing = new Set(
        candidate.errors.map((item) => `${item.kind}:${item.message}`)
      );
      const mergedErrors = [...candidate.errors];

      for (const error of runtimeErrors) {
        const key = `${error.kind}:${error.message}`;
        if (!existing.has(key)) {
          existing.add(key);
          mergedErrors.push(error);
        }
      }

      return {
        ...candidate,
        errors: mergedErrors
      };
    };

    if (!hasStreamUi || !rawStream) {
      return withRuntimeErrors(snapshot);
    }

    const parts = extractStreamUiParts(rawStream);
    if (!parts.hasStreamUi || !parts.streamui.trim()) {
      return snapshot;
    }

    const renderer = createStreamingRenderer(themeMode);
    renderer.replace(parts.streamui);
    if (status === "complete" || parts.streamUiComplete) {
      renderer.complete();
    }
    return withRuntimeErrors(renderer.getSnapshot());
  }, [hasStreamUi, rawStream, runtimeErrors, snapshot, status, themeMode]);
  const visibleContent = stripInternalArtifactContextText(content);
  const hasVisibleArtifact = Boolean(
    hasStreamUi &&
      resolvedSnapshot &&
      (!rawStream || hasLikelyVisibleStreamUiContent(rawStream))
  );
  const placeholder =
    status !== "streaming" &&
    !visibleContent &&
    !error &&
    !hasVisibleArtifact
      ? "No visible response was generated."
      : undefined;
  const hasDisplayError = Boolean(
    error || runtimeErrors?.length || resolvedSnapshot?.errors.length
  );
  const selectionDisabled =
    status === "streaming" || resolvedSnapshot?.status !== "complete";
  const repairDisabled =
    status === "streaming" || resolvedSnapshot?.status !== "complete";
  const turnActions = (
    <div className="assistant-turn-actions" aria-label="Response actions">
      {hasVisibleArtifact ? (
        <button
          className={`message-action-button artifact-select-action ${
            isArtifactSelectionModeActive ? "is-active" : ""
          }`}
          type="button"
          title={
            isArtifactSelectionModeActive
              ? "Stop selecting preview regions"
              : "Edit preview region"
          }
          aria-label={
            isArtifactSelectionModeActive
              ? "Stop selecting preview regions"
              : "Edit preview region"
          }
          aria-pressed={isArtifactSelectionModeActive}
          disabled={selectionDisabled}
          onClick={() =>
            onArtifactSelectionModeChange(id, !isArtifactSelectionModeActive)
          }
        >
          <MousePointer2 size={15} strokeWidth={2.15} aria-hidden="true" />
          <span>{isArtifactSelectionModeActive ? "Selecting" : "Edit"}</span>
        </button>
      ) : null}
      <button
        className={`message-action-button regenerate-action ${
          hasDisplayError ? "is-error" : ""
        }`}
        type="button"
        title="Regenerate response"
        aria-label="Regenerate response"
        disabled={status === "streaming"}
        onClick={() => onRegenerate(id)}
      >
        <RotateCcw size={15} strokeWidth={2.15} aria-hidden="true" />
      </button>
      {hasVisibleArtifact && resolvedSnapshot ? (
        <button
          className="message-action-button visual-repair-action"
          type="button"
          title="Repair from screenshot"
          aria-label="Repair from screenshot"
          disabled={repairDisabled}
          onClick={() => onVisualRepair(id, resolvedSnapshot, 900)}
        >
          <Wand2 size={15} strokeWidth={2.15} aria-hidden="true" />
        </button>
      ) : null}
      {artifactVersionInfo ? (
        <div className="message-branch-controls" aria-label="Artifact versions">
          <button
            className="message-action-button"
            type="button"
            title="Previous artifact version"
            aria-label="Previous artifact version"
            disabled={
              artifactVersionInfo.previousEditId === undefined ||
              artifactVersionInfo.disabled ||
              status === "streaming"
            }
            onClick={() => {
              if (artifactVersionInfo.previousEditId !== undefined) {
                onSelectArtifactEdit(
                  id,
                  artifactVersionInfo.previousEditId ?? undefined
                );
              }
            }}
          >
            <ChevronLeft size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <span className="branch-count">
            {artifactVersionInfo.activeIndex + 1}/{artifactVersionInfo.total}
          </span>
          <button
            className="message-action-button"
            type="button"
            title="Next artifact version"
            aria-label="Next artifact version"
            disabled={
              artifactVersionInfo.nextEditId === undefined ||
              artifactVersionInfo.disabled ||
              status === "streaming"
            }
            onClick={() => {
              if (artifactVersionInfo.nextEditId !== undefined) {
                onSelectArtifactEdit(
                  id,
                  artifactVersionInfo.nextEditId ?? undefined
                );
              }
            }}
          >
            <ChevronRight size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      ) : branchInfo ? (
        <div className="message-branch-controls" aria-label="Response branches">
          <button
            className="message-action-button"
            type="button"
            title="Previous response"
            aria-label="Previous response"
            disabled={!branchInfo.previousVariantId || status === "streaming"}
            onClick={() => {
              if (branchInfo.previousVariantId) {
                onSelectBranch(branchInfo.groupId, branchInfo.previousVariantId);
              }
            }}
          >
            <ChevronLeft size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <span className="branch-count">
            {branchInfo.activeIndex + 1}/{branchInfo.total}
          </span>
          <button
            className="message-action-button"
            type="button"
            title="Next response"
            aria-label="Next response"
            disabled={!branchInfo.nextVariantId || status === "streaming"}
            onClick={() => {
              if (branchInfo.nextVariantId) {
                onSelectBranch(branchInfo.groupId, branchInfo.nextVariantId);
              }
            }}
          >
            <ChevronRight size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  );

  return (
    <MessagePrimitive.Root className="chat-row assistant">
      <div className="avatar" aria-hidden="true">
        S
      </div>
      <div className="assistant-stack">
        <ReasoningPanel
          messageId={id}
          reasoning={reasoning}
          isStreaming={status === "streaming"}
          isActive={activeReasoningMessageId === id}
          onOpenActivity={onOpenReasoningActivity}
        />
        <AssistantTextBubble
          content={content}
          error={error}
          placeholder={placeholder}
        />
        {hasStreamUi && resolvedSnapshot ? (
          <AssistantPreviewBubble
            id={id}
            snapshot={resolvedSnapshot}
            themeMode={themeMode}
            actions={turnActions}
            selectionModeActive={isArtifactSelectionModeActive}
            selectionDisabled={selectionDisabled}
            selections={artifactSelections}
            busySelections={artifactBusySelections}
            onRuntimeError={onRuntimeError}
            onArtifactAction={onArtifactAction}
            onArtifactSelection={onArtifactSelection}
            onSelectionModeChange={onArtifactSelectionModeChange}
          />
        ) : (
          turnActions
        )}
        {showRawStream ? <RawStreamPanel raw={rawStream} /> : null}
      </div>
    </MessagePrimitive.Root>
  );
}
