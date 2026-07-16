import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

type UseModalFocusTrapOptions = {
  dialogRef: RefObject<HTMLElement>;
  initialFocusRef?: RefObject<HTMLElement>;
  enabled?: boolean;
};

function isVisibleFocusableElement(element: HTMLElement): boolean {
  return (
    !element.hidden &&
    element.getAttribute("aria-hidden") !== "true" &&
    element.getClientRects().length > 0
  );
}

export function getModalFocusableElements(
  dialog: HTMLElement
): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter(isVisibleFocusableElement);
}

function isOwnedModalFocusPortal(
  dialog: HTMLElement,
  target: Node | null
): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  const portal = target.closest<HTMLElement>("[data-modal-focus-portal]");
  if (!portal?.id) {
    return false;
  }

  return Array.from(
    dialog.querySelectorAll<HTMLElement>("[aria-controls]")
  ).some((control) =>
    (control.getAttribute("aria-controls") ?? "")
      .split(/\s+/)
      .includes(portal.id)
  );
}

export function getFocusWrapTarget<T>(
  focusableElements: readonly T[],
  activeElement: T | null,
  shiftKey: boolean
): T | undefined {
  if (!focusableElements.length) {
    return undefined;
  }

  const activeIndex = activeElement
    ? focusableElements.indexOf(activeElement)
    : -1;
  if (activeIndex < 0) {
    return shiftKey
      ? focusableElements[focusableElements.length - 1]
      : focusableElements[0];
  }
  if (shiftKey && activeIndex === 0) {
    return focusableElements[focusableElements.length - 1];
  }
  if (!shiftKey && activeIndex === focusableElements.length - 1) {
    return focusableElements[0];
  }

  return undefined;
}

export function useModalFocusTrap({
  dialogRef,
  initialFocusRef,
  enabled = true
}: UseModalFocusTrapOptions): void {
  useEffect(() => {
    if (!enabled || typeof document === "undefined") {
      return undefined;
    }

    const dialog = dialogRef.current;
    if (!dialog) {
      return undefined;
    }

    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    let isRedirectingFocus = false;
    const focusInside = (preferLast = false) => {
      const focusableElements = getModalFocusableElements(dialog);
      const requested = initialFocusRef?.current;
      const target =
        requested && dialog.contains(requested) && isVisibleFocusableElement(requested)
          ? requested
          : preferLast
            ? focusableElements[focusableElements.length - 1]
            : focusableElements[0];

      if (target) {
        target.focus({ preventScroll: true });
        return;
      }

      if (!dialog.hasAttribute("tabindex")) {
        dialog.tabIndex = -1;
      }
      dialog.focus({ preventScroll: true });
    };

    const animationFrameId = window.requestAnimationFrame(() => {
      if (!dialog.contains(document.activeElement)) {
        focusInside();
      }
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.defaultPrevented) {
        return;
      }

      const focusableElements = getModalFocusableElements(dialog);
      const activeElement =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      // Portaled listboxes remain part of the modal's logical focus scope even
      // though their DOM node lives under document.body. Their own keyboard
      // handler owns Tab so it can close and move to the adjacent control.
      if (
        activeElement &&
        !dialog.contains(activeElement) &&
        isOwnedModalFocusPortal(dialog, activeElement)
      ) {
        return;
      }
      const target = getFocusWrapTarget(
        focusableElements,
        activeElement,
        event.shiftKey
      );
      if (!target) {
        if (!focusableElements.length) {
          event.preventDefault();
          focusInside(event.shiftKey);
        }
        return;
      }

      event.preventDefault();
      target.focus({ preventScroll: true });
    };

    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (
        !isRedirectingFocus &&
        target instanceof Node &&
        !dialog.contains(target) &&
        !isOwnedModalFocusPortal(dialog, target)
      ) {
        isRedirectingFocus = true;
        try {
          focusInside();
        } finally {
          isRedirectingFocus = false;
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("focusin", handleFocusIn, true);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      if (opener?.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [dialogRef, enabled, initialFocusRef]);
}
