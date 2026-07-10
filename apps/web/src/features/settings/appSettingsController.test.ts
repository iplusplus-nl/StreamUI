import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeApiSettings,
  type ApiSettings
} from "../../core/apiSettings";
import type { RuntimeSettingsSummary } from "../../core/runtimeSettings";
import {
  runRuntimeSettingsLoad,
  type AppSettingsControllerDependencies
} from "./appSettingsController";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function runtimeSettings(
  defaults = normalizeApiSettings({
    providerId: "openrouter",
    apiKeySource: "environment",
    model: "runtime-model"
  })
): RuntimeSettingsSummary {
  return {
    api: { defaults, environmentKeys: [] },
    cloud: {
      enabled: false,
      authRequired: false,
      billingEnabled: false,
      managedProviderEnabled: false,
      brandName: "ChatHTML"
    },
    search: {
      environmentKeys: [],
      defaultProvider: "auto",
      defaultBrowserEngine: "fetch",
      providers: [],
      browserEngines: []
    }
  };
}

function dependencies(
  overrides: Partial<AppSettingsControllerDependencies>
): Partial<AppSettingsControllerDependencies> {
  return {
    warn: () => undefined,
    ...overrides
  };
}

describe("app settings controller", () => {
  it("uses the latest API state captured by the functional updater", async () => {
    const pending = deferred<RuntimeSettingsSummary>();
    const events: string[] = [];
    let current = normalizeApiSettings({
      providerId: "openrouter",
      model: "initial-model"
    });
    let appliedRuntime: RuntimeSettingsSummary | null = null;

    const loading = runRuntimeSettingsLoad(
      {
        hadSavedApiSettings: true,
        isCancelled: () => false,
        setRuntimeSettings: (settings) => {
          events.push("runtime");
          appliedRuntime = settings;
        },
        updateApiSettings: (updater) => {
          events.push("api");
          current = updater(current);
        }
      },
      dependencies({
        loadRuntimeSettings: () => {
          events.push("load");
          return pending.promise;
        }
      })
    );

    current = normalizeApiSettings({
      providerId: "openrouter",
      model: "changed-during-load"
    });
    const runtime = runtimeSettings();
    pending.resolve(runtime);

    assert.equal(await loading, "applied");
    assert.deepEqual(events, ["load", "runtime", "api"]);
    assert.equal(appliedRuntime, runtime);
    assert.equal(current.model, "changed-during-load");
  });

  it("applies runtime defaults for a first-time user", async () => {
    let current = normalizeApiSettings({ model: "local-default" });
    const defaults = normalizeApiSettings({
      providerId: "openai-compatible",
      apiKeySource: "manual",
      apiKey: "runtime-key",
      model: "runtime-default"
    });

    assert.equal(
      await runRuntimeSettingsLoad(
        {
          hadSavedApiSettings: false,
          isCancelled: () => false,
          setRuntimeSettings: () => undefined,
          updateApiSettings: (updater) => {
            current = updater(current);
          }
        },
        dependencies({
          loadRuntimeSettings: async () => runtimeSettings(defaults)
        })
      ),
      "applied"
    );
    assert.deepEqual(current, defaults);
  });

  it("suppresses state writes when a pending load is cancelled", async () => {
    const pending = deferred<RuntimeSettingsSummary>();
    let cancelled = false;
    let writes = 0;
    let warnings = 0;
    const loading = runRuntimeSettingsLoad(
      {
        hadSavedApiSettings: true,
        isCancelled: () => cancelled,
        setRuntimeSettings: () => {
          writes += 1;
        },
        updateApiSettings: () => {
          writes += 1;
        }
      },
      dependencies({
        loadRuntimeSettings: () => pending.promise,
        warn: () => {
          warnings += 1;
        }
      })
    );

    cancelled = true;
    pending.resolve(runtimeSettings());

    assert.equal(await loading, "cancelled");
    assert.equal(writes, 0);
    assert.equal(warnings, 0);
  });

  it("warns on active failures and suppresses failures after cancellation", async () => {
    const failure = new Error("settings failed");
    const warnings: Array<[string, unknown]> = [];
    const input = {
      hadSavedApiSettings: true,
      isCancelled: () => false,
      setRuntimeSettings: () => undefined,
      updateApiSettings: (_updater: (current: ApiSettings) => ApiSettings) =>
        undefined
    };

    assert.equal(
      await runRuntimeSettingsLoad(
        input,
        dependencies({
          loadRuntimeSettings: async () => {
            throw failure;
          },
          warn: (message, error) => warnings.push([message, error])
        })
      ),
      "failed"
    );
    assert.deepEqual(warnings, [
      ["Could not load ChatHTML runtime settings.", failure]
    ]);

    const pending = deferred<RuntimeSettingsSummary>();
    let cancelled = false;
    const cancelledLoad = runRuntimeSettingsLoad(
      { ...input, isCancelled: () => cancelled },
      dependencies({
        loadRuntimeSettings: () => pending.promise,
        warn: (message, error) => warnings.push([message, error])
      })
    );
    cancelled = true;
    pending.reject(failure);
    assert.equal(await cancelledLoad, "cancelled");
    assert.equal(warnings.length, 1);
  });

  it("keeps a first-time snapshot authoritative across repeated effect setups", async () => {
    const firstPending = deferred<RuntimeSettingsSummary>();
    const secondPending = deferred<RuntimeSettingsSummary>();
    let firstCancelled = false;
    let current = normalizeApiSettings({ model: "local-default" });
    let writes = 0;
    const defaults = normalizeApiSettings({
      providerId: "openai-compatible",
      apiKeySource: "manual",
      model: "strict-mode-runtime-default"
    });
    const input = (isCancelled: () => boolean) => ({
      // This value is captured once during mount, before persistence effects.
      hadSavedApiSettings: false,
      isCancelled,
      setRuntimeSettings: () => {
        writes += 1;
      },
      updateApiSettings: (updater: (value: ApiSettings) => ApiSettings) => {
        writes += 1;
        current = updater(current);
      }
    });

    const firstLoad = runRuntimeSettingsLoad(
      input(() => firstCancelled),
      dependencies({ loadRuntimeSettings: () => firstPending.promise })
    );
    // StrictMode cleans up the first effect after persistence has run, then
    // starts it again with the same mount-scoped snapshot.
    firstCancelled = true;
    const secondLoad = runRuntimeSettingsLoad(
      input(() => false),
      dependencies({ loadRuntimeSettings: () => secondPending.promise })
    );

    firstPending.resolve(runtimeSettings(defaults));
    secondPending.resolve(runtimeSettings(defaults));

    assert.equal(await firstLoad, "cancelled");
    assert.equal(await secondLoad, "applied");
    assert.equal(writes, 2);
    assert.deepEqual(current, defaults);
  });
});
