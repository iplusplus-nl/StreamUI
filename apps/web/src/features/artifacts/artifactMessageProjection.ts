import { buildArtifactContext } from "../../core/artifactContext";
import type { ArtifactSelection } from "../../core/artifactSelection";
import type {
  ArtifactEditReference,
  ClientMessage
} from "../../domain/chat/sessionModel";
import { extractStreamUiParts } from "../../runtime/streamui/protocol";
import { createStreamingRenderer } from "../../runtime/streamui/streamingRenderer";
import type {
  PageThemeMode,
  RenderSnapshot,
  StreamUiAction
} from "../../runtime/streamui/types";

export function artifactSelectionToReference(
  selection: ArtifactSelection
): ArtifactEditReference {
  return {
    kind: selection.kind,
    key: selection.key,
    selector: selection.selector,
    label: selection.label,
    preview: selection.preview,
    tagName: selection.tagName,
    text: selection.text,
    html: selection.html
  };
}

export function buildCompletedAssistantPatchFromRawStream(
  rawStream: string,
  themeMode: PageThemeMode
): Partial<ClientMessage> {
  const parts = extractStreamUiParts(rawStream);
  const hasVisibleStreamUi =
    parts.hasStreamUi && parts.streamui.trim().length > 0;
  let snapshot: RenderSnapshot | undefined;

  if (hasVisibleStreamUi) {
    const renderer = createStreamingRenderer(themeMode);
    renderer.replace(parts.streamui);
    renderer.complete();
    snapshot = renderer.getSnapshot();
  }

  return {
    content: parts.chat || parts.fallbackText,
    sessionTitle:
      parts.sessionTitleComplete && parts.sessionTitle.trim()
        ? parts.sessionTitle
        : undefined,
    rawStream,
    snapshot,
    artifactContext: hasVisibleStreamUi
      ? buildArtifactContext(rawStream)
      : undefined,
    hasStreamUi: hasVisibleStreamUi,
    streamUiComplete: parts.streamUiComplete,
    runtimeErrors: undefined,
    status: "complete",
    error: undefined
  };
}

export function buildArtifactActionMessage(action: StreamUiAction): string {
  return action.type === "prompt" ? action.prompt.trim().slice(0, 2000) : "";
}
