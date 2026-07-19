import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent
} from "react";
import { createPortal } from "react-dom";
import {
  Bug,
  Camera,
  CheckCircle2,
  ImagePlus,
  LoaderCircle,
  Send,
  Trash2,
  Upload,
  X
} from "lucide-react";
import {
  createEmptyBugReportDraft,
  createId,
  MAX_BUG_REPORT_IMAGES,
  MAX_BUG_REPORT_TEXT_LENGTH,
  normalizeBugReportDraft,
  type BugReportDraft,
  type BugReportImage
} from "../domain/chat/sessionModel";
import type { ThemeMode } from "./SessionSidebar";
import { useModalFocusTrap } from "./useModalFocusTrap";

const MAX_BUG_REPORT_IMAGE_BYTES = 12 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
]);

type BugReportDialogProps = {
  draft: BugReportDraft;
  themeMode: ThemeMode;
  captureError?: string | null;
  submitError?: string | null;
  isCapturing?: boolean;
  isSubmitting?: boolean;
  isSubmitted?: boolean;
  onChange(draft: BugReportDraft): void;
  onCapture(): void;
  onClose(): void;
  onDiscard(): void;
  onSubmit(draft: BugReportDraft): void;
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("Could not read the image."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Could not read the image."));
    });
    reader.readAsDataURL(file);
  });
}

function getImageSize(dataUrl: string): Promise<{
  width?: number;
  height?: number;
}> {
  const image = new Image();
  return new Promise((resolve) => {
    image.addEventListener(
      "load",
      () =>
        resolve({
          width: image.naturalWidth || undefined,
          height: image.naturalHeight || undefined
        }),
      { once: true }
    );
    image.addEventListener("error", () => resolve({}), { once: true });
    image.src = dataUrl;
  });
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") {
    return "jpg";
  }
  if (mimeType === "image/webp") {
    return "webp";
  }
  if (mimeType === "image/gif") {
    return "gif";
  }
  return "png";
}

async function fileToBugReportImage(
  file: File,
  fallbackName: string
): Promise<BugReportImage> {
  const mimeType = file.type.toLowerCase();
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error("Only PNG, JPEG, WebP, and GIF images are supported.");
  }
  if (file.size > MAX_BUG_REPORT_IMAGE_BYTES) {
    throw new Error("This image is too large.");
  }

  const dataUrl = await readFileAsDataUrl(file);
  const size = await getImageSize(dataUrl);
  const extension = extensionForMimeType(mimeType);

  return {
    id: createId("bug-image"),
    name: file.name || `${fallbackName}.${extension}`,
    mimeType,
    size: file.size,
    dataUrl,
    width: size.width,
    height: size.height,
    createdAt: Date.now()
  };
}

export function BugReportDialog({
  draft,
  themeMode,
  captureError,
  submitError,
  isCapturing = false,
  isSubmitting = false,
  isSubmitted = false,
  onChange,
  onCapture,
  onClose,
  onDiscard,
  onSubmit
}: BugReportDialogProps) {
  const [localError, setLocalError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const draftRef = useRef(draft);

  useModalFocusTrap({
    dialogRef,
    initialFocusRef: isCapturing ? undefined : textAreaRef
  });

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isSubmitted) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isSubmitted, onClose]);

  const emitDraft = (updater: (current: BugReportDraft) => BugReportDraft) => {
    const now = Date.now();
    const next = {
      ...updater(draftRef.current),
      updatedAt: now
    };
    const normalized =
      normalizeBugReportDraft(next, now) ?? createEmptyBugReportDraft(now);
    draftRef.current = normalized;
    onChange(normalized);
  };

  const addFiles = async (files: File[]) => {
    if (isCapturing || isSubmitting || isSubmitted) {
      return;
    }

    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (!imageFiles.length) {
      return;
    }

    setLocalError(null);
    const availableSlots = MAX_BUG_REPORT_IMAGES - draftRef.current.images.length;
    if (availableSlots <= 0) {
      setLocalError(`You can attach up to ${MAX_BUG_REPORT_IMAGES} images.`);
      return;
    }

    try {
      const prepared = await Promise.all(
        imageFiles
          .slice(0, availableSlots)
          .map((file, index) => fileToBugReportImage(file, `pasted-image-${index + 1}`))
      );
      emitDraft((current) => ({
        ...current,
        images: [...current.images, ...prepared]
      }));
      if (imageFiles.length > availableSlots) {
        setLocalError(`Only ${MAX_BUG_REPORT_IMAGES} images can be attached.`);
      }
    } catch (error) {
      setLocalError(
        error instanceof Error ? error.message : "Could not attach that image."
      );
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void addFiles(files);
  };

  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    if (isCapturing || isSubmitting || isSubmitted) {
      return;
    }

    const files = Array.from(event.clipboardData.items)
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file?.type.startsWith("image/")));
    if (!files.length) {
      return;
    }

    event.preventDefault();
    void addFiles(files);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (isCapturing || isSubmitting || isSubmitted) {
      return;
    }

    if (!Array.from(event.dataTransfer.items).some((item) => item.type.startsWith("image/"))) {
      return;
    }

    event.preventDefault();
    setIsDragging(true);
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    if (isCapturing || isSubmitting || isSubmitted) {
      return;
    }

    const files = Array.from(event.dataTransfer.files).filter((file) =>
      file.type.startsWith("image/")
    );
    if (!files.length) {
      return;
    }

    event.preventDefault();
    setIsDragging(false);
    void addFiles(files);
  };

  const hasContent = draft.text.trim().length > 0 || draft.images.length > 0;
  const statusText = isCapturing
    ? "Capturing screenshot…"
    : `${draft.images.length}/${MAX_BUG_REPORT_IMAGES} images`;

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="bug-report-overlay"
      data-screenshot-exclude=""
      data-theme={themeMode}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSubmitted) {
          onClose();
        }
      }}
    >
      <section
        ref={dialogRef}
        className="bug-report-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bug-report-title"
        aria-busy={isCapturing || isSubmitting ? "true" : undefined}
        onPaste={handlePaste}
        onDragOver={handleDragOver}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        <header className="bug-report-header">
          <div className="bug-report-title-row">
            <Bug size={18} strokeWidth={2.1} aria-hidden="true" />
            <h2 id="bug-report-title">Bug Report</h2>
          </div>
          <button
            className="bug-report-icon-button"
            type="button"
            aria-label="Close bug report"
            disabled={isSubmitted}
            onClick={onClose}
          >
            <X size={17} strokeWidth={2.1} aria-hidden="true" />
          </button>
        </header>

        <div className="bug-report-content">
          {isCapturing ? (
            <div className="bug-report-capture-status" role="status">
              <LoaderCircle
                className="bug-report-spinner"
                size={16}
                strokeWidth={2.1}
                aria-hidden="true"
              />
              <span>Capturing screenshot…</span>
            </div>
          ) : null}
          <div
            className={`bug-report-image-area ${isDragging ? "is-dragging" : ""}`}
          >
            {draft.images.length ? (
              <div className="bug-report-image-grid">
                {draft.images.map((image) => (
                  <figure className="bug-report-image-card" key={image.id}>
                    <img src={image.dataUrl} alt={image.name} />
                    <figcaption>
                      <span>{image.captured ? "Screenshot" : image.name}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${image.name}`}
                        disabled={isCapturing || isSubmitting || isSubmitted}
                        onClick={() =>
                          emitDraft((current) => ({
                            ...current,
                            images: current.images.filter(
                              (candidate) => candidate.id !== image.id
                            ),
                            screenshotCapturedAt:
                              image.captured && !current.screenshotCapturedAt
                                ? Date.now()
                                : current.screenshotCapturedAt
                          }))
                        }
                      >
                        <Trash2 size={14} strokeWidth={2.1} aria-hidden="true" />
                      </button>
                    </figcaption>
                  </figure>
                ))}
              </div>
            ) : (
              <div className="bug-report-empty-images">
                <ImagePlus size={24} strokeWidth={1.9} aria-hidden="true" />
                <span>No images attached</span>
              </div>
            )}

            <button
              className="bug-report-upload-button"
              type="button"
              disabled={
                isCapturing ||
                isSubmitting ||
                isSubmitted ||
                draft.images.length >= MAX_BUG_REPORT_IMAGES
              }
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={15} strokeWidth={2.1} aria-hidden="true" />
              <span>Add Image</span>
            </button>
            <button
              className="bug-report-upload-button"
              type="button"
              disabled={
                isCapturing ||
                isSubmitting ||
                isSubmitted ||
                draft.images.length >= MAX_BUG_REPORT_IMAGES ||
                draft.images.some((image) => image.captured)
              }
              onClick={onCapture}
            >
              <Camera size={15} strokeWidth={2.1} aria-hidden="true" />
              <span>Capture screenshot</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={handleFileChange}
            />
          </div>

          <label className="bug-report-text-field">
            <span>Details</span>
            <textarea
              ref={textAreaRef}
              value={draft.text}
              rows={7}
              maxLength={MAX_BUG_REPORT_TEXT_LENGTH}
              placeholder="What happened?"
              disabled={isCapturing || isSubmitting || isSubmitted}
              onChange={(event) => {
                const value = event.target.value;
                emitDraft((current) => ({
                  ...current,
                  text: value
                }));
              }}
            />
          </label>

          <p className="settings-hint">
            Reports are stored by ChatHTML support with this session&apos;s title,
            the current page path, browser details, and viewport size. No
            screenshot is captured automatically; only a screenshot you
            explicitly capture or images you add are submitted. Remove secrets
            and personal information before sending.
          </p>

          {isSubmitted ? (
            <div className="bug-report-success" role="status">
              <CheckCircle2 size={15} strokeWidth={2.1} aria-hidden="true" />
              <span>Report sent successfully.</span>
            </div>
          ) : captureError || localError || submitError ? (
            <div className="bug-report-error" role="status">
              {submitError ?? localError ?? captureError}
            </div>
          ) : null}
        </div>

        <footer className="bug-report-footer">
          <span>{statusText}</span>
          <div className="bug-report-actions">
            <button
              className="bug-report-secondary-button is-danger"
              type="button"
              disabled={isSubmitted}
              onClick={onDiscard}
            >
              Discard
            </button>
            <button
              className="bug-report-secondary-button"
              type="button"
              disabled={isSubmitted}
              onClick={onClose}
            >
              Close
            </button>
            <button
              className={`bug-report-primary-button ${
                isSubmitted ? "is-success" : ""
              }`}
              type="button"
              disabled={
                isCapturing || !hasContent || isSubmitting || isSubmitted
              }
              onClick={() => onSubmit(draftRef.current)}
            >
              {isSubmitted ? (
                <>
                  <span className="bug-report-thanks-burst" aria-hidden="true">
                    {Array.from({ length: 8 }).map((_, index) => (
                      <span key={index} className={`spark-${index + 1}`} />
                    ))}
                  </span>
                  <CheckCircle2 size={15} strokeWidth={2.1} aria-hidden="true" />
                </>
              ) : isSubmitting ? (
                <LoaderCircle
                  className="bug-report-spinner"
                  size={15}
                  strokeWidth={2.1}
                  aria-hidden="true"
                />
              ) : (
                <Send size={15} strokeWidth={2.1} aria-hidden="true" />
              )}
              <span>
                {isSubmitted ? "Thanks!" : isSubmitting ? "Sending" : "Send"}
              </span>
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body
  );
}
