import { useRef } from "react";
import type { PageThemeMode, RenderError, RenderSnapshot } from "../core/types";
import { ErrorPanel } from "./ErrorPanel";
import { PreviewFrame } from "./PreviewFrame";

type AssistantPreviewBubbleProps = {
  id: string;
  snapshot: RenderSnapshot;
  themeMode: PageThemeMode;
  onRuntimeError(id: string, error: RenderError): void;
};

export function AssistantPreviewBubble({
  id,
  snapshot,
  themeMode,
  onRuntimeError
}: AssistantPreviewBubbleProps) {
  const containerRef = useRef<HTMLElement | null>(null);

  return (
    <section ref={containerRef} className={`assistant-canvas ${snapshot.status}`}>
      <PreviewFrame
        snapshot={snapshot}
        themeMode={themeMode}
        onRuntimeError={(error) => onRuntimeError(id, error)}
      />
      <ErrorPanel errors={snapshot.errors} />
    </section>
  );
}
