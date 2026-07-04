import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Search } from "lucide-react";
import type { ReasoningEffort } from "../core/apiSettings";

type ChatModelSelectorProps = {
  model: string;
  modelOptions: string[];
  reasoningEffort: ReasoningEffort;
  disabled?: boolean;
  onModelChange(model: string): void;
  onReasoningEffortChange(reasoningEffort: ReasoningEffort): void;
};

const REASONING_OPTIONS: Array<{
  value: ReasoningEffort;
  label: string;
}> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Ultra" }
];

function getDisplayModelName(model: string): string {
  const trimmed = model.trim();
  const lastSegment = trimmed.split("/").filter(Boolean).pop();

  return lastSegment || trimmed || "Model";
}

function getReasoningLabel(reasoningEffort: ReasoningEffort): string {
  return (
    REASONING_OPTIONS.find((option) => option.value === reasoningEffort)?.label ??
    ""
  );
}

export function ChatModelSelector({
  model,
  modelOptions,
  reasoningEffort,
  disabled = false,
  onModelChange,
  onReasoningEffortChange
}: ChatModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const closeModelMenuTimeoutRef = useRef<number | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const reasoningLabel = getReasoningLabel(reasoningEffort);
  const filteredModels = useMemo(() => {
    if (!normalizedQuery) {
      return modelOptions;
    }

    return modelOptions.filter((option) =>
      option.toLowerCase().includes(normalizedQuery)
    );
  }, [modelOptions, normalizedQuery]);

  const clearModelMenuCloseTimeout = () => {
    if (closeModelMenuTimeoutRef.current !== null) {
      window.clearTimeout(closeModelMenuTimeoutRef.current);
      closeModelMenuTimeoutRef.current = null;
    }
  };

  const scheduleModelMenuClose = () => {
    clearModelMenuCloseTimeout();
    closeModelMenuTimeoutRef.current = window.setTimeout(() => {
      setIsModelMenuOpen(false);
      closeModelMenuTimeoutRef.current = null;
    }, 120);
  };

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
        setIsModelMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      clearModelMenuCloseTimeout();
    };
  }, [isOpen]);

  return (
    <div className="chat-model-selector" ref={rootRef}>
      {isOpen ? (
        <div
          className="chat-model-menu-shell"
          onMouseEnter={clearModelMenuCloseTimeout}
          onMouseLeave={scheduleModelMenuClose}
        >
          {isModelMenuOpen ? (
            <div
              className="chat-model-submenu"
              role="listbox"
              aria-label="Choose model"
              onMouseEnter={() => {
                clearModelMenuCloseTimeout();
                setIsModelMenuOpen(true);
              }}
            >
              {modelOptions.length > 7 ? (
                <label className="chat-model-search">
                  <Search size={14} strokeWidth={2.1} aria-hidden="true" />
                  <input
                    value={query}
                    autoFocus
                    placeholder="Search models"
                    spellCheck={false}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
              ) : null}
              <div className="chat-model-menu-title">Model</div>
              <div className="chat-model-menu-list">
                {filteredModels.length ? (
                  filteredModels.map((option) => {
                    const isSelected = option === model;

                    return (
                      <button
                        key={option}
                        className={`chat-model-option ${
                          isSelected ? "is-selected" : ""
                        }`}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => {
                          onModelChange(option);
                          setIsOpen(false);
                          setIsModelMenuOpen(false);
                        }}
                      >
                        <span>{getDisplayModelName(option)}</span>
                        {isSelected ? (
                          <Check size={17} strokeWidth={2.1} aria-hidden="true" />
                        ) : null}
                      </button>
                    );
                  })
                ) : (
                  <div className="chat-model-empty">No models</div>
                )}
              </div>
            </div>
          ) : null}

          <div className="chat-model-menu" role="menu" aria-label="Model controls">
            <div className="chat-model-menu-title">Reasoning</div>
            {REASONING_OPTIONS.map((option) => {
              const isSelected = option.value === reasoningEffort;

              return (
                <button
                  key={option.value}
                  className={`chat-model-menu-item ${
                    isSelected ? "is-selected" : ""
                  }`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isSelected}
                  onClick={() => onReasoningEffortChange(option.value)}
                >
                  <span>{option.label}</span>
                  {isSelected ? (
                    <Check size={17} strokeWidth={2.1} aria-hidden="true" />
                  ) : null}
                </button>
              );
            })}
            <div className="chat-model-menu-separator" />
            <button
              className="chat-model-menu-item is-parent"
              type="button"
              role="menuitem"
              onMouseEnter={() => {
                clearModelMenuCloseTimeout();
                setIsModelMenuOpen(true);
              }}
              onMouseLeave={scheduleModelMenuClose}
              onFocus={() => setIsModelMenuOpen(true)}
              onClick={() => setIsModelMenuOpen(true)}
            >
              <span>{getDisplayModelName(model)}</span>
              <ChevronRight size={18} strokeWidth={2.1} aria-hidden="true" />
            </button>
          </div>
        </div>
      ) : null}
      <button
        className="chat-model-button"
        type="button"
        disabled={disabled || !modelOptions.length}
        aria-expanded={isOpen}
        aria-label="Choose model"
        onClick={() => {
          setQuery("");
          setIsModelMenuOpen(false);
          setIsOpen((current) => !current);
        }}
      >
        <span>{getDisplayModelName(model)}</span>
        {reasoningLabel ? (
          <span className="chat-model-button-reasoning">{reasoningLabel}</span>
        ) : null}
        <ChevronDown size={14} strokeWidth={2.1} aria-hidden="true" />
      </button>
    </div>
  );
}
