import type {
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment
} from "@assistant-ui/react";
import {
  MAX_IMAGE_ATTACHMENTS,
  SUPPORTED_IMAGE_MIME_TYPES,
  type ImageAttachment,
  type UploadedSessionFile
} from "./imageAttachments";

const MAX_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024;
const TARGET_IMAGE_BYTES = 1.8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1600;
const QUALITY_COMPRESSIBLE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/webp"]);

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function estimateDataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.split(",")[1] ?? "";
  return Math.floor((base64.length * 3) / 4);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read the image file."));
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener(
      "error",
      () => reject(new Error("Could not decode the image."))
    );
    image.src = dataUrl;
  });
}

function replaceFileExtension(name: string, mimeType: string): string {
  const extension =
    mimeType === "image/jpeg"
      ? ".jpg"
      : mimeType === "image/webp"
        ? ".webp"
        : mimeType === "image/png"
          ? ".png"
          : "";

  if (!extension) {
    return name;
  }

  return /\.[^.]+$/.test(name)
    ? name.replace(/\.[^.]+$/, extension)
    : `${name}${extension}`;
}

function canvasToImageDataUrl(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number
): string {
  const dataUrl = canvas.toDataURL(mimeType, quality);
  return dataUrl.startsWith(`data:${mimeType};`) ? dataUrl : "";
}

export type StreamAttachmentMetadata = {
  streamuiImage?: ImageAttachment;
  streamuiFile?: UploadedSessionFile;
  streamuiSessionId?: string;
};

type StreamPendingAttachment = PendingAttachment & StreamAttachmentMetadata;
type StreamCompleteAttachment = CompleteAttachment & StreamAttachmentMetadata;

export type StreamImageAttachmentAdapterOptions = {
  getSessionId(): string;
  uploadImage(
    sessionId: string,
    attachment: ImageAttachment
  ): Promise<UploadedSessionFile>;
  deleteFile?(sessionId: string, fileId: string): Promise<void>;
  onUploadStart?(attachmentId: string, sessionId: string): void;
  onUploadComplete?(attachmentId: string): void;
  onUploadError?(attachmentId: string): void;
  onRemoveStart?(attachmentId: string): void;
  onRemoveComplete?(attachmentId: string): void;
  onSend?(attachmentId: string): void;
  prepareImage?(file: File): Promise<ImageAttachment>;
  createPendingId?(): string;
  warn?(message: string, error: unknown): void;
};

async function prepareImageAttachment(file: File): Promise<ImageAttachment> {
  if (
    !SUPPORTED_IMAGE_MIME_TYPES.includes(
      file.type as (typeof SUPPORTED_IMAGE_MIME_TYPES)[number]
    )
  ) {
    throw new Error(`${file.name} is not a supported image type.`);
  }

  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error(`${file.name} is larger than 8 MB.`);
  }

  const originalDataUrl = await readFileAsDataUrl(file);

  if (file.type === "image/gif") {
    return {
      id: createId("image"),
      name: file.name,
      mimeType: file.type,
      size: estimateDataUrlBytes(originalDataUrl),
      dataUrl: originalDataUrl
    };
  }

  const image = await loadImage(originalDataUrl);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.min(
    1,
    MAX_IMAGE_DIMENSION / Math.max(sourceWidth, sourceHeight)
  );

  if (file.size <= TARGET_IMAGE_BYTES && scale === 1) {
    return {
      id: createId("image"),
      name: file.name,
      mimeType: file.type,
      size: estimateDataUrlBytes(originalDataUrl),
      dataUrl: originalDataUrl,
      width: sourceWidth,
      height: sourceHeight
    };
  }

  if (file.type === "image/png" && scale === 1) {
    return {
      id: createId("image"),
      name: file.name,
      mimeType: file.type,
      size: estimateDataUrlBytes(originalDataUrl),
      dataUrl: originalDataUrl,
      width: sourceWidth,
      height: sourceHeight
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error(`Could not prepare ${file.name}.`);
  }

  if (file.type === "image/jpeg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    context.clearRect(0, 0, canvas.width, canvas.height);
  }
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const outputMimeType = file.type;
  let dataUrl = "";

  if (QUALITY_COMPRESSIBLE_IMAGE_MIME_TYPES.has(outputMimeType)) {
    let quality = 0.9;
    dataUrl = canvasToImageDataUrl(canvas, outputMimeType, quality);
    while (
      dataUrl &&
      estimateDataUrlBytes(dataUrl) > TARGET_IMAGE_BYTES &&
      quality > 0.62
    ) {
      quality -= 0.08;
      dataUrl = canvasToImageDataUrl(canvas, outputMimeType, quality);
    }
  } else {
    dataUrl = canvasToImageDataUrl(canvas, outputMimeType);
  }

  if (!dataUrl) {
    return {
      id: createId("image"),
      name: file.name,
      mimeType: file.type,
      size: estimateDataUrlBytes(originalDataUrl),
      dataUrl: originalDataUrl,
      width: sourceWidth,
      height: sourceHeight
    };
  }

  return {
    id: createId("image"),
    name: replaceFileExtension(file.name, outputMimeType),
    mimeType: outputMimeType,
    size: estimateDataUrlBytes(dataUrl),
    dataUrl,
    width: canvas.width,
    height: canvas.height
  };
}

export function completeAttachmentToImage(
  attachment: CompleteAttachment
): ImageAttachment | null {
  const streamAttachment = attachment as StreamCompleteAttachment;
  if (streamAttachment.streamuiImage) {
    return streamAttachment.streamuiSessionId &&
      streamAttachment.streamuiImage.ownerSessionId !==
        streamAttachment.streamuiSessionId
      ? {
          ...streamAttachment.streamuiImage,
          ownerSessionId: streamAttachment.streamuiSessionId
        }
      : streamAttachment.streamuiImage;
  }

  const imagePart = attachment.content.find((part) => part.type === "image");
  if (!imagePart || imagePart.type !== "image") {
    return null;
  }

  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.contentType ?? "image/png",
    size: estimateDataUrlBytes(imagePart.image),
    dataUrl: imagePart.image,
    sessionFile: streamAttachment.streamuiFile,
    ...(streamAttachment.streamuiSessionId
      ? { ownerSessionId: streamAttachment.streamuiSessionId }
      : {})
  };
}

export function imageAttachmentToCompleteAttachment(
  attachment: ImageAttachment
): CompleteAttachment {
  return {
    id: attachment.id,
    type: "image",
    name: attachment.name,
    contentType: attachment.mimeType,
    status: { type: "complete" },
    content: [
      {
        type: "image",
        image: attachment.dataUrl,
        filename: attachment.name
      }
    ],
    streamuiImage: attachment,
    streamuiFile: attachment.sessionFile,
    ...(attachment.ownerSessionId
      ? { streamuiSessionId: attachment.ownerSessionId }
      : {})
  } as StreamCompleteAttachment;
}

type PendingUploadLifecycle = {
  ownerSessionId?: string;
  cancelled: boolean;
  removalStarted: boolean;
  removalFinished: boolean;
  removalPromise: Promise<void>;
  resolveRemoval(): void;
};

function createPendingUploadLifecycle(
  ownerSessionId: string | undefined
): PendingUploadLifecycle {
  let resolveRemoval!: () => void;
  const removalPromise = new Promise<void>((resolve) => {
    resolveRemoval = resolve;
  });
  return {
    ownerSessionId,
    cancelled: false,
    removalStarted: false,
    removalFinished: false,
    removalPromise,
    resolveRemoval
  };
}

export class StreamImageAttachmentAdapter implements AttachmentAdapter {
  accept = SUPPORTED_IMAGE_MIME_TYPES.join(",");
  private readonly pendingUploads = new Map<string, PendingUploadLifecycle>();

  constructor(private readonly options?: StreamImageAttachmentAdapterOptions) {}

  private warn(message: string, error: unknown): void {
    const warn = this.options?.warn;
    if (warn) {
      warn(message, error);
      return;
    }
    console.warn(message, error);
  }

  private finishPendingRemoval(
    attachmentId: string,
    lifecycle: PendingUploadLifecycle
  ): void {
    if (this.pendingUploads.get(attachmentId) === lifecycle) {
      this.pendingUploads.delete(attachmentId);
    }
    if (!lifecycle.removalStarted || lifecycle.removalFinished) {
      return;
    }

    lifecycle.removalFinished = true;
    this.options?.onRemoveComplete?.(attachmentId);
    lifecycle.resolveRemoval();
  }

  private async deleteDraftFile(
    ownerSessionId: string | undefined,
    fileId: string
  ): Promise<void> {
    if (!this.options?.deleteFile) {
      return;
    }
    if (!ownerSessionId) {
      this.warn(
        "Could not delete draft image upload.",
        new Error("Could not determine the attachment session.")
      );
      return;
    }

    try {
      await this.options.deleteFile(ownerSessionId, fileId);
    } catch (error) {
      this.warn("Could not delete draft image upload.", error);
    }
  }

  async *add({
    file
  }: {
    file: File;
  }): AsyncGenerator<PendingAttachment, void> {
    if (
      !SUPPORTED_IMAGE_MIME_TYPES.includes(
        file.type as (typeof SUPPORTED_IMAGE_MIME_TYPES)[number]
      )
    ) {
      throw new Error(`${file.name} is not a supported image type.`);
    }

    if (file.size > MAX_SOURCE_IMAGE_BYTES) {
      throw new Error(`${file.name} is larger than 8 MB.`);
    }

    const id = this.options?.createPendingId?.() ?? createId("pending-image");
    const ownerSessionId = this.options?.getSessionId();
    if (this.options && !ownerSessionId) {
      throw new Error("Could not determine the attachment session.");
    }
    const lifecycle = createPendingUploadLifecycle(ownerSessionId);
    this.pendingUploads.set(id, lifecycle);
    this.options?.onUploadStart?.(id, ownerSessionId ?? "");
    yield {
      id,
      type: "image",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "running", reason: "uploading", progress: 0 },
      streamuiSessionId: ownerSessionId
    } as StreamPendingAttachment;

    try {
      const prepared = await (
        this.options?.prepareImage ?? prepareImageAttachment
      )(file);
      if (lifecycle.cancelled) {
        this.finishPendingRemoval(id, lifecycle);
        return;
      }

      const uploaded = this.options
        ? await this.options.uploadImage(ownerSessionId ?? "", prepared)
        : undefined;
      if (lifecycle.cancelled) {
        if (uploaded) {
          await this.deleteDraftFile(ownerSessionId, uploaded.id);
        }
        this.finishPendingRemoval(id, lifecycle);
        return;
      }

      const image = uploaded
        ? {
            ...prepared,
            id: uploaded.id,
            name: uploaded.name,
            mimeType: uploaded.mimeType,
            size: uploaded.size,
            width: uploaded.width ?? prepared.width,
            height: uploaded.height ?? prepared.height,
            sessionFile: uploaded,
            ownerSessionId
          }
        : { ...prepared, ownerSessionId };

      this.pendingUploads.delete(id);
      this.options?.onUploadComplete?.(id);
      yield {
        id,
        type: "image",
        name: image.name,
        contentType: image.mimeType,
        file,
        status: { type: "requires-action", reason: "composer-send" },
        content: [
          {
            type: "image",
            image: image.dataUrl,
            filename: image.name
          }
        ],
        streamuiImage: image,
        streamuiFile: image.sessionFile,
        streamuiSessionId: ownerSessionId
      } as StreamPendingAttachment;
    } catch (error) {
      if (lifecycle.cancelled) {
        this.finishPendingRemoval(id, lifecycle);
        return;
      }
      this.pendingUploads.delete(id);
      this.options?.onUploadError?.(id);
      throw error;
    }
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const streamAttachment = attachment as StreamPendingAttachment;
    const ownerSessionId =
      streamAttachment.streamuiSessionId ??
      streamAttachment.streamuiImage?.ownerSessionId ??
      this.options?.getSessionId();
    if (this.options && !ownerSessionId) {
      throw new Error("Could not determine the attachment session.");
    }

    if (streamAttachment.streamuiImage) {
      const image = ownerSessionId
        ? { ...streamAttachment.streamuiImage, ownerSessionId }
        : streamAttachment.streamuiImage;
      const complete = imageAttachmentToCompleteAttachment(image);
      this.options?.onSend?.(attachment.id);
      return complete;
    }

    const prepared = await (
      this.options?.prepareImage ?? prepareImageAttachment
    )(attachment.file);
    const uploaded = this.options
      ? await this.options.uploadImage(ownerSessionId ?? "", prepared)
      : undefined;
    const image = uploaded
      ? {
          ...prepared,
          id: uploaded.id,
          name: uploaded.name,
          mimeType: uploaded.mimeType,
          size: uploaded.size,
          width: uploaded.width ?? prepared.width,
          height: uploaded.height ?? prepared.height,
          sessionFile: uploaded,
          ownerSessionId
        }
      : { ...prepared, ownerSessionId };

    const complete = imageAttachmentToCompleteAttachment(image);
    this.options?.onSend?.(attachment.id);
    return complete;
  }

  async remove(attachment: PendingAttachment | CompleteAttachment): Promise<void> {
    const streamAttachment = attachment as StreamAttachmentMetadata;
    const fileId = streamAttachment.streamuiFile?.id;
    const ownerSessionId =
      streamAttachment.streamuiSessionId ??
      streamAttachment.streamuiImage?.ownerSessionId ??
      this.options?.getSessionId();
    const lifecycle = this.pendingUploads.get(attachment.id);
    if (lifecycle) {
      lifecycle.cancelled = true;
      if (!lifecycle.removalStarted) {
        lifecycle.removalStarted = true;
        this.options?.onRemoveStart?.(attachment.id);
      }
      await lifecycle.removalPromise;
      return;
    }

    this.options?.onRemoveStart?.(attachment.id);
    try {
      if (!fileId) {
        return;
      }
      await this.deleteDraftFile(ownerSessionId, fileId);
    } finally {
      this.options?.onRemoveComplete?.(attachment.id);
    }
  }
}

export { MAX_IMAGE_ATTACHMENTS };
