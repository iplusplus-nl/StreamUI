import type { ApiSettings } from "../../core/apiSettings";
import {
  loadRuntimeSettings,
  type RuntimeSettingsSummary
} from "../../core/runtimeSettings";
import { resolveRuntimeApiSettings } from "./appSettingsPolicy";

export type AppSettingsLoadOutcome = "applied" | "cancelled" | "failed";

export type AppSettingsControllerDependencies = {
  loadRuntimeSettings(): Promise<RuntimeSettingsSummary>;
  warn(message: string, error: unknown): void;
};

const defaultDependencies: AppSettingsControllerDependencies = {
  loadRuntimeSettings,
  warn: (message, error) => console.warn(message, error)
};

export async function runRuntimeSettingsLoad(
  input: {
    hadSavedApiSettings: boolean;
    isCancelled(): boolean;
    setRuntimeSettings(settings: RuntimeSettingsSummary): void;
    updateApiSettings(updater: (current: ApiSettings) => ApiSettings): void;
  },
  dependencyOverrides?: Partial<AppSettingsControllerDependencies>
): Promise<AppSettingsLoadOutcome> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  try {
    const settings = await dependencies.loadRuntimeSettings();
    if (input.isCancelled()) {
      return "cancelled";
    }

    input.setRuntimeSettings(settings);
    input.updateApiSettings((current) =>
      resolveRuntimeApiSettings(
        current,
        settings,
        input.hadSavedApiSettings
      )
    );
    return "applied";
  } catch (error) {
    if (input.isCancelled()) {
      return "cancelled";
    }

    dependencies.warn("Could not load ChatHTML runtime settings.", error);
    return "failed";
  }
}
