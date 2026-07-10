import type {
  ImageAttachment,
  UploadedSessionFile
} from "../../core/imageAttachments";

export function createEphemeralVisualRepairFile(
  attachment: ImageAttachment,
  sourceMessageId: string,
  createdAt = Date.now()
): UploadedSessionFile {
  return {
    id: attachment.id,
    kind: "image",
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    createdAt,
    sourceMessageId,
    dataUrl: attachment.dataUrl,
    draft: true,
    width: attachment.width,
    height: attachment.height,
    summary: `Temporary visual repair screenshot ${attachment.name}`
  };
}
