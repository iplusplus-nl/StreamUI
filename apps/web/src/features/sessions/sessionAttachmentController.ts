import type {
  ImageAttachment,
  UploadedSessionFile
} from "../../core/imageAttachments";
import type { SessionFile } from "../../domain/chat/sessionModel";
import {
  deleteSessionFile,
  uploadSessionFile
} from "./sessionApi";
import { imageAttachmentToFileUpload } from "./sessionFileModel";

export type AttachmentGateRecord = {
  sessionId: string;
  status: "uploading" | "ready" | "failed" | "removing";
};

export type AttachmentGateState = {
  records: Readonly<Record<string, AttachmentGateRecord>>;
};

export type AttachmentGateEvent =
  | { type: "start"; attachmentId: string; sessionId: string }
  | { type: "complete"; attachmentId: string }
  | { type: "fail"; attachmentId: string }
  | { type: "remove-start"; attachmentId: string }
  | { type: "remove-complete"; attachmentId: string }
  | { type: "consume"; attachmentId: string };

export const initialAttachmentGateState: AttachmentGateState = {
  records: {}
};

function removeRecord(
  state: AttachmentGateState,
  attachmentId: string
): AttachmentGateState {
  if (!state.records[attachmentId]) {
    return state;
  }

  const records = { ...state.records };
  delete records[attachmentId];
  return { records };
}

export function reduceAttachmentGate(
  state: AttachmentGateState,
  event: AttachmentGateEvent
): AttachmentGateState {
  if (event.type === "start") {
    const current = state.records[event.attachmentId];
    if (
      current?.status === "uploading" &&
      current.sessionId === event.sessionId
    ) {
      return state;
    }

    return {
      records: {
        ...state.records,
        [event.attachmentId]: {
          sessionId: event.sessionId,
          status: "uploading"
        }
      }
    };
  }

  if (event.type === "remove-complete" || event.type === "consume") {
    return removeRecord(state, event.attachmentId);
  }

  if (event.type === "remove-start") {
    const current = state.records[event.attachmentId];
    if (!current || current.status === "removing") {
      return state;
    }

    return {
      records: {
        ...state.records,
        [event.attachmentId]: {
          ...current,
          status: "removing"
        }
      }
    };
  }

  const current = state.records[event.attachmentId];
  if (!current || current.status !== "uploading") {
    return state;
  }

  return {
    records: {
      ...state.records,
      [event.attachmentId]: {
        ...current,
        status: event.type === "complete" ? "ready" : "failed"
      }
    }
  };
}

export type AttachmentGateSummary = {
  inFlightCount: number;
  removingCount: number;
  failedAttachmentIds: string[];
  isSendBlocked: boolean;
  hasComposerDrafts: boolean;
};

export function summarizeAttachmentGate(
  state: AttachmentGateState
): AttachmentGateSummary {
  let inFlightCount = 0;
  let removingCount = 0;
  const failedAttachmentIds: string[] = [];

  for (const [attachmentId, record] of Object.entries(state.records)) {
    if (record.status === "uploading") {
      inFlightCount += 1;
    } else if (record.status === "removing") {
      removingCount += 1;
    } else if (record.status === "failed") {
      failedAttachmentIds.push(attachmentId);
    }
  }

  return {
    inFlightCount,
    removingCount,
    failedAttachmentIds,
    isSendBlocked:
      inFlightCount > 0 ||
      removingCount > 0 ||
      failedAttachmentIds.length > 0,
    hasComposerDrafts: Object.keys(state.records).length > 0
  };
}

export type SessionAttachmentFileDependencies = {
  uploadFile(
    sessionId: string,
    input: Parameters<typeof uploadSessionFile>[1],
    clientId: string
  ): Promise<SessionFile>;
  deleteFile(
    sessionId: string,
    fileId: string,
    clientId: string
  ): Promise<void>;
};

export type SessionAttachmentFileService = {
  uploadImage(
    sessionId: string,
    attachment: ImageAttachment
  ): Promise<UploadedSessionFile>;
  deleteFile(sessionId: string, fileId: string): Promise<void>;
};

const defaultFileDependencies: SessionAttachmentFileDependencies = {
  uploadFile: uploadSessionFile,
  deleteFile: deleteSessionFile
};

export function createSessionAttachmentFileService(
  getClientId: () => string,
  dependencyOverrides: Partial<SessionAttachmentFileDependencies> = {}
): SessionAttachmentFileService {
  const dependencies = {
    ...defaultFileDependencies,
    ...dependencyOverrides
  };

  return {
    async uploadImage(sessionId, attachment) {
      const file = await dependencies.uploadFile(
        sessionId,
        imageAttachmentToFileUpload(attachment, undefined, true),
        getClientId()
      );
      if (file.kind !== "image") {
        throw new Error("Image upload returned a non-image file.");
      }
      return file as UploadedSessionFile;
    },

    deleteFile(sessionId, fileId) {
      return dependencies.deleteFile(sessionId, fileId, getClientId());
    }
  };
}
