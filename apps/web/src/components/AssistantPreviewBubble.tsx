import { MousePointer2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ArtifactSelection,
  ArtifactSelectionPayload
} from "../core/artifactSelection";
import type {
  PageThemeMode,
  RenderError,
  RenderSnapshot,
  StreamUiAction
} from "../core/types";
import { ArtifactExportMenu } from "./ArtifactExportMenu";
import { ErrorPanel } from "./ErrorPanel";
import { PreviewFrame } from "./PreviewFrame";

type AssistantPreviewBubbleProps = {
  id: string;
  snapshot: RenderSnapshot;
  themeMode: PageThemeMode;
  actions?: ReactNode;
  editingEnabled?: boolean;
  selectionModeActive?: boolean;
  selectionDisabled?: boolean;
  selections?: ArtifactSelection[];
  busySelections?: Array<
    Pick<ArtifactSelectionPayload, "key" | "kind" | "selector">
  >;
  onRuntimeError(id: string, error: RenderError): void;
  onArtifactAction(id: string, action: StreamUiAction): void;
  onArtifactSelection(id: string, selection: ArtifactSelectionPayload): void;
  onSelectionModeChange(id: string, enabled: boolean): void;
};

const FLOATING_EDIT_MIN_PREVIEW_HEIGHT = 560;
const FLOATING_EDIT_VISIBILITY_EDGE_PX = 120;
const FLOATING_EDIT_BUTTON_SIZE = 34;
const FLOATING_EDIT_SIDE_GAP = 20;
const FLOATING_EDIT_VIEWPORT_MARGIN = 12;
const FLOATING_EDIT_VERTICAL_OFFSET_PX = 200;

type FloatingEditPosition = {
  left: number;
  top: number;
};

function clampValue(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function AssistantPreviewBubble({
  id,
  snapshot,
  themeMode,
  actions,
  editingEnabled = true,
  selectionModeActive = false,
  selectionDisabled = false,
  selections = [],
  busySelections = [],
  onRuntimeError,
  onArtifactAction,
  onArtifactSelection,
  onSelectionModeChange
}: AssistantPreviewBubbleProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const previewShellRef = useRef<HTMLDivElement | null>(null);
  const [floatingEditPosition, setFloatingEditPosition] =
    useState<FloatingEditPosition | null>(null);
  const getExportWidth = () => containerRef.current?.clientWidth ?? 900;
  const canEditSelection =
    editingEnabled && !selectionDisabled && snapshot.status === "complete";
  const updateFloatingEditAction = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    const previewShell = previewShellRef.current;
    if (!previewShell || !canEditSelection) {
      setFloatingEditPosition(null);
      return;
    }

    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;
    const viewportWidth =
      window.innerWidth || document.documentElement.clientWidth;
    const previewRect = previewShell.getBoundingClientRect();
    const minLongHeight = Math.max(
      FLOATING_EDIT_MIN_PREVIEW_HEIGHT,
      viewportHeight - 180
    );
    const previewIsLong = previewRect.height > minLongHeight;
    const previewIsRelevant =
      previewRect.bottom > FLOATING_EDIT_VISIBILITY_EDGE_PX &&
      previewRect.top < viewportHeight - FLOATING_EDIT_VISIBILITY_EDGE_PX;
    const hasRightSideRoom =
      viewportWidth - previewRect.right >=
      FLOATING_EDIT_BUTTON_SIZE +
        FLOATING_EDIT_SIDE_GAP +
        FLOATING_EDIT_VIEWPORT_MARGIN;
    const preferredTop =
      clampValue(viewportHeight * 0.16, 64, 108) +
      FLOATING_EDIT_VERTICAL_OFFSET_PX;
    const buttonFitsWithinPreviewY =
      preferredTop >= previewRect.top + FLOATING_EDIT_VIEWPORT_MARGIN &&
      preferredTop + FLOATING_EDIT_BUTTON_SIZE <=
        previewRect.bottom - FLOATING_EDIT_VIEWPORT_MARGIN;

    if (
      !previewIsLong ||
      !previewIsRelevant ||
      !hasRightSideRoom ||
      !buttonFitsWithinPreviewY
    ) {
      setFloatingEditPosition(null);
      return;
    }

    const nextPosition = {
      left: Math.round(previewRect.right + FLOATING_EDIT_SIDE_GAP),
      top: Math.round(preferredTop)
    };
    setFloatingEditPosition((current) =>
      current &&
      current.left === nextPosition.left &&
      current.top === nextPosition.top
        ? current
        : nextPosition
    );
  }, [canEditSelection]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    let animationFrameId = 0;
    const scheduleUpdate = () => {
      if (animationFrameId) {
        return;
      }

      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = 0;
        updateFloatingEditAction();
      });
    };

    updateFloatingEditAction();
    document.addEventListener("scroll", scheduleUpdate, true);
    window.addEventListener("resize", scheduleUpdate);

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleUpdate);
    if (resizeObserver) {
      if (previewShellRef.current) {
        resizeObserver.observe(previewShellRef.current);
      }
    }

    return () => {
      if (animationFrameId) {
        window.cancelAnimationFrame(animationFrameId);
      }
      document.removeEventListener("scroll", scheduleUpdate, true);
      window.removeEventListener("resize", scheduleUpdate);
      resizeObserver?.disconnect();
    };
  }, [updateFloatingEditAction]);

  return (
    <div
      className={`assistant-artifact-block ${
        canEditSelection ? "has-floating-edit-action" : ""
      }`}
    >
      <section
        ref={containerRef}
        className={`assistant-canvas ${snapshot.status}`}
      >
        <div className="assistant-preview-shell" ref={previewShellRef}>
          <PreviewFrame
            snapshot={snapshot}
            themeMode={themeMode}
            selectionModeActive={selectionModeActive}
            selectedSelections={selections}
            busySelections={busySelections}
            onRuntimeError={(error) => onRuntimeError(id, error)}
            onArtifactAction={(action) => onArtifactAction(id, action)}
            onArtifactSelection={(selection) => onArtifactSelection(id, selection)}
            onSelectionModeChange={(enabled) => onSelectionModeChange(id, enabled)}
          />
          {editingEnabled ? (
            <button
              className={`message-action-button artifact-select-action artifact-floating-edit-action ${
                selectionModeActive ? "is-active" : ""
              } ${floatingEditPosition ? "is-visible" : ""}`}
              type="button"
              title={
                selectionModeActive
                  ? "Stop editing preview regions"
                  : "Edit preview region"
              }
              aria-label={
                selectionModeActive
                  ? "Stop editing preview regions"
                  : "Edit preview region"
              }
              aria-hidden={!floatingEditPosition}
              aria-pressed={selectionModeActive}
              disabled={!canEditSelection}
              tabIndex={floatingEditPosition ? 0 : -1}
              style={
                floatingEditPosition
                  ? {
                      left: floatingEditPosition.left,
                      top: floatingEditPosition.top
                    }
                  : undefined
              }
              onClick={() => onSelectionModeChange(id, !selectionModeActive)}
            >
              <MousePointer2 size={17} strokeWidth={2.15} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <ErrorPanel errors={snapshot.errors} />
      </section>
      <div
        className="assistant-artifact-actions"
        aria-label="Artifact actions"
      >
        {actions}
        <ArtifactExportMenu
          filenameBase={id}
          getExportWidth={getExportWidth}
          snapshot={snapshot}
          themeMode={themeMode}
        />
      </div>
    </div>
  );
}
