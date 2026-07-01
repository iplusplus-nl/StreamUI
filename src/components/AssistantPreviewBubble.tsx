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
  return (
    <section className={`assistant-canvas ${snapshot.status}`}>
      <PreviewFrame
        snapshot={snapshot}
        onRuntimeError={(error) => onRuntimeError(id, error)}
      />
      <ErrorPanel errors={snapshot.errors} />
    </section>
  );
}
