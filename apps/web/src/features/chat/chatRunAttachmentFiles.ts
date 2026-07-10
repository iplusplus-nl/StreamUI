import type { ImageAttachment } from "../../core/imageAttachments";
import type { SessionFile } from "../../domain/chat/sessionModel";
import { commitUploadedImageFile } from "../sessions/sessionFileModel";
import { mergeSessionFiles } from "../sessions/sessionSelectors";

export type PreparedChatRunAttachmentFiles = {
  uploadedFiles: SessionFile[];
  allAttachmentsCommitted: boolean;
  ephemeral: boolean;
};

export function prepareChatRunAttachmentFiles(
  attachments: readonly ImageAttachment[],
  userMessageId: string,
  ephemeral: boolean
): PreparedChatRunAttachmentFiles {
  const uploadedFiles = attachments
    .map((attachment) => commitUploadedImageFile(attachment, userMessageId))
    .filter((file): file is SessionFile => file !== null);

  return {
    uploadedFiles,
    allAttachmentsCommitted: uploadedFiles.length === attachments.length,
    ephemeral
  };
}

export function getChatRunSessionFiles(
  existingFiles: readonly SessionFile[],
  prepared: PreparedChatRunAttachmentFiles
): SessionFile[] {
  return prepared.ephemeral
    ? [...existingFiles]
    : mergeSessionFiles([...existingFiles, ...prepared.uploadedFiles]);
}

export function getChatRunRequestFiles(
  existingFiles: readonly SessionFile[],
  prepared: PreparedChatRunAttachmentFiles
): SessionFile[] {
  return mergeSessionFiles([...existingFiles, ...prepared.uploadedFiles]);
}

export function getEphemeralChatRunFileIds(
  prepared: PreparedChatRunAttachmentFiles
): string[] | undefined {
  return prepared.ephemeral
    ? prepared.uploadedFiles.map((file) => file.id)
    : undefined;
}
