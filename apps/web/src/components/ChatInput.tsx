import { useEffect, useMemo } from "react";
import {
  AttachmentPrimitive,
  AuiIf,
  ComposerPrimitive,
  useAuiState,
  type Attachment
} from "@assistant-ui/react";
import { X } from "lucide-react";
import type { ArtifactSelection } from "../core/artifactSelection";
import { MAX_IMAGE_ATTACHMENTS } from "../core/assistantAttachments";
import type { ReasoningEffort } from "../core/apiSettings";
import {
  findImageInputCapableModel,
  modelLikelySupportsImageInput
} from "../core/modelCapabilities";
import { getComposerAttachmentPresentation } from "./chatInputAttachmentModel";
import { ChatModelSelector } from "./ChatModelSelector";

function shouldAutoFocusComposer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }

  return !window.matchMedia("(hover: none), (pointer: coarse)").matches;
}

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
  const { isUploading, isError, isRemoveDisabled } =
    getComposerAttachmentPresentation(attachment.status);

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
        disabled={isRemoveDisabled}
        aria-label={`Remove ${attachment.name}`}
        title={isUploading ? "Cancel upload" : "Remove attachment"}
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
  reasoningSupported: boolean;
  submissionError?: string | null;
  attachmentSafetyBlocked?: boolean;
  attachmentSafetyError?: string | null;
  uiComplexity: number;
  artifactSelections?: ArtifactSelection[];
  onRemoveArtifactSelection?(id: string): void;
  onClearArtifactSelections?(): void;
  onModelChange(model: string): void;
  onReasoningEffortChange(reasoningEffort: ReasoningEffort): void;
  onDismissSubmissionError?(): void;
  onRetryAttachmentCleanup?(): void;
  onUiComplexityChange(uiComplexity: number): void;
};

function ArtifactSelectionTray({
  selections,
  onRemove,
  onClear
}: {
  selections: ArtifactSelection[];
  onRemove(id: string): void;
  onClear(): void;
}) {
  if (!selections.length) {
    return null;
  }

  const getSelectionText = (selection: ArtifactSelection) =>
    selection.preview || selection.label;

  return (
    <div className="artifact-selection-tray" aria-label="Selected preview regions">
      <div className="artifact-selection-list">
        {selections.map((selection) => (
          <div
            className={`artifact-selection-chip is-${selection.kind}`}
            key={selection.id}
          >
            <span className="artifact-selection-kind">
              {selection.kind === "text" ? "Reference" : "Element"}
            </span>
            <span className="artifact-selection-copy">
              <span>{getSelectionText(selection)}</span>
            </span>
            <button
              className="artifact-selection-remove"
              type="button"
              aria-label={`Remove ${selection.label}`}
              onClick={() => onRemove(selection.id)}
            >
              <X size={13} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      {selections.length > 1 ? (
        <button
          className="artifact-selection-clear"
          type="button"
          onClick={onClear}
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}

export function ChatInput({
  model,
  modelOptions,
  reasoningEffort,
  reasoningSupported,
  submissionError,
  attachmentSafetyBlocked = false,
  attachmentSafetyError,
  uiComplexity,
  artifactSelections = [],
  onRemoveArtifactSelection,
  onClearArtifactSelections,
  onModelChange,
  onReasoningEffortChange,
  onDismissSubmissionError,
  onRetryAttachmentCleanup,
  onUiComplexityChange
}: ChatInputProps) {
  const autoFocusComposer = useMemo(shouldAutoFocusComposer, []);
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
  const imageInputMayBeUnsupported =
    attachmentCount > 0 && !modelLikelySupportsImageInput(model);
  const recommendedImageModel = imageInputMayBeUnsupported
    ? findImageInputCapableModel(modelOptions)
    : undefined;

  return (
    <ComposerPrimitive.Root
      className="chat-input-bar"
      onSubmitCapture={(event) => {
        if (attachmentSafetyBlocked) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onKeyDownCapture={(event) => {
        if (
          attachmentSafetyBlocked &&
          event.key === "Enter" &&
          !event.shiftKey
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <ComposerPrimitive.AttachmentDropzone className="chat-input-dropzone">
        <ArtifactSelectionTray
          selections={artifactSelections}
          onRemove={(id) => onRemoveArtifactSelection?.(id)}
          onClear={() => onClearArtifactSelections?.()}
        />
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
        {imageInputMayBeUnsupported ? (
          <div className="attachment-capability-warning" role="status">
            <span>
              <strong>{model}</strong> may not support image input. Pixel-level
              analysis could fail or use only file metadata.
            </span>
            {recommendedImageModel ? (
              <button
                type="button"
                onClick={() => onModelChange(recommendedImageModel)}
              >
                Use {recommendedImageModel}
              </button>
            ) : (
              <span>Choose an image-capable model before sending.</span>
            )}
          </div>
        ) : null}
        {submissionError ? (
          <div className="composer-submission-error" role="alert">
            <span>{submissionError}</span>
            <button type="button" onClick={onDismissSubmissionError}>
              Dismiss
            </button>
          </div>
        ) : null}
        {attachmentSafetyBlocked ? (
          <div className="composer-submission-error" role="alert">
            <span>
              {attachmentSafetyError ??
                "Attachments are still switching between sessions. Sending is blocked to protect your draft."}
            </span>
            <button type="button" onClick={onRetryAttachmentCleanup}>
              Retry cleanup
            </button>
          </div>
        ) : null}
        <ComposerPrimitive.Input
          className="chat-input-textarea"
          rows={1}
          autoFocus={autoFocusComposer}
          placeholder="Send a message..."
          submitMode="enter"
        />
        <div className="chat-input-actions">
          <div className="chat-input-action-group">
            <ComposerPrimitive.AddAttachment
              className="attach-button"
              type="button"
              multiple={false}
              disabled={
                attachmentSafetyBlocked ||
                reachedAttachmentLimit ||
                isUploadingAttachment
              }
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
              reasoningSupported={reasoningSupported}
              uiComplexity={uiComplexity}
              disabled={isRunning}
              onModelChange={onModelChange}
              onReasoningEffortChange={onReasoningEffortChange}
              onUiComplexityChange={onUiComplexityChange}
            />
            <AuiIf condition={(state) => !state.thread.isRunning}>
              <ComposerPrimitive.Send
                className="send-button"
                type="submit"
                disabled={!canSend || attachmentSafetyBlocked}
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
