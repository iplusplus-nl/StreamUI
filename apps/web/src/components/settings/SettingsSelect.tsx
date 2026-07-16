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
import {
  getAdjacentSettingsOptionIndex,
  getInitialSettingsOptionIndex
} from "./settingsSelectModel";

const SETTINGS_SELECT_OPEN_EVENT = "chathtml:settings-select-open";

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
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusIntentRef = useRef<"selected" | "first" | "last">("selected");
  const hasFocusedMenuRef = useRef(false);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value) ?? options[0];

  const openMenu = (intent: "selected" | "first" | "last" = "selected") => {
    focusIntentRef.current = intent;
    hasFocusedMenuRef.current = false;
    window.dispatchEvent(
      new CustomEvent(SETTINGS_SELECT_OPEN_EVENT, { detail: listboxId })
    );
    setIsOpen(true);
  };

  const chooseOption = (option: SettingsSelectOption) => {
    if (option.disabled) {
      return;
    }
    onChange(option.value);
    setIsOpen(false);
    buttonRef.current?.focus();
  };

  const focusOption = (index: number) => {
    if (index >= 0) {
      optionRefs.current[index]?.focus();
    }
  };

  const focusNextControl = (reverse: boolean) => {
    const trigger = buttonRef.current;
    if (!trigger) {
      return;
    }
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => !menuRef.current?.contains(element));
    const index = controls.indexOf(trigger);
    controls[index + (reverse ? -1 : 1)]?.focus();
  };

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
    const handleOtherSelectOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== listboxId) {
        setIsOpen(false);
      }
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener(SETTINGS_SELECT_OPEN_EVENT, handleOtherSelectOpen);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener(
        SETTINGS_SELECT_OPEN_EVENT,
        handleOtherSelectOpen
      );
    };
  }, [isOpen, listboxId]);

  useEffect(() => {
    if (!isOpen || !menuPosition || hasFocusedMenuRef.current) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      hasFocusedMenuRef.current = true;
      focusOption(
        getInitialSettingsOptionIndex(
          options,
          value,
          focusIntentRef.current
        )
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, menuPosition, options, value]);

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
        disabled={disabled || !selected || selected.disabled}
        onClick={() => {
          if (isOpen) {
            setIsOpen(false);
            return;
          }
          openMenu();
        }}
        onKeyDown={(event) => {
          const intent =
            event.key === "ArrowUp" || event.key === "End"
              ? "last"
              : event.key === "Home"
                ? "first"
                : "selected";
          if (
            event.key === "Enter" ||
            event.key === " " ||
            event.key === "ArrowDown" ||
            event.key === "ArrowUp" ||
            event.key === "Home" ||
            event.key === "End"
          ) {
            event.preventDefault();
            openMenu(intent);
          }
        }}
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
              data-modal-focus-portal=""
              data-theme={menuTheme}
              style={menuPosition.style}
              role="listbox"
              aria-label={ariaLabel}
            >
              {options.map((option) => {
                const isSelected = option.value === value;
                return (
                  <button
                    ref={(element) => {
                      optionRefs.current[options.indexOf(option)] = element;
                    }}
                    className={`settings-select-option ${
                      isSelected ? "is-selected" : ""
                    }`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={option.disabled}
                    key={option.value}
                    onClick={() => chooseOption(option)}
                    onKeyDown={(event) => {
                      const currentIndex = options.indexOf(option);
                      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        focusOption(
                          getAdjacentSettingsOptionIndex(
                            options,
                            currentIndex,
                            event.key === "ArrowDown" ? 1 : -1
                          )
                        );
                        return;
                      }
                      if (event.key === "Home" || event.key === "End") {
                        event.preventDefault();
                        focusOption(
                          getInitialSettingsOptionIndex(
                            options,
                            value,
                            event.key === "Home" ? "first" : "last"
                          )
                        );
                        return;
                      }
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        chooseOption(option);
                        return;
                      }
                      if (event.key === "Tab") {
                        event.preventDefault();
                        setIsOpen(false);
                        window.requestAnimationFrame(() =>
                          focusNextControl(event.shiftKey)
                        );
                      }
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
