import type { RenderError } from "../../runtime/streamui/types";

export function renderErrorKey(
  error: Pick<RenderError, "kind" | "message">
): string {
  return `${error.kind}:${error.message}`;
}

export function hasRenderError(
  errors: RenderError[] | undefined,
  error: RenderError
): boolean {
  const key = renderErrorKey(error);
  return Boolean(errors?.some((item) => renderErrorKey(item) === key));
}
