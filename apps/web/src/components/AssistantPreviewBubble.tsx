import { useRef, type ReactNode } from "react";
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
  selectionModeActive?: boolean;
  selections?: ArtifactSelection[];
  onRuntimeError(id: string, error: RenderError): void;
  onArtifactAction(id: string, action: StreamUiAction): void;
  onArtifactSelection(id: string, selection: ArtifactSelectionPayload): void;
  onSelectionModeChange(id: string, enabled: boolean): void;
};

export function AssistantPreviewBubble({
  id,
  snapshot,
  themeMode,
  actions,
  selectionModeActive = false,
  selections = [],
  onRuntimeError,
  onArtifactAction,
  onArtifactSelection,
  onSelectionModeChange
}: AssistantPreviewBubbleProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const getExportWidth = () => containerRef.current?.clientWidth ?? 900;

  return (
    <div className="assistant-artifact-block">
      <section
        ref={containerRef}
        className={`assistant-canvas ${snapshot.status}`}
      >
        <PreviewFrame
          snapshot={snapshot}
          themeMode={themeMode}
          selectionModeActive={selectionModeActive}
          selectedSelections={selections}
          onRuntimeError={(error) => onRuntimeError(id, error)}
          onArtifactAction={(action) => onArtifactAction(id, action)}
          onArtifactSelection={(selection) => onArtifactSelection(id, selection)}
          onSelectionModeChange={(enabled) => onSelectionModeChange(id, enabled)}
        />
        <ErrorPanel errors={snapshot.errors} />
      </section>
      <div className="assistant-artifact-actions" aria-label="Artifact actions">
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
