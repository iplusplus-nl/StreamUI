import type { PendingRequestSlot } from "./pendingRequestSlot";

export function pinManagedRequestToSession<
  TOptions extends { targetSessionId?: string },
  TRequest extends { options: TOptions }
>(request: TRequest, targetSessionId: string): TRequest {
  return {
    ...request,
    options: {
      ...request.options,
      targetSessionId
    }
  };
}

export function openManualAuth<T>(
  slot: PendingRequestSlot<T>,
  open: () => void
): void {
  slot.clear();
  open();
}

export function closeAuthAndDiscard<T>(
  slot: PendingRequestSlot<T>,
  close: () => void
): void {
  slot.clear();
  close();
}

export function queueManagedAuthRequest<T>(
  slot: PendingRequestSlot<T>,
  request: T,
  open: () => void
): void {
  slot.put(request);
  open();
}

export function replayManagedAuthRequest<T>(
  slot: PendingRequestSlot<T>,
  close: () => void,
  replay: (request: T) => void
): boolean {
  const request = slot.take();
  if (request === null) {
    return false;
  }

  close();
  replay(request);
  return true;
}
