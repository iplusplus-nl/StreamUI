import { useRef, useState } from "react";
import { downloadSnapshotAsPng } from "../core/exportSnapshotToPng";
import type { RenderError, RenderSnapshot } from "../core/types";
import { ErrorPanel } from "./ErrorPanel";
import { PreviewFrame } from "./PreviewFrame";

type AssistantPreviewBubbleProps = {
  id: string;
  snapshot: RenderSnapshot;
  onRuntimeError(id: string, error: RenderError): void;
};

export function AssistantPreviewBubble({
  id,
  snapshot,
  onRuntimeError
}: AssistantPreviewBubbleProps) {
  const containerRef = useRef<HTMLElement | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const canExport = Boolean(snapshot.completedHtml.trim()) && !isExporting;

  const handleDownload = async () => {
    if (!canExport) {
      return;
    }

    setIsExporting(true);
    try {
      const width = containerRef.current?.clientWidth ?? 900;
      await downloadSnapshotAsPng(snapshot, {
        filename: `streamui-${id}.png`,
        width
      });
    } catch (error) {
      onRuntimeError(id, {
        kind: "runtime",
        message:
          error instanceof Error
            ? `Could not export PNG: ${error.message}`
            : "Could not export PNG.",
        timestamp: Date.now()
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <section ref={containerRef} className={`assistant-canvas ${snapshot.status}`}>
      <div className="canvas-toolbar">
        <button
          className="canvas-action-button"
          type="button"
          disabled={!canExport}
          onClick={() => void handleDownload()}
        >
          {isExporting ? "Preparing..." : "Download PNG"}
        </button>
      </div>
      <PreviewFrame
        snapshot={snapshot}
        onRuntimeError={(error) => onRuntimeError(id, error)}
      />
      <ErrorPanel errors={snapshot.errors} />
    </section>
  );
}
