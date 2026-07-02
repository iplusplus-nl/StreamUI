type RawStreamPanelProps = {
  raw?: string;
};

export function RawStreamPanel({ raw }: RawStreamPanelProps) {
  if (!raw) {
    return null;
  }

  return (
    <details className="raw-stream-panel">
      <summary className="raw-stream-trigger">
        <span className="raw-stream-mark" aria-hidden="true" />
        <span>Raw stream</span>
        <span className="raw-stream-meta">{raw.length.toLocaleString()} chars</span>
        <span className="raw-stream-chevron" aria-hidden="true" />
      </summary>
      <pre className="raw-stream-text">{raw}</pre>
    </details>
  );
}
