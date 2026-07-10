import type { ImageAttachment } from "../../core/imageAttachments";
import type {
  ChatSession,
  ClientMessage
} from "../../domain/chat/sessionModel";

export type ChatRunAssistantPhase =
  | "streaming"
  | "complete"
  | "error"
  | "cancelled";

export type SendStreamUiRequestOptions = {
  appendUserMessage?: boolean;
  assistantMessageId?: string;
  generationRunId?: string;
  assistantPatch?: Partial<ClientMessage>;
  persistUserMessage?: ClientMessage;
  userMessagePatch?: Partial<ClientMessage>;
  initialReasoning?: string;
  reduceAssistantPatch?: (
    current: ClientMessage,
    patch: Partial<ClientMessage>,
    phase: ChatRunAssistantPhase
  ) => ClientMessage;
  onAssistantPhaseApplied?: (phase: ChatRunAssistantPhase) => void;
  validateRequestSession?: (session: ChatSession) => boolean;
  requestHistory?:
    | ClientMessage[]
    | ((
        previousMessages: ClientMessage[],
        userMessage: ClientMessage,
        assistantMessage: ClientMessage
      ) => ClientMessage[]);
  targetSessionId?: string;
  branchSelection?: {
    groupId: string;
    variantId: string;
  };
  cancelBranchVariant?: {
    groupId: string;
    variantId: string;
    fallbackVariantId?: string;
  };
  insertMessages?: (
    messages: ClientMessage[],
    userMessage: ClientMessage,
    assistantMessage: ClientMessage
  ) => ClientMessage[];
};

export type SendStreamUiRequest = (
  text: string,
  attachments?: ImageAttachment[],
  options?: SendStreamUiRequestOptions
) => Promise<void>;

export type PendingManagedRequest = {
  text: string;
  attachments: ImageAttachment[];
  options: SendStreamUiRequestOptions;
};
