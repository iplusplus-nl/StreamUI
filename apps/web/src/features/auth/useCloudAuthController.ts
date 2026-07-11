import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AuthSummary,
  AuthUser
} from "../../core/cloudAuth";
import {
  runCloudAuthLogout,
  runCloudAuthRefresh,
  runInitialCloudAuthLoad,
  type CloudAuthDependencies
} from "./cloudAuthController";
import { authSummaryWithUser } from "./cloudAuthModel";

export type UseCloudAuthControllerInput = {
  cloudEnabled: boolean;
  dependencies?: Partial<CloudAuthDependencies>;
};

export type CloudAuthController = {
  summary: AuthSummary | null;
  loaded: boolean;
  user: AuthUser | null;
  open(): void;
  close(): void;
  updateUser(user: AuthUser): void;
  refresh(): Promise<AuthSummary | null>;
  logout(): Promise<void>;
};

export function useCloudAuthController({
  cloudEnabled,
  dependencies
}: UseCloudAuthControllerInput): CloudAuthController {
  // Dependency overrides are test seams and intentionally mount-scoped.
  const dependenciesRef = useRef(dependencies);
  const stableDependencies = dependenciesRef.current;
  const [summary, setSummary] = useState<AuthSummary | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!cloudEnabled) {
      setSummary(null);
      setLoaded(false);
      return undefined;
    }

    let cancelled = false;
    void runInitialCloudAuthLoad(
      {
        isCancelled: () => cancelled,
        setSummary,
        setLoaded
      },
      stableDependencies
    );

    return () => {
      cancelled = true;
    };
  }, [cloudEnabled, stableDependencies]);

  const open = useCallback(() => {
    window.location.assign("/api/auth/start");
  }, []);
  const close = useCallback(() => undefined, []);
  const updateUser = useCallback((user: AuthUser) => {
    setSummary((current) => authSummaryWithUser(current, user));
    setLoaded(true);
  }, []);
  const refresh = useCallback(
    () =>
      runCloudAuthRefresh(
        {
          cloudEnabled,
          setSummary,
          setLoaded
        },
        stableDependencies
      ),
    [cloudEnabled, stableDependencies]
  );
  const logout = useCallback(async () => {
    await runCloudAuthLogout(
      {
        setSummary,
        setLoaded,
        setOverlayOpen: () => undefined
      },
      stableDependencies
    );
  }, [stableDependencies]);

  return useMemo(
    () => ({
      summary,
      loaded,
      user: cloudEnabled ? (summary?.user ?? null) : null,
      open,
      close,
      updateUser,
      refresh,
      logout
    }),
    [
      close,
      cloudEnabled,
      loaded,
      logout,
      open,
      refresh,
      summary,
      updateUser
    ]
  );
}
