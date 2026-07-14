import { useEffect, useLayoutEffect, useState } from "react";
import {
  createComposerSessionDraftController,
  type ComposerSessionDraftController,
  type ComposerSessionDraftPort
} from "./composerSessionDraftController";

export type UseComposerSessionDraftsInput = {
  composer: ComposerSessionDraftPort & { subscribe(callback: () => void): () => void };
  activeSessionId: string;
  onError?(message: string, error: unknown): void;
  onDraftsChange?(hasDrafts: boolean): void;
  onDraftSessionIdsChange?(sessionIds: ReadonlySet<string>): void;
  onAttachmentSafetyChange?(blocked: boolean): void;
};

export function useComposerSessionDrafts({
  composer,
  activeSessionId,
  onError,
  onDraftsChange,
  onDraftSessionIdsChange,
  onAttachmentSafetyChange
}: UseComposerSessionDraftsInput): ComposerSessionDraftController {
  const [controller] = useState(() =>
    createComposerSessionDraftController(composer, activeSessionId, {
      onError,
      onDraftsChange,
      onDraftSessionIdsChange,
      onAttachmentSafetyChange
    })
  );

  useEffect(() => composer.subscribe(controller.capture), [composer, controller]);

  useLayoutEffect(() => {
    controller.activate(activeSessionId);
  }, [activeSessionId, controller]);

  useEffect(() => () => controller.dispose(), [controller]);

  return controller;
}
