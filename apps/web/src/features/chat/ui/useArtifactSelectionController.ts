import { useCallback, useEffect, useMemo, useState } from "react";
import {
  canCaptureArtifactSelection,
  type ArtifactSelection,
  type ArtifactSelectionPayload
} from "../../../core/artifactSelection";
import {
  createId,
  type ClientMessage
} from "../../../domain/chat/sessionModel";
import {
  addArtifactSelection,
  groupArtifactSelectionsByMessageId,
  removeArtifactSelectionsForMessage,
  resolveSelectionModeMessageId,
  retainCapturableArtifactSelections,
  retainVisibleArtifactSelections,
  toggleSelectionModeMessageId
} from "./streamThreadModel";

type UseArtifactSelectionControllerInput = {
  activeSessionId: string;
  messageById: ReadonlyMap<string, ClientMessage>;
  visibleMessageIds: ReadonlySet<string>;
  artifactEditingEnabled: boolean;
  clearVersion: number;
  clearMessageId?: string;
  onChange(selections: ArtifactSelection[]): void;
};

function focusComposerInput(): void {
  window.setTimeout(() => {
    const input = document.querySelector<HTMLElement>(".chat-input-textarea");
    input?.focus({ preventScroll: true });
  }, 0);
}

export function useArtifactSelectionController({
  activeSessionId,
  messageById,
  visibleMessageIds,
  artifactEditingEnabled,
  clearVersion,
  clearMessageId,
  onChange
}: UseArtifactSelectionControllerInput) {
  const [selections, setSelections] = useState<ArtifactSelection[]>([]);
  const [selectionModeMessageId, setSelectionModeMessageId] = useState<
    string | null
  >(null);
  const selectionsByMessageId = useMemo(
    () => groupArtifactSelectionsByMessageId(selections),
    [selections]
  );

  useEffect(() => {
    setSelections([]);
    setSelectionModeMessageId(null);
  }, [activeSessionId]);

  useEffect(() => {
    if (artifactEditingEnabled) {
      return;
    }

    setSelections((current) =>
      retainCapturableArtifactSelections(current, false)
    );
    setSelectionModeMessageId(null);
  }, [artifactEditingEnabled]);

  useEffect(() => {
    setSelections((current) =>
      retainVisibleArtifactSelections(current, visibleMessageIds)
    );
    setSelectionModeMessageId((current) =>
      resolveSelectionModeMessageId(current, messageById)
    );
  }, [messageById, visibleMessageIds]);

  useEffect(() => {
    onChange(selections);
  }, [onChange, selections]);

  useEffect(() => {
    if (clearVersion <= 0) {
      return;
    }

    if (clearMessageId) {
      setSelections((current) =>
        removeArtifactSelectionsForMessage(current, clearMessageId)
      );
      setSelectionModeMessageId((current) =>
        current === clearMessageId ? null : current
      );
      return;
    }

    setSelections([]);
    setSelectionModeMessageId(null);
  }, [clearMessageId, clearVersion]);

  useEffect(() => {
    if (!selectionModeMessageId) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectionModeMessageId(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [selectionModeMessageId]);

  useEffect(() => {
    if (!selectionModeMessageId) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest(".artifact-select-action")
      ) {
        return;
      }

      if (
        event.target instanceof HTMLIFrameElement &&
        event.target.classList.contains("preview-frame")
      ) {
        return;
      }

      setSelectionModeMessageId(null);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [selectionModeMessageId]);

  const select = useCallback(
    (messageId: string, selection: ArtifactSelectionPayload) => {
      if (
        !canCaptureArtifactSelection(selection.kind, artifactEditingEnabled)
      ) {
        return;
      }

      setSelections((current) =>
        addArtifactSelection(current, messageId, selection, {
          id: createId("artifact-selection"),
          createdAt: Date.now()
        })
      );
      focusComposerInput();
    },
    [artifactEditingEnabled]
  );

  const toggleMode = useCallback(
    (messageId: string, enabled: boolean) => {
      setSelectionModeMessageId((current) =>
        toggleSelectionModeMessageId(
          current,
          messageId,
          enabled,
          artifactEditingEnabled
        )
      );
    },
    [artifactEditingEnabled]
  );

  const remove = useCallback((id: string) => {
    setSelections((current) =>
      current.filter((selection) => selection.id !== id)
    );
  }, []);

  const clear = useCallback(() => {
    setSelections([]);
  }, []);

  return {
    selections,
    selectionsByMessageId,
    selectionModeMessageId,
    select,
    toggleMode,
    remove,
    clear
  };
}
