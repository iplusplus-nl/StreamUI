import { useEffect, useMemo } from "react";
import {
  AttachmentPrimitive,
  AuiIf,
  ComposerPrimitive,
  useAuiState,
  type Attachment
} from "@assistant-ui/react";
import { MAX_IMAGE_ATTACHMENTS } from "../core/assistantAttachments";
import type { ReasoningEffort } from "../core/apiSettings";
import { ChatModelSelector } from "./ChatModelSelector";

function useAttachmentPreviewUrl(attachment: Attachment): string | undefined {
  return useMemo(() => {
    if (attachment.file) {
      return URL.createObjectURL(attachment.file);
    }

    const imagePart = attachment.content?.find((part) => part.type === "image");
    return imagePart?.type === "image" ? imagePart.image : undefined;
  }, [attachment]);
}

function ComposerAttachmentPreview({ attachment }: { attachment: Attachment }) {
  const previewUrl = useAttachmentPreviewUrl(attachment);
  const isUploading = attachment.status.type === "running";
  const isError = attachment.status.type === "incomplete";

  useEffect(() => {
    return () => {
      if (previewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  return (
    <AttachmentPrimitive.Root
      className={[
        "attachment-thumb",
        isUploading ? "is-uploading" : "",
        isError ? "is-error" : ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {previewUrl ? (
        <img src={previewUrl} alt={attachment.name} />
      ) : (
        <AttachmentPrimitive.unstable_Thumb className="attachment-extension" />
      )}
      {isUploading ? (
        <span className="attachment-upload-spinner" aria-label="Uploading image" />
      ) : null}
      {isError ? <span className="attachment-upload-error">Upload failed</span> : null}
      <figcaption>
        <AttachmentPrimitive.Name />
      </figcaption>
      <AttachmentPrimitive.Remove
        className="attachment-remove"
        type="button"
        disabled={isUploading}
        aria-label={`Remove ${attachment.name}`}
      >
        <span className="x-icon" aria-hidden="true" />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
}

type ChatInputProps = {
  model: string;
  modelOptions: string[];
  reasoningEffort: ReasoningEffort;
  onModelChange(model: string): void;
  onReasoningEffortChange(reasoningEffort: ReasoningEffort): void;
};

export function ChatInput({
  model,
  modelOptions,
  reasoningEffort,
  onModelChange,
  onReasoningEffortChange
}: ChatInputProps) {
  const attachments = useAuiState((state) => state.composer.attachments);
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const canSend = useAuiState((state) => state.composer.canSend);
  const attachmentCount = attachments.length;
  const isUploadingAttachment = attachments.some(
    (attachment) => attachment.status.type === "running"
  );
  const hasAttachmentError = attachments.some(
    (attachment) => attachment.status.type === "incomplete"
  );
  const reachedAttachmentLimit = attachmentCount >= MAX_IMAGE_ATTACHMENTS;

  return (
    <ComposerPrimitive.Root className="chat-input-bar">
      <ComposerPrimitive.AttachmentDropzone className="chat-input-dropzone">
        {attachmentCount > 0 ? (
          <div className="attachment-tray" aria-label="Attached images">
            <ComposerPrimitive.Attachments>
              {({ attachment }) => (
                <ComposerAttachmentPreview
                  key={attachment.id}
                  attachment={attachment}
                />
              )}
            </ComposerPrimitive.Attachments>
          </div>
        ) : null}
        <ComposerPrimitive.Input
          className="chat-input-textarea"
          rows={1}
          autoFocus
          placeholder="Send a message..."
          submitMode="enter"
        />
        <div className="chat-input-actions">
          <div className="chat-input-action-group">
            <ComposerPrimitive.AddAttachment
              className="attach-button"
              type="button"
              multiple={false}
              disabled={reachedAttachmentLimit || isUploadingAttachment}
              aria-label="Attach image"
              title={
                isUploadingAttachment
                  ? "Image upload in progress"
                  : reachedAttachmentLimit
                  ? `Up to ${MAX_IMAGE_ATTACHMENTS} images`
                  : "Attach image"
              }
            >
              <span className="plus-icon" aria-hidden="true" />
            </ComposerPrimitive.AddAttachment>
          </div>
          <div className="chat-input-action-group">
            <ChatModelSelector
              model={model}
              modelOptions={modelOptions}
              reasoningEffort={reasoningEffort}
              disabled={isRunning}
              onModelChange={onModelChange}
              onReasoningEffortChange={onReasoningEffortChange}
            />
            <AuiIf condition={(state) => !state.thread.isRunning}>
              <ComposerPrimitive.Send
                className="send-button"
                type="submit"
                disabled={!canSend}
                aria-label="Send message"
                title={
                  isUploadingAttachment
                    ? "Image upload in progress"
                    : hasAttachmentError
                      ? "Remove failed uploads before sending"
                      : "Send message"
                }
              >
                <span className="send-arrow-up" aria-hidden="true" />
              </ComposerPrimitive.Send>
            </AuiIf>
            <AuiIf condition={(state) => state.thread.isRunning}>
              <ComposerPrimitive.Cancel
                className="send-button cancel-button"
                type="button"
                aria-label="Stop response"
                title="Stop response"
              >
                <span className="stop-square" aria-hidden="true" />
              </ComposerPrimitive.Cancel>
            </AuiIf>
          </div>
        </div>
      </ComposerPrimitive.AttachmentDropzone>
    </ComposerPrimitive.Root>
  );
}
