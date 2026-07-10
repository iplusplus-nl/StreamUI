import { useMemo, useReducer, useRef } from "react";
import {
  StreamImageAttachmentAdapter,
  type StreamImageAttachmentAdapterOptions
} from "../../core/assistantAttachments";
import {
  createSessionAttachmentFileService,
  initialAttachmentGateState,
  reduceAttachmentGate,
  summarizeAttachmentGate,
  type SessionAttachmentFileDependencies
} from "./sessionAttachmentController";

type ValueRef<T> = { current: T };

export type SessionAttachmentControllerDependencies = Partial<
  SessionAttachmentFileDependencies
> &
  Pick<
    StreamImageAttachmentAdapterOptions,
    "prepareImage" | "createPendingId" | "warn"
  >;

export type UseSessionAttachmentControllerInput = {
  activeSessionIdRef: ValueRef<string>;
  sessionClientIdRef: ValueRef<string>;
  dependencies?: SessionAttachmentControllerDependencies;
};

export type SessionAttachmentController = {
  adapter: StreamImageAttachmentAdapter;
  inFlightCount: number;
  removingCount: number;
  failedAttachmentIds: string[];
  isSendBlocked: boolean;
  hasComposerDrafts: boolean;
};

export function useSessionAttachmentController({
  activeSessionIdRef,
  sessionClientIdRef,
  dependencies = {}
}: UseSessionAttachmentControllerInput): SessionAttachmentController {
  const dependenciesRef = useRef(dependencies);
  const stableDependencies = dependenciesRef.current;
  const [gateState, dispatch] = useReducer(
    reduceAttachmentGate,
    initialAttachmentGateState
  );
  const fileService = useMemo(
    () =>
      createSessionAttachmentFileService(
        () => sessionClientIdRef.current,
        stableDependencies
      ),
    [sessionClientIdRef, stableDependencies]
  );
  const adapter = useMemo(
    () =>
      new StreamImageAttachmentAdapter({
        getSessionId: () => activeSessionIdRef.current,
        uploadImage: fileService.uploadImage,
        deleteFile: fileService.deleteFile,
        onUploadStart: (attachmentId, sessionId) => {
          dispatch({ type: "start", attachmentId, sessionId });
        },
        onUploadComplete: (attachmentId) => {
          dispatch({ type: "complete", attachmentId });
        },
        onUploadError: (attachmentId) => {
          dispatch({ type: "fail", attachmentId });
        },
        onRemoveStart: (attachmentId) => {
          dispatch({ type: "remove-start", attachmentId });
        },
        onRemoveComplete: (attachmentId) => {
          dispatch({ type: "remove-complete", attachmentId });
        },
        onSend: (attachmentId) => {
          dispatch({ type: "consume", attachmentId });
        },
        prepareImage: stableDependencies.prepareImage,
        createPendingId: stableDependencies.createPendingId,
        warn: stableDependencies.warn
      }),
    [activeSessionIdRef, fileService, stableDependencies]
  );
  const summary = useMemo(
    () => summarizeAttachmentGate(gateState),
    [gateState]
  );

  return {
    adapter,
    ...summary
  };
}
