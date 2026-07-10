import { useMemo, useState } from "react";
import {
  createArtifactSelectionController,
  type ArtifactSelectionController
} from "./artifactSelectionController";

export type ArtifactSelections = ArtifactSelectionController & {
  selectionClearVersion: number;
  selectionClearMessageId?: string;
};

export function useArtifactSelections(): ArtifactSelections {
  const [selectionClearRequest, setSelectionClearRequest] = useState<{
    version: number;
    messageId?: string;
  }>({ version: 0 });
  const controller = useMemo(
    () =>
      createArtifactSelectionController({
        onSelectionsCleared: (messageId) => {
          setSelectionClearRequest((current) => ({
            version: current.version + 1,
            messageId
          }));
        }
      }),
    []
  );

  return {
    ...controller,
    selectionClearVersion: selectionClearRequest.version,
    selectionClearMessageId: selectionClearRequest.messageId
  };
}
