type RawStreamPanelProps = {
  raw?: string;
};

export function RawStreamPanel({ raw }: RawStreamPanelProps) {
  if (!raw) {
    return null;
  }

  return (
    <details className="raw-stream-panel">
      <summary>
        <span>Raw stream</span>
        <span>{raw.length.toLocaleString()} chars</span>
      </summary>
      <pre>{raw}</pre>
    </details>
  );
}
