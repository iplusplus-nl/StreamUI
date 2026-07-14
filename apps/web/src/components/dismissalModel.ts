export function isEscapeDismissKey(key: string): boolean {
  return key === "Escape";
}

export type DismissalKeyboardEvent = {
  key: string;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
};

export function consumeEscapeDismissal(
  event: DismissalKeyboardEvent
): boolean {
  if (event.defaultPrevented || !isEscapeDismissKey(event.key)) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  return true;
}

export function isDirectOverlayInteraction(
  target: unknown,
  currentTarget: unknown
): boolean {
  return target === currentTarget;
}

export function isTargetOutside<T>(
  boundary: { contains(target: T): boolean } | null,
  target: T | null
): boolean {
  return boundary !== null && target !== null && !boundary.contains(target);
}
