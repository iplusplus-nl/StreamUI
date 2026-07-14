import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { Check, ChevronDown, ChevronRight, Search } from "lucide-react";
import {
  UI_COMPLEXITY_LEVEL_OPTIONS,
  getUiComplexityLevel,
  type ReasoningEffort
} from "../core/apiSettings";
import {
  CHAT_REASONING_OPTIONS,
  getChatReasoningIndex,
  getChatReasoningLabel
} from "./chatModelSelectorModel";
import { isEscapeDismissKey } from "./dismissalModel";

type ChatModelSelectorProps = {
  model: string;
  modelOptions: string[];
  reasoningEffort: ReasoningEffort;
  uiComplexity: number;
  disabled?: boolean;
  onModelChange(model: string): void;
  onReasoningEffortChange(reasoningEffort: ReasoningEffort): void;
  onUiComplexityChange(uiComplexity: number): void;
};

const REASONING_MAX_INDEX = CHAT_REASONING_OPTIONS.length - 1;
const UI_COMPLEXITY_MAX_INDEX = UI_COMPLEXITY_LEVEL_OPTIONS.length - 1;

function getDisplayModelName(model: string): string {
  const trimmed = model.trim();
  const lastSegment = trimmed.split("/").filter(Boolean).pop();

  return lastSegment || trimmed || "Model";
}

function clampSliderIndex(value: string, maxIndex: number): number {
  const index = Number.parseInt(value, 10);
  if (!Number.isFinite(index)) {
    return 0;
  }

  return Math.min(maxIndex, Math.max(0, index));
}

function getSliderStyle(value: number, min: number, max: number): CSSProperties {
  const range = Math.max(1, max - min);
  const ratio = Math.min(1, Math.max(0, (value - min) / range));
  const progress = ratio * 100;
  const thumbSize = 18;
  const centerOffset = thumbSize / 2 - ratio * thumbSize;

  return {
    "--slider-progress": `${progress}%`,
    "--slider-fill": `calc(${progress}% + ${centerOffset.toFixed(2)}px)`
  } as CSSProperties;
}

export function ChatModelSelector({
  model,
  modelOptions,
  reasoningEffort,
  uiComplexity,
  disabled = false,
  onModelChange,
  onReasoningEffortChange,
  onUiComplexityChange
}: ChatModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const closeModelMenuTimeoutRef = useRef<number | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const reasoningLabel = getChatReasoningLabel(reasoningEffort);
  const reasoningIndex = getChatReasoningIndex(reasoningEffort);
  const uiComplexityLevel = getUiComplexityLevel(uiComplexity);
  const uiComplexityIndex = UI_COMPLEXITY_LEVEL_OPTIONS.indexOf(uiComplexityLevel);
  const parameterLabel = [reasoningLabel, `UI ${uiComplexityLevel.label}`]
    .filter(Boolean)
    .join(" · ");
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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isEscapeDismissKey(event.key)) {
        return;
      }
      event.preventDefault();
      setIsOpen(false);
      setIsModelMenuOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
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
            <div className="chat-model-slider-block is-reasoning">
              <div className="chat-model-slider-header">
                <span>Reasoning</span>
                <strong>{reasoningLabel || "Off"}</strong>
              </div>
              <div
                className="chat-model-slider-wrap"
                style={getSliderStyle(reasoningIndex, 0, REASONING_MAX_INDEX)}
              >
                <div className="chat-model-slider-ticks" aria-hidden="true">
                  {CHAT_REASONING_OPTIONS.map((option) => (
                    <span key={option.value} />
                  ))}
                </div>
                <input
                  className="chat-model-slider"
                  type="range"
                  min={0}
                  max={REASONING_MAX_INDEX}
                  step={1}
                  value={reasoningIndex}
                  aria-label="Reasoning level"
                  aria-valuetext={reasoningLabel || "Off"}
                  onChange={(event) => {
                    const nextIndex = clampSliderIndex(
                      event.target.value,
                      REASONING_MAX_INDEX
                    );
                    onReasoningEffortChange(
                      CHAT_REASONING_OPTIONS[nextIndex].value
                    );
                  }}
                />
                <span className="chat-model-slider-thumb" aria-hidden="true">
                  <span />
                </span>
              </div>
            </div>
            <div className="chat-model-slider-block is-ui">
              <div className="chat-model-slider-header">
                <span>UI</span>
                <strong>{uiComplexityLevel.label}</strong>
              </div>
              <div
                className="chat-model-slider-wrap"
                style={getSliderStyle(uiComplexityIndex, 0, UI_COMPLEXITY_MAX_INDEX)}
              >
                <div className="chat-model-slider-ticks is-compact" aria-hidden="true">
                  {UI_COMPLEXITY_LEVEL_OPTIONS.map((option) => (
                    <span key={option.label} />
                  ))}
                </div>
                <input
                  className="chat-model-slider"
                  type="range"
                  min={0}
                  max={UI_COMPLEXITY_MAX_INDEX}
                  step={1}
                  value={uiComplexityIndex}
                  aria-label="UI complexity"
                  aria-valuetext={uiComplexityLevel.label}
                  onChange={(event) => {
                    const nextIndex = clampSliderIndex(
                      event.target.value,
                      UI_COMPLEXITY_MAX_INDEX
                    );
                    onUiComplexityChange(
                      UI_COMPLEXITY_LEVEL_OPTIONS[nextIndex].value
                    );
                  }}
                />
                <span className="chat-model-slider-thumb" aria-hidden="true">
                  <span />
                </span>
              </div>
            </div>
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
        {parameterLabel ? (
          <span className="chat-model-button-reasoning">{parameterLabel}</span>
        ) : null}
        <ChevronDown size={14} strokeWidth={2.1} aria-hidden="true" />
      </button>
    </div>
  );
}
