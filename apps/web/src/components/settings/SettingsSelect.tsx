import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { consumeEscapeDismissal } from "../dismissalModel";

export type SettingsSelectOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

type SettingsSelectProps = {
  value: string;
  options: SettingsSelectOption[];
  ariaLabel: string;
  disabled?: boolean;
  onChange(value: string): void;
};

type MenuPosition = {
  style: CSSProperties;
  opensUp: boolean;
};

function getMenuPosition(button: HTMLButtonElement): MenuPosition {
  const rect = button.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(Math.max(rect.width, 248), viewportWidth - 24);
  const left = Math.min(
    Math.max(12, rect.right - width),
    viewportWidth - width - 12
  );
  const spaceBelow = viewportHeight - rect.bottom - 12;
  const spaceAbove = rect.top - 12;
  const opensUp = spaceBelow < 220 && spaceAbove > spaceBelow;
  const available = Math.max(140, (opensUp ? spaceAbove : spaceBelow) - 8);
  const vertical = opensUp
    ? { bottom: viewportHeight - rect.top + 8 }
    : { top: rect.bottom + 8 };

  return {
    opensUp,
    style: {
      ...vertical,
      left,
      width,
      maxHeight: Math.min(320, available)
    }
  };
}

export function SettingsSelect({
  value,
  options,
  ariaLabel,
  disabled = false,
  onChange
}: SettingsSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!isOpen || !buttonRef.current) {
      return undefined;
    }

    const updatePosition = () => {
      if (buttonRef.current) {
        setMenuPosition(getMenuPosition(buttonRef.current));
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!consumeEscapeDismissal(event)) {
        return;
      }
      setIsOpen(false);
      buttonRef.current?.focus();
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const portalTarget = typeof document === "undefined" ? null : document.body;
  const menuTheme =
    rootRef.current?.closest(".settings-overlay")?.getAttribute("data-theme") ??
    "day";

  return (
    <div className="settings-select" ref={rootRef}>
      <button
        ref={buttonRef}
        className="settings-select-trigger"
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        disabled={disabled || !selected}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="settings-select-value">
          {selected?.label ?? "Select"}
        </span>
        <ChevronDown
          className="settings-select-chevron"
          size={17}
          strokeWidth={2}
          aria-hidden="true"
        />
      </button>

      {isOpen && menuPosition && portalTarget
        ? createPortal(
            <div
              ref={menuRef}
              id={listboxId}
              className={`settings-select-menu ${
                menuPosition.opensUp ? "opens-up" : ""
              }`}
              data-theme={menuTheme}
              style={menuPosition.style}
              role="listbox"
              aria-label={ariaLabel}
            >
              {options.map((option) => {
                const isSelected = option.value === value;
                return (
                  <button
                    className={`settings-select-option ${
                      isSelected ? "is-selected" : ""
                    }`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={option.disabled}
                    key={option.value}
                    onClick={() => {
                      onChange(option.value);
                      setIsOpen(false);
                      buttonRef.current?.focus();
                    }}
                  >
                    <span className="settings-select-option-copy">
                      <strong>{option.label}</strong>
                      {option.description ? (
                        <small>{option.description}</small>
                      ) : null}
                    </span>
                    {isSelected ? (
                      <Check size={18} strokeWidth={2.2} aria-hidden="true" />
                    ) : null}
                  </button>
                );
              })}
            </div>,
            portalTarget
          )
        : null}
    </div>
  );
}
