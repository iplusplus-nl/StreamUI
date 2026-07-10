export type DisplaySettings = {
  showRawStream: boolean;
  artifactEditingEnabled: boolean;
};

export const DISPLAY_SETTINGS_STORAGE_KEY = "streamui.displaySettings.v1";

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  showRawStream: false,
  artifactEditingEnabled: true
};

export function normalizeDisplaySettings(input: unknown): DisplaySettings {
  const object =
    typeof input === "object" && input !== null
      ? (input as Partial<DisplaySettings>)
      : {};

  return {
    showRawStream:
      typeof object.showRawStream === "boolean"
        ? object.showRawStream
        : DEFAULT_DISPLAY_SETTINGS.showRawStream,
    artifactEditingEnabled:
      typeof object.artifactEditingEnabled === "boolean"
        ? object.artifactEditingEnabled
        : DEFAULT_DISPLAY_SETTINGS.artifactEditingEnabled
  };
}

export function loadDisplaySettings(): DisplaySettings {
  if (typeof window === "undefined") {
    return DEFAULT_DISPLAY_SETTINGS;
  }

  try {
    return normalizeDisplaySettings(
      JSON.parse(
        window.localStorage.getItem(DISPLAY_SETTINGS_STORAGE_KEY) ?? "null"
      )
    );
  } catch {
    return DEFAULT_DISPLAY_SETTINGS;
  }
}

export function saveDisplaySettings(settings: DisplaySettings): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    DISPLAY_SETTINGS_STORAGE_KEY,
    JSON.stringify(normalizeDisplaySettings(settings))
  );
}
