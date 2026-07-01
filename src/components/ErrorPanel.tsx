import type { RenderError } from "../core/types";

type ErrorPanelProps = {
  errors: RenderError[];
};

export function ErrorPanel({ errors }: ErrorPanelProps) {
  if (errors.length === 0) {
    return null;
  }

  return (
    <div className="error-panel">
      <strong>Runtime notes</strong>
      <ul>
        {errors.map((error) => (
          <li key={`${error.kind}-${error.timestamp}-${error.message}`}>
            <span>{error.kind}</span>
            {error.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
