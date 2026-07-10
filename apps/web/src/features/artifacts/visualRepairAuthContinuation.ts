import type { PendingRequestSlot } from "../chat/pendingRequestSlot";
import type {
  StartVisualRepairInput,
  VisualRepairOutcome
} from "./visualRepairController";

export type StartVisualRepair = (
  input: StartVisualRepairInput
) => Promise<VisualRepairOutcome>;

export async function startVisualRepairWithAuthContinuation(
  input: StartVisualRepairInput,
  start: StartVisualRepair,
  pending: PendingRequestSlot<StartVisualRepairInput>,
  retainOnBusy = false
): Promise<VisualRepairOutcome> {
  const outcome = await start(input);
  if (
    outcome === "authentication-required" ||
    (retainOnBusy && outcome === "busy")
  ) {
    pending.put(input);
  }
  return outcome;
}

export function replayPendingVisualRepair(
  pending: PendingRequestSlot<StartVisualRepairInput>,
  start: StartVisualRepair,
  warn: (message: string, error?: unknown) => void
): boolean {
  const input = pending.take();
  if (!input) {
    return false;
  }

  void startVisualRepairWithAuthContinuation(input, start, pending, true).catch(
    (error) => warn("Could not resume visual artifact repair.", error)
  );
  return true;
}
