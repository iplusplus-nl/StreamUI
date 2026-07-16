import { MousePointer2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
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
const FLOATING_ACTION_SIDE_GAP = 18;
const FLOATING_ACTION_SAFE_GAP = 32;
const FLOATING_ACTION_COLUMN_GAP = 8;

type FloatingEditPosition = {
  left: number;
  top: number;
};

type SideActionsPosition = {
  left: number;
  top: number;
};

function clampValue(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getFloatingActionItems(actionsNode: HTMLElement): HTMLElement[] {
  const turnActions = actionsNode.querySelector<HTMLElement>(
    ":scope > .assistant-turn-actions"
  );
  const turnItems = turnActions
    ? Array.from(turnActions.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement
      )
    : [];
  const exportMenu = actionsNode.querySelector<HTMLElement>(
    ":scope > .artifact-export-menu"
  );

  return [...turnItems, ...(exportMenu ? [exportMenu] : [])].filter(
    (item) => item.getClientRects().length > 0
  );
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
  const artifactBlockRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const previewShellRef = useRef<HTMLDivElement | null>(null);
  const actionsSlotRef = useRef<HTMLDivElement | null>(null);
  const sideActionsRef = useRef<HTMLDivElement | null>(null);
  const [floatingEditPosition, setFloatingEditPosition] =
    useState<FloatingEditPosition | null>(null);
  const [bottomActionsSuppressed, setBottomActionsSuppressed] = useState(false);
  const [sideActionsPosition, setSideActionsPosition] =
    useState<SideActionsPosition | null>(null);
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
  const updateSideActions = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    const artifactBlock = artifactBlockRef.current;
    const actionsSlot = actionsSlotRef.current;
    const sideActionsNode = sideActionsRef.current;

    if (!artifactBlock || !actionsSlot || !sideActionsNode) {
      setBottomActionsSuppressed(false);
      setSideActionsPosition(null);
      return;
    }

    const actionItems = getFloatingActionItems(sideActionsNode);
    if (!actionItems.length) {
      setBottomActionsSuppressed(false);
      setSideActionsPosition(null);
      return;
    }

    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight;
    const viewportWidth =
      window.innerWidth || document.documentElement.clientWidth;
    const blockRect = artifactBlock.getBoundingClientRect();
    const slotRect = actionsSlot.getBoundingClientRect();
    const itemMetrics = actionItems.map((item) => {
      const itemRect = item.getBoundingClientRect();
      return {
        width: itemRect.width || item.offsetWidth || 24,
        height: itemRect.height || item.offsetHeight || 24
      };
    });
    const columnWidth = Math.max(...itemMetrics.map((metric) => metric.width));
    const columnHeight =
      itemMetrics.reduce((sum, metric) => sum + metric.height, 0) +
      Math.max(0, itemMetrics.length - 1) * FLOATING_ACTION_COLUMN_GAP;
    const inputRect =
      document
        .querySelector<HTMLElement>(".chat-input-bar")
        ?.getBoundingClientRect() ?? null;
    const composerRect =
      document
        .querySelector<HTMLElement>(".composer-footer.has-messages")
        ?.getBoundingClientRect() ?? null;
    const safeTop =
      (inputRect?.top ?? composerRect?.top ?? viewportHeight) -
      FLOATING_ACTION_SAFE_GAP;
    const bottomOverlapsSafeArea = slotRect.bottom > safeTop;
    const blockVisible =
      blockRect.bottom > FLOATING_EDIT_VIEWPORT_MARGIN &&
      blockRect.top < viewportHeight - FLOATING_EDIT_VIEWPORT_MARGIN;
    const railFitsWithinBlock = blockRect.bottom - blockRect.top >= columnHeight;
    const hasRightSideRoom =
      viewportWidth - blockRect.right >=
      columnWidth +
        FLOATING_ACTION_SIDE_GAP +
        FLOATING_EDIT_VIEWPORT_MARGIN;
    const sideTop = safeTop - columnHeight;
    const topHasReachedSideThreshold = blockRect.top > sideTop;

    setBottomActionsSuppressed(bottomOverlapsSafeArea);

    if (
      !bottomOverlapsSafeArea ||
      !blockVisible ||
      !railFitsWithinBlock ||
      !hasRightSideRoom ||
      topHasReachedSideThreshold
    ) {
      setSideActionsPosition(null);
      return;
    }

    const nextPosition = {
      left: Math.round(blockRect.right + FLOATING_ACTION_SIDE_GAP),
      top: Math.round(sideTop)
    };
    setSideActionsPosition((current) => {
      if (
        current &&
        current.left === nextPosition.left &&
        current.top === nextPosition.top
      ) {
        return current;
      }

      return nextPosition;
    });
  }, []);

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
        updateSideActions();
      });
    };

    updateFloatingEditAction();
    updateSideActions();
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
      if (artifactBlockRef.current) {
        resizeObserver.observe(artifactBlockRef.current);
      }
      if (actionsSlotRef.current) {
        resizeObserver.observe(actionsSlotRef.current);
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
  }, [updateSideActions, updateFloatingEditAction]);

  useEffect(() => {
    updateSideActions();
  }, [actions, selectionModeActive, snapshot.status, updateSideActions]);

  useLayoutEffect(() => {
    sideActionsRef.current?.toggleAttribute("inert", !sideActionsPosition);
  }, [sideActionsPosition]);

  return (
    <div
      ref={artifactBlockRef}
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
        ref={actionsSlotRef}
        className="assistant-artifact-actions-slot"
      >
        <div
          className={`assistant-artifact-actions ${
            bottomActionsSuppressed ? "is-suppressed" : ""
          }`}
          aria-label="Artifact actions"
          aria-hidden={bottomActionsSuppressed}
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
      <div
        ref={sideActionsRef}
        className={`assistant-artifact-side-actions ${
          sideActionsPosition ? "is-visible" : ""
        }`}
        aria-label="Artifact actions"
        aria-hidden={!sideActionsPosition}
        style={
          sideActionsPosition
            ? ({
                left: sideActionsPosition.left,
                top: sideActionsPosition.top
              } satisfies CSSProperties)
            : undefined
        }
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
