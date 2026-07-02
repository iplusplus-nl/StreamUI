import { isIgnoredRuntimeError } from "../core/ignoredRuntimeErrors";
import type { RenderError } from "../core/types";

type ErrorPanelProps = {
  errors: RenderError[];
};

export function ErrorPanel({ errors }: ErrorPanelProps) {
  const visibleErrors = errors.filter((error) => !isIgnoredRuntimeError(error));

  if (visibleErrors.length === 0) {
    return null;
  }

  return (
    <div className="error-panel">
      <strong>Runtime notes</strong>
      <ul>
        {visibleErrors.map((error) => (
          <li key={`${error.kind}-${error.timestamp}-${error.message}`}>
            <span>{error.kind}</span>
            {error.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
