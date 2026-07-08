import { MessagePrimitive } from "@assistant-ui/react";
import { Check, Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { ArtifactEdit, SessionFile } from "../domain/chat/sessionModel";

type ArtifactEditTimeline = {
  assistantId: string;
  edits: ArtifactEdit[];
  activeEditId?: string;
  disabled?: boolean;
};

type ChatMessageProps = {
  id: string;
  role: "user" | "assistant";
  files?: SessionFile[];
  artifactEditTimeline?: ArtifactEditTimeline;
  onEdit?(id: string, content: string): void;
  onSelectArtifactEdit?(assistantId: string, editId?: string): void;
  children: ReactNode;
};

function getArtifactEditDepth(edits: ArtifactEdit[], edit: ArtifactEdit): number {
  const byId = new Map(edits.map((item) => [item.id, item]));
  let depth = 0;
  let parentId = edit.parentId;
  const seen = new Set<string>([edit.id]);

  while (parentId && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) {
      break;
    }
    seen.add(parent.id);
    depth += 1;
    parentId = parent.parentId;
  }

  return Math.min(depth, 4);
}

function ArtifactEditTimelineView({
  timeline,
  onSelectArtifactEdit
}: {
  timeline: ArtifactEditTimeline;
  onSelectArtifactEdit?(assistantId: string, editId?: string): void;
}) {
  const { assistantId, edits, activeEditId, disabled } = timeline;

  if (!edits.length) {
    return null;
  }

  return (
    <div className="artifact-edit-chain" aria-label="Artifact changes">
      <button
        className={`artifact-edit-root ${!activeEditId ? "is-active" : ""}`}
        type="button"
        disabled={disabled || !onSelectArtifactEdit}
        onClick={() => onSelectArtifactEdit?.(assistantId)}
      >
        <span>Original</span>
      </button>
      {edits.map((edit, index) => {
        const activeVariantIndex = Math.max(
          0,
          edit.variants.findIndex((variant) => variant.id === edit.activeVariantId)
        );
        const activeVariant =
          edit.variants[activeVariantIndex] ?? edit.variants[0];
        const variantTotal = Math.max(1, edit.variants.length);
        const depth = getArtifactEditDepth(edits, edit);
        const canSelect =
          edit.status === "complete" &&
          activeVariant?.status === "complete" &&
          Boolean(activeVariant.rawStream) &&
          !disabled &&
          Boolean(onSelectArtifactEdit);
        const style = {
          "--artifact-edit-depth": depth
        } as CSSProperties;

        return (
          <button
            className={`artifact-edit-card is-${edit.status} ${
              activeEditId === edit.id ? "is-active" : ""
            }`}
            key={edit.id}
            type="button"
            style={style}
            disabled={!canSelect}
            onClick={() => onSelectArtifactEdit?.(assistantId, edit.id)}
          >
            <span className="artifact-edit-card-header">
              <span>Change {index + 1}</span>
              <span className="artifact-edit-variant-count">
                {activeVariantIndex + 1}/{variantTotal}
              </span>
            </span>
            <span className="artifact-edit-reference-row">
              {edit.references.slice(0, 3).map((reference) => (
                <span
                  className={`artifact-edit-reference is-${reference.kind}`}
                  key={reference.key}
                >
                  {reference.kind === "text" ? "Reference" : reference.label}
                </span>
              ))}
              {edit.references.length > 3 ? (
                <span className="artifact-edit-reference">
                  +{edit.references.length - 3}
                </span>
              ) : null}
            </span>
            <span className="artifact-edit-prompt">{edit.prompt}</span>
            {edit.status === "pending" ? (
              <span className="artifact-edit-status">Editing...</span>
            ) : null}
            {edit.status === "error" && (edit.error || activeVariant?.error) ? (
              <span className="artifact-edit-status is-error">
                {edit.error || activeVariant?.error}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function ChatMessage({
  id,
  role,
  files = [],
  artifactEditTimeline,
  onEdit,
  onSelectArtifactEdit,
  children
}: ChatMessageProps) {
  const text = typeof children === "string" ? children : "";
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const canEdit = role === "user" && Boolean(onEdit);
  const normalizedDraft = draft.trim();
  const canSave = normalizedDraft.length > 0 && normalizedDraft !== text.trim();

  useEffect(() => {
    if (!isEditing) {
      setDraft(text);
    }
  }, [isEditing, text]);

  const saveEdit = () => {
    if (!canSave || !onEdit) {
      return;
    }

    onEdit(id, normalizedDraft);
    setIsEditing(false);
  };

  return (
    <MessagePrimitive.Root className={`chat-row ${role}`}>
      <div className="avatar" aria-hidden="true">
        {role === "user" ? "U" : "S"}
      </div>
      <div className="user-message-shell">
        <div className={`message-bubble ${role} ${isEditing ? "is-editing" : ""}`}>
          {isEditing ? (
            <>
              <textarea
                className="message-edit-input"
                value={draft}
                rows={Math.max(2, Math.min(8, draft.split(/\r?\n/).length + 1))}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
              />
              <div className="message-edit-actions">
                <button
                  className="message-action-button"
                  type="button"
                  title="Cancel edit"
                  aria-label="Cancel edit"
                  onClick={() => {
                    setDraft(text);
                    setIsEditing(false);
                  }}
                >
                  <X size={15} strokeWidth={2.2} aria-hidden="true" />
                </button>
                <button
                  className="message-action-button"
                  type="button"
                  title="Save edit"
                  aria-label="Save edit"
                  disabled={!canSave}
                  onClick={saveEdit}
                >
                  <Check size={15} strokeWidth={2.2} aria-hidden="true" />
                </button>
              </div>
            </>
          ) : (
            <>
              {children ? <p>{children}</p> : null}
              {files.length > 0 ? (
                <div className="message-attachments" aria-label="Attached files">
                  {files.map((file) =>
                    file.kind === "image" && (file.embedUrl || file.dataUrl) ? (
                      <img
                        key={file.id}
                        src={file.embedUrl || file.dataUrl}
                        alt={file.name}
                        loading="lazy"
                      />
                    ) : (
                      <span className="message-file-chip" key={file.id}>
                        {file.name}
                      </span>
                    )
                  )}
                </div>
              ) : null}
            </>
          )}
        </div>
        {canEdit && !isEditing ? (
          <button
            className="message-action-button user-edit-button"
            type="button"
            title="Edit message"
            aria-label="Edit message"
            onClick={() => setIsEditing(true)}
          >
            <Pencil size={14} strokeWidth={2.15} aria-hidden="true" />
          </button>
        ) : null}
        {artifactEditTimeline ? (
          <ArtifactEditTimelineView
            timeline={artifactEditTimeline}
            onSelectArtifactEdit={onSelectArtifactEdit}
          />
        ) : null}
      </div>
    </MessagePrimitive.Root>
  );
}
