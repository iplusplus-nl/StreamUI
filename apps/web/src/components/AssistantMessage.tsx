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
  isArtifactSelectionModeActive?: boolean;
  branchInfo?: {
    groupId: string;
    activeIndex: number;
    total: number;
    previousVariantId?: string;
    nextVariantId?: string;
  };
  onRuntimeError(id: string, error: RenderError): void;
  onArtifactAction(id: string, action: StreamUiAction): void;
  onArtifactSelection(id: string, selection: ArtifactSelectionPayload): void;
  onArtifactSelectionModeChange(id: string, enabled: boolean): void;
  onVisualRepair(id: string, snapshot: RenderSnapshot, width: number): void;
  onRegenerate(id: string): void;
  onSelectBranch(groupId: string, variantId: string): void;
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
  isArtifactSelectionModeActive = false,
  branchInfo,
  onRuntimeError,
  onArtifactAction,
  onArtifactSelection,
  onArtifactSelectionModeChange,
  onVisualRepair,
  onRegenerate,
  onSelectBranch
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
              : "Select preview region"
          }
          aria-label={
            isArtifactSelectionModeActive
              ? "Stop selecting preview regions"
              : "Select preview region"
          }
          aria-pressed={isArtifactSelectionModeActive}
          disabled={selectionDisabled}
          onClick={() =>
            onArtifactSelectionModeChange(id, !isArtifactSelectionModeActive)
          }
        >
          <MousePointer2 size={15} strokeWidth={2.15} aria-hidden="true" />
          <span>{isArtifactSelectionModeActive ? "Selecting" : "Select"}</span>
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
      {branchInfo ? (
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
          reasoning={reasoning}
          isStreaming={status === "streaming"}
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
            selections={artifactSelections}
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
