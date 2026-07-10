export const MAX_VISUAL_REPAIR_DIAGNOSTICS_CHARS = 7_000;

export function clipVisualRepairDiagnostics(value: string): string {
  if (value.length <= MAX_VISUAL_REPAIR_DIAGNOSTICS_CHARS) {
    return value;
  }

  return `${value
    .slice(0, MAX_VISUAL_REPAIR_DIAGNOSTICS_CHARS - 120)
    .trimEnd()}\n\n[Diagnostics truncated; prioritize fixing layout, scale, overlap, clipping, and blur.]`;
}

export function buildVisualRepairPrompt({
  diagnostics,
  hasScreenshot,
  width
}: {
  diagnostics?: string;
  hasScreenshot: boolean;
  width: number;
}): string {
  const lines = [
    hasScreenshot
      ? "Repair the previous ChatHTML artifact using the attached rendering screenshot."
      : "Repair the previous ChatHTML artifact using the textual render diagnostics below. The selected model cannot inspect image inputs, so infer visual failures from the artifact source, visible text, render errors, and layout intent.",
    hasScreenshot
      ? `The screenshot shows the actual rendered output at about ${Math.round(width)}px wide.`
      : `The diagnostics describe the rendered artifact at about ${Math.round(width)}px wide.`,
    "Inspect the screenshot or diagnostics for visual failures such as overlapping labels, clustered or unreadable content, clipped elements, bad scaling, excessive blur, tiny text, or poor use of space.",
    "Use the previous artifact source and the original user intent from the conversation as context.",
    "Generate a complete corrected ChatHTML artifact. Preserve the user's intent, but change the visual mapping if needed; do not keep realistic proportions when they make the result unreadable.",
    "Prefer readable compressed/log scales, callouts, legends, exploded views, or separated annotation lanes when exact spatial scale would collapse details.",
    "Do not explain the repair process outside the artifact."
  ];

  if (diagnostics) {
    lines.push(
      "",
      "Render diagnostics and artifact source:",
      clipVisualRepairDiagnostics(diagnostics)
    );
  }

  return lines.join("\n");
}
