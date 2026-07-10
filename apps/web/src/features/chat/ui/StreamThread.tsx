import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { AuiIf, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { AssistantMessage } from "../../../components/AssistantMessage";
import { ChatInput } from "../../../components/ChatInput";
import { ChatMessage } from "../../../components/ChatMessage";
import type { ThemeMode } from "../../../components/SessionSidebar";
import type { ReasoningEffort } from "../../../core/apiSettings";
import type { ArtifactSelection } from "../../../core/artifactSelection";
import {
  type ClientMessage,
  type SessionFile
} from "../../../domain/chat/sessionModel";
import type {
  RenderError,
  RenderSnapshot,
  StreamUiAction
} from "../../../runtime/streamui/types";
import {
  getArtifactVersionInfo,
  getPendingArtifactEditReferences,
} from "../../artifacts/artifactEditModel";
import type { MessageBranchInfo } from "../branching";
import { ThinkingActivityPanel } from "./ThinkingActivityPanel";
import {
  buildArtifactEditTimelineByUserId,
  canShowReasoningActivity
} from "./streamThreadModel";
import { useArtifactSelectionController } from "./useArtifactSelectionController";

export type StreamThreadProps = {
  activeSessionId: string;
  messages: ClientMessage[];
  files: SessionFile[];
  getBranchInfo(messageId: string): MessageBranchInfo | undefined;
  themeMode: ThemeMode;
  showRawStream: boolean;
  artifactEditingEnabled: boolean;
  model: string;
  modelOptions: string[];
  reasoningEffort: ReasoningEffort;
  uiComplexity: number;
  artifactSelectionClearVersion: number;
  artifactSelectionClearMessageId?: string;
  onRuntimeError(id: string, error: RenderError): void;
  onArtifactAction(id: string, action: StreamUiAction): void;
  onVisualRepairAssistant(id: string, snapshot: RenderSnapshot, width: number): void;
  onRegenerateAssistant(id: string): void;
  onEditUserMessage(id: string, content: string): void;
  onSelectBranch(groupId: string, variantId: string): void;
  onSelectArtifactEdit(assistantId: string, editId?: string): void;
  onEditArtifactEditPrompt(
    assistantId: string,
    editId: string,
    prompt: string
  ): boolean;
  onArtifactSelectionsChange(selections: ArtifactSelection[]): void;
  onModelChange(model: string): void;
  onReasoningEffortChange(reasoningEffort: ReasoningEffort): void;
  onUiComplexityChange(uiComplexity: number): void;
};

const SESSION_OUTPUT_SCROLL_SETTLE_MS = 900;
const SESSION_OUTPUT_SCROLL_RETRY_MS = [0, 80, 240, 520];
const AUTO_SCROLL_BOTTOM_THRESHOLD = 160;
const THINKING_ACTIVITY_ANIMATION_MS = 220;

function isNearScrollBottom(viewport: HTMLElement): boolean {
  return (
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <=
    AUTO_SCROLL_BOTTOM_THRESHOLD
  );
}

function scrollToBottom(viewport: HTMLElement): void {
  viewport.scrollTo({
    top: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
    behavior: "auto"
  });
}

function scrollToLastOutputStart(viewport: HTMLElement): boolean {
  const outputs = Array.from(
    viewport.querySelectorAll<HTMLElement>(".assistant-canvas")
  );
  const assistantRows = Array.from(
    viewport.querySelectorAll<HTMLElement>(".chat-row.assistant")
  );
  const target =
    outputs[outputs.length - 1] ?? assistantRows[assistantRows.length - 1];

  if (!target) {
    return false;
  }

  const viewportRect = viewport.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const paddingTop = Number.parseFloat(getComputedStyle(viewport).paddingTop) || 0;
  const top =
    viewport.scrollTop + targetRect.top - viewportRect.top - paddingTop;

  viewport.scrollTo({ top: Math.max(0, top), behavior: "auto" });
  return true;
}

export function StreamThread({
  activeSessionId,
  messages,
  files,
  getBranchInfo,
  themeMode,
  showRawStream,
  artifactEditingEnabled,
  model,
  modelOptions,
  reasoningEffort,
  uiComplexity,
  artifactSelectionClearVersion,
  artifactSelectionClearMessageId,
  onRuntimeError,
  onArtifactAction,
  onVisualRepairAssistant,
  onRegenerateAssistant,
  onEditUserMessage,
  onSelectBranch,
  onSelectArtifactEdit,
  onEditArtifactEditPrompt,
  onArtifactSelectionsChange,
  onModelChange,
  onReasoningEffortChange,
  onUiComplexityChange
}: StreamThreadProps) {
  const isNewChat = useAuiState((state) => state.thread.messages.length === 0);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowBottomRef = useRef(true);
  const reasoningActivityCloseTimerRef = useRef<number | null>(null);
  const [composerFooterElement, setComposerFooterElement] =
    useState<HTMLDivElement | null>(null);
  const lastAutoScrollTargetRef = useRef<{
    count: number;
    lastMessageId: string;
  }>({ count: 0, lastMessageId: "" });
  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages]
  );
  const hasStreamingMessage = useMemo(
    () => messages.some((message) => message.status === "streaming"),
    [messages]
  );
  const fileById = useMemo(
    () => new Map(files.map((file) => [file.id, file])),
    [files]
  );
  const [activeReasoningMessageId, setActiveReasoningMessageId] = useState<
    string | null
  >(null);
  const [isReasoningActivityClosing, setIsReasoningActivityClosing] =
    useState(false);
  const activeReasoningMessage = activeReasoningMessageId
    ? messageById.get(activeReasoningMessageId)
    : undefined;
  const showReasoningActivity = canShowReasoningActivity(
    activeReasoningMessage
  );
  const isReasoningActivityOpen =
    Boolean(showReasoningActivity) && !isReasoningActivityClosing;
  const visibleMessageIds = useMemo(
    () => new Set(messages.map((message) => message.id)),
    [messages]
  );
  const artifactEditTimelineByUserId = useMemo(
    () => buildArtifactEditTimelineByUserId(messages),
    [messages]
  );

  const clearReasoningActivityCloseTimer = useCallback(() => {
    if (reasoningActivityCloseTimerRef.current !== null) {
      window.clearTimeout(reasoningActivityCloseTimerRef.current);
      reasoningActivityCloseTimerRef.current = null;
    }
  }, []);

  const openReasoningActivity = useCallback(
    (messageId: string) => {
      clearReasoningActivityCloseTimer();
      setActiveReasoningMessageId(messageId);
      setIsReasoningActivityClosing(false);
    },
    [clearReasoningActivityCloseTimer]
  );

  const closeReasoningActivity = useCallback(() => {
    if (!activeReasoningMessageId) {
      return;
    }

    clearReasoningActivityCloseTimer();
    setIsReasoningActivityClosing(true);
    reasoningActivityCloseTimerRef.current = window.setTimeout(() => {
      setActiveReasoningMessageId(null);
      setIsReasoningActivityClosing(false);
      reasoningActivityCloseTimerRef.current = null;
    }, THINKING_ACTIVITY_ANIMATION_MS);
  }, [activeReasoningMessageId, clearReasoningActivityCloseTimer]);

  useEffect(() => {
    return clearReasoningActivityCloseTimer;
  }, [clearReasoningActivityCloseTimer]);

  const artifactSelection = useArtifactSelectionController({
    activeSessionId,
    messageById,
    visibleMessageIds,
    artifactEditingEnabled,
    clearVersion: artifactSelectionClearVersion,
    clearMessageId: artifactSelectionClearMessageId,
    onChange: onArtifactSelectionsChange
  });

  useEffect(() => {
    clearReasoningActivityCloseTimer();
    setActiveReasoningMessageId(null);
    setIsReasoningActivityClosing(false);
  }, [activeSessionId, clearReasoningActivityCloseTimer]);

  useEffect(() => {
    setActiveReasoningMessageId((current) => {
      if (!current || !visibleMessageIds.has(current)) {
        if (current) {
          clearReasoningActivityCloseTimer();
          setIsReasoningActivityClosing(false);
        }
        return null;
      }

      if (!canShowReasoningActivity(messageById.get(current))) {
        clearReasoningActivityCloseTimer();
        setIsReasoningActivityClosing(false);
        return null;
      }
      return current;
    });
  }, [clearReasoningActivityCloseTimer, messageById, visibleMessageIds]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const footer = composerFooterElement;

    if (!viewport || !footer) {
      return undefined;
    }

    const updateComposerFooterHeight = () => {
      viewport.style.setProperty(
        "--composer-footer-height",
        `${Math.ceil(footer.getBoundingClientRect().height)}px`
      );
    };

    updateComposerFooterHeight();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateComposerFooterHeight);
    resizeObserver?.observe(footer);
    window.addEventListener("resize", updateComposerFooterHeight);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateComposerFooterHeight);
      viewport.style.removeProperty("--composer-footer-height");
    };
  }, [composerFooterElement]);

  useEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport || !hasStreamingMessage) {
      return undefined;
    }

    const timeoutIds: number[] = [];
    const animationFrameId = window.requestAnimationFrame(() => {
      scrollToLastOutputStart(viewport);
    });

    SESSION_OUTPUT_SCROLL_RETRY_MS.forEach((delay) => {
      timeoutIds.push(
        window.setTimeout(() => scrollToLastOutputStart(viewport), delay)
      );
    });

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => scrollToLastOutputStart(viewport));

    if (resizeObserver) {
      viewport
        .querySelectorAll<HTMLElement>(
          ".chat-row, .assistant-canvas, .preview-frame"
        )
        .forEach((element) => resizeObserver.observe(element));
    }

    const settleTimeoutId = window.setTimeout(() => {
      resizeObserver?.disconnect();
    }, SESSION_OUTPUT_SCROLL_SETTLE_MS);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
      window.clearTimeout(settleTimeoutId);
      resizeObserver?.disconnect();
    };
  }, [activeSessionId, hasStreamingMessage]);

  useEffect(() => {
    const viewport = viewportRef.current;

    if (!viewport) {
      return undefined;
    }

    const handleScroll = () => {
      shouldFollowBottomRef.current = isNearScrollBottom(viewport);
    };

    handleScroll();
    viewport.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      viewport.removeEventListener("scroll", handleScroll);
    };
  }, [activeSessionId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const lastMessage = messages[messages.length - 1];
    const isNewMessageTarget =
      lastAutoScrollTargetRef.current.count !== messages.length ||
      lastAutoScrollTargetRef.current.lastMessageId !== (lastMessage?.id ?? "");
    lastAutoScrollTargetRef.current = {
      count: messages.length,
      lastMessageId: lastMessage?.id ?? ""
    };

    if (
      !viewport ||
      !shouldFollowBottomRef.current ||
      !hasStreamingMessage ||
      !isNewMessageTarget
    ) {
      return undefined;
    }

    const animationFrameId = window.requestAnimationFrame(() => {
      if (shouldFollowBottomRef.current) {
        scrollToBottom(viewport);
      }
    });

    return () => window.cancelAnimationFrame(animationFrameId);
  }, [activeSessionId, messages]);

  return (
    <ThreadPrimitive.Root
      className={`thread-root ${isNewChat ? "is-new" : "has-messages"} ${
        showReasoningActivity ? "has-thinking-activity" : ""
      } ${
        isReasoningActivityOpen ? "is-thinking-activity-open" : ""
      }`}
    >
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        className={`message-list ${isNewChat ? "is-new" : "has-messages"}`}
        autoScroll={false}
        scrollToBottomOnRunStart={false}
        scrollToBottomOnInitialize={false}
        scrollToBottomOnThreadSwitch={false}
      >
        <AuiIf condition={(state) => state.thread.messages.length === 0}>
          <section className="thread-welcome">
            <p>ChatHTML Runtime</p>
            <h2>How can I help you today?</h2>
          </section>
        </AuiIf>
        <ThreadPrimitive.Messages>
          {({ message }) => {
            const clientMessage = messageById.get(message.id);
            if (!clientMessage) {
              return null;
            }

            if (clientMessage.role === "assistant") {
              const branchInfo = getBranchInfo(clientMessage.id);
              const artifactVersionInfo =
                getArtifactVersionInfo(clientMessage);
              return (
                <AssistantMessage
                  id={clientMessage.id}
                  content={clientMessage.content}
                  reasoning={clientMessage.reasoning}
                  rawStream={clientMessage.rawStream}
                  hasStreamUi={clientMessage.hasStreamUi}
                  snapshot={clientMessage.snapshot}
                  runtimeErrors={clientMessage.runtimeErrors}
                  themeMode={themeMode}
                  showRawStream={showRawStream}
                  artifactEditingEnabled={artifactEditingEnabled}
                  status={clientMessage.status}
                  error={clientMessage.error}
                  artifactSelections={
                    artifactSelection.selectionsByMessageId.get(
                      clientMessage.id
                    ) ?? []
                  }
                  artifactBusySelections={
                    getPendingArtifactEditReferences(clientMessage)
                  }
                  isArtifactSelectionModeActive={
                    artifactSelection.selectionModeMessageId ===
                    clientMessage.id
                  }
                  branchInfo={branchInfo}
                  artifactVersionInfo={artifactVersionInfo}
                  activeReasoningMessageId={activeReasoningMessageId ?? undefined}
                  onRuntimeError={onRuntimeError}
                  onArtifactAction={onArtifactAction}
                  onArtifactSelection={artifactSelection.select}
                  onArtifactSelectionModeChange={
                    artifactSelection.toggleMode
                  }
                  onOpenReasoningActivity={openReasoningActivity}
                  onVisualRepair={onVisualRepairAssistant}
                  onRegenerate={onRegenerateAssistant}
                  onSelectBranch={onSelectBranch}
                  onSelectArtifactEdit={onSelectArtifactEdit}
                />
              );
            }

            return (
              <ChatMessage
                id={clientMessage.id}
                role={clientMessage.role}
                files={clientMessage.fileIds
                  ?.map((fileId) => fileById.get(fileId))
                  .filter((file): file is SessionFile => Boolean(file))}
                artifactEditTimeline={artifactEditTimelineByUserId.get(
                  clientMessage.id
                )}
                onEdit={onEditUserMessage}
                onEditArtifactEditPrompt={onEditArtifactEditPrompt}
              >
                {clientMessage.content}
              </ChatMessage>
            );
          }}
        </ThreadPrimitive.Messages>
        <ThreadPrimitive.ViewportFooter
          ref={setComposerFooterElement}
          className={`composer-footer ${isNewChat ? "is-new" : "has-messages"}`}
        >
          <ChatInput
            model={model}
            modelOptions={modelOptions}
            reasoningEffort={reasoningEffort}
            uiComplexity={uiComplexity}
            artifactSelections={artifactSelection.selections}
            onRemoveArtifactSelection={artifactSelection.remove}
            onClearArtifactSelections={artifactSelection.clear}
            onModelChange={onModelChange}
            onReasoningEffortChange={onReasoningEffortChange}
            onUiComplexityChange={onUiComplexityChange}
          />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
      {showReasoningActivity && activeReasoningMessage ? (
        <ThinkingActivityPanel
          message={activeReasoningMessage}
          isClosing={isReasoningActivityClosing}
          onClose={closeReasoningActivity}
        />
      ) : null}
    </ThreadPrimitive.Root>
  );
}
