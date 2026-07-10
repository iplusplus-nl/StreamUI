import type { ImageAttachment } from "../../core/imageAttachments";
import type { SessionFile } from "../../domain/chat/sessionModel";
import type { RenderSnapshot } from "../../runtime/streamui/types";
import type { SessionFileUploadInput } from "./sessionFileContracts";

export function getAttachmentSessionError(
  attachments: ImageAttachment[],
  targetSessionId: string
): string | null {
  if (attachments.some((attachment) => !attachment.sessionFile)) {
    return "Image upload is still in progress. Please wait before sending.";
  }

  if (
    attachments.some(
      (attachment) =>
        attachment.ownerSessionId &&
        attachment.ownerSessionId !== targetSessionId
    )
  ) {
    return "An attached image belongs to another session. Remove it and attach it again.";
  }

  return null;
}

export function imageAttachmentToFileUpload(
  attachment: ImageAttachment,
  sourceMessageId?: string,
  draft = false
): SessionFileUploadInput {
  return {
    kind: "image",
    name: attachment.name,
    mimeType: attachment.mimeType,
    sourceMessageId,
    dataUrl: attachment.dataUrl,
    width: attachment.width,
    height: attachment.height,
    summary: `Uploaded image ${attachment.name}`,
    draft
  };
}

export function createArtifactFileUpload(
  messageId: string,
  rawStream: string,
  snapshot: RenderSnapshot | undefined,
  summary: string | undefined
): SessionFileUploadInput | null {
  const source = rawStream || snapshot?.raw || snapshot?.completedHtml || "";
  if (!source.trim()) {
    return null;
  }

  return {
    kind: "artifact",
    name: `${messageId}.chathtml.html`,
    mimeType: "text/html",
    sourceMessageId: messageId,
    text: source,
    summary: summary || "ChatHTML artifact raw source"
  };
}

export function commitUploadedImageFile(
  attachment: ImageAttachment,
  sourceMessageId: string
): SessionFile | null {
  if (!attachment.sessionFile) {
    return null;
  }

  const { draft: _draft, ...file } = attachment.sessionFile;
  const shouldKeepInlineDataUrl = !file.storageKey && !file.embedUrl;
  return {
    ...file,
    kind: "image",
    sourceMessageId,
    ...(shouldKeepInlineDataUrl ? { dataUrl: attachment.dataUrl } : {}),
    width: file.width ?? attachment.width,
    height: file.height ?? attachment.height
  };
}
