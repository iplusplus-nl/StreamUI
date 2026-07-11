type WebDemoBannerProps = {
  themeMode: "day" | "night";
  onDownload(): void;
};

export function WebDemoBanner({
  themeMode,
  onDownload
}: WebDemoBannerProps) {
  return (
    <header className="webdemo-banner" data-theme={themeMode}>
      <span>This is a Web Demo</span>
      <span className="webdemo-banner-copy">
        Your chat history stays in this browser. Download ChatHTML for the full
        experience.
      </span>
      <button type="button" onClick={onDownload}>
        Download
      </button>
    </header>
  );
}
