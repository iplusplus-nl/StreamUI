import type { ArtifactSelection } from "../../core/artifactSelection";
import type { ImageAttachment } from "../../core/imageAttachments";
import type { ArtifactEditRunOutcome } from "../artifacts/artifactEditController";

export type ComposerSubmissionOutcome =
  | { kind: "artifact-edit"; editOutcome: ArtifactEditRunOutcome }
  | { kind: "artifact-generation" }
  | { kind: "chat" };

export type ComposerSubmissionPorts = {
  getSelections(): ArtifactSelection[];
  runSourceEdit(
    text: string,
    selections: ArtifactSelection[],
    attachments: ImageAttachment[]
  ): Promise<ArtifactEditRunOutcome>;
  startArtifactGeneration(
    text: string,
    selections: ArtifactSelection[],
    attachments: ImageAttachment[]
  ): boolean | Promise<boolean>;
  sendChat(text: string, attachments: ImageAttachment[]): Promise<unknown>;
};

/**
 * Routes a composer submission without ever accepting it as a silent no-op.
 * Image-backed artifact edits use the chat generation path, which already
 * supports multimodal input, while ordinary reference edits keep using the
 * smaller source-edit endpoint.
 */
export async function submitComposerMessage(
  text: string,
  attachments: ImageAttachment[],
  ports: ComposerSubmissionPorts
): Promise<ComposerSubmissionOutcome> {
  const selections = ports.getSelections();
  if (selections.length > 0 && attachments.length > 0) {
    if (await ports.startArtifactGeneration(text, selections, attachments)) {
      return { kind: "artifact-generation" };
    }

    // A stale selection must not consume the composer without producing a
    // request. Fall back to an ordinary multimodal turn instead.
    await ports.sendChat(text, attachments);
    return { kind: "chat" };
  }

  if (selections.length > 0) {
    return {
      kind: "artifact-edit",
      editOutcome: await ports.runSourceEdit(text, selections, attachments)
    };
  }

  await ports.sendChat(text, attachments);
  return { kind: "chat" };
}

export function getArtifactEditSubmissionError(
  outcome: ArtifactEditRunOutcome
): string | null {
  switch (outcome) {
    case "completed":
      return null;
    case "busy":
      return "Another edit is already running. Your draft was restored; retry when it finishes.";
    case "missing":
    case "stale":
      return "That artifact or selection is no longer available. Your draft was restored; select the region again and retry.";
    case "invalid":
      return "The selected region could not be edited. Your draft was restored; refresh the selection and retry.";
    case "unsupported-attachments":
      return "This source edit cannot use attachments. Your draft was restored; remove the attachment or start a new artifact request.";
    case "authentication-required":
      return "Sign in or choose a configured provider, then retry the restored edit draft.";
    case "pending":
      return "That artifact edit is still pending. Your draft was restored so you can retry after it finishes.";
    case "cancelled":
      return "The artifact edit was cancelled. Your draft was restored.";
    case "failed":
      return "The artifact edit failed. Your draft was restored so you can retry.";
  }
}
