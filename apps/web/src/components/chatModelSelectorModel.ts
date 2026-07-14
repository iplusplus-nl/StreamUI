import type { ReasoningEffort } from "../core/apiSettings";

export const CHAT_REASONING_OPTIONS: Array<{
  value: ReasoningEffort;
  label: string;
}> = [
  { value: "none", label: "" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Ultra" }
];

export function getChatReasoningLabel(
  reasoningEffort: ReasoningEffort
): string {
  return (
    CHAT_REASONING_OPTIONS.find(
      (option) => option.value === reasoningEffort
    )?.label ?? ""
  );
}

export function getChatReasoningIndex(
  reasoningEffort: ReasoningEffort
): number {
  const index = CHAT_REASONING_OPTIONS.findIndex(
    (option) => option.value === reasoningEffort
  );
  return index >= 0 ? index : 0;
}
