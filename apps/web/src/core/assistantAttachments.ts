import type {
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment
} from "@assistant-ui/react";
import {
  MAX_IMAGE_ATTACHMENTS,
  SUPPORTED_IMAGE_MIME_TYPES,
  type ImageAttachment
} from "./imageAttachments";

const MAX_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024;
const TARGET_IMAGE_BYTES = 1.8 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1600;

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

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error(`Could not prepare ${file.name}.`);
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  let quality = 0.9;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (estimateDataUrlBytes(dataUrl) > TARGET_IMAGE_BYTES && quality > 0.62) {
    quality -= 0.08;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }

  return {
    id: createId("image"),
    name: file.name.replace(/\.[^.]+$/, ".jpg"),
    mimeType: "image/jpeg",
    size: estimateDataUrlBytes(dataUrl),
    dataUrl,
    width: canvas.width,
    height: canvas.height
  };
}

export function completeAttachmentToImage(
  attachment: CompleteAttachment
): ImageAttachment | null {
  const imagePart = attachment.content.find((part) => part.type === "image");
  if (!imagePart || imagePart.type !== "image") {
    return null;
  }

  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.contentType ?? "image/png",
    size: estimateDataUrlBytes(imagePart.image),
    dataUrl: imagePart.image
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
    ]
  };
}

export class StreamImageAttachmentAdapter implements AttachmentAdapter {
  accept = SUPPORTED_IMAGE_MIME_TYPES.join(",");

  async add({ file }: { file: File }): Promise<PendingAttachment> {
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

    return {
      id: createId("pending-image"),
      type: "image",
      name: file.name,
      contentType: file.type,
      file,
      status: { type: "requires-action", reason: "composer-send" }
    };
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const prepared = await prepareImageAttachment(attachment.file);

    return {
      id: attachment.id,
      type: "image",
      name: prepared.name,
      contentType: prepared.mimeType,
      status: { type: "complete" },
      content: [
        {
          type: "image",
          image: prepared.dataUrl,
          filename: prepared.name
        }
      ]
    };
  }

  async remove(): Promise<void> {
    return;
  }
}

export { MAX_IMAGE_ATTACHMENTS };
