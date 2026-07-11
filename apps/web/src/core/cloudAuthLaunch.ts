import type { AuthSummary } from "./cloudAuth";
import { apiUrl } from "../api/appUrl";

export type NativeOAuthRequest = {
  authorizationUrl: string;
  callbackScheme: "chathtml";
};

export type ChatHtmlNativeAuthBridge = {
  authorize(request: NativeOAuthRequest): Promise<{ callbackUrl: string }>;
};

declare global {
  interface Window {
    chathtmlNativeAuth?: ChatHtmlNativeAuthBridge;
  }
}

export type CloudAuthLaunchDependencies = {
  nativeBridge?: ChatHtmlNativeAuthBridge | null;
  fetchImpl?: typeof fetch;
  assignLocation?: (url: string) => void;
};

async function requireJson(
  response: Response,
  fallback: string
): Promise<Record<string, unknown>> {
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `${fallback} failed with HTTP ${response.status}.`
    );
  }
  return payload;
}

function nativeRequest(payload: Record<string, unknown>): NativeOAuthRequest {
  if (
    typeof payload.authorizationUrl !== "string" ||
    payload.callbackScheme !== "chathtml"
  ) {
    throw new Error("ChatHTML returned an invalid app authorization request.");
  }
  const authorizationUrl = new URL(payload.authorizationUrl);
  const loopback =
    authorizationUrl.hostname === "127.0.0.1" ||
    authorizationUrl.hostname === "localhost";
  const state = authorizationUrl.searchParams.get("state") ?? "";
  const challenge = authorizationUrl.searchParams.get("code_challenge") ?? "";
  if (
    (authorizationUrl.protocol !== "https:" &&
      !(loopback && authorizationUrl.protocol === "http:")) ||
    authorizationUrl.username ||
    authorizationUrl.password ||
    authorizationUrl.hash ||
    authorizationUrl.pathname !== "/oauth/authorize" ||
    authorizationUrl.searchParams.get("response_type") !== "code" ||
    authorizationUrl.searchParams.get("client_id") !== "chathtml" ||
    authorizationUrl.searchParams.get("redirect_uri") !==
      "chathtml://oauth/callback" ||
    authorizationUrl.searchParams.get("code_challenge_method") !== "S256" ||
    !/^[A-Za-z0-9._~-]{20,256}$/.test(state) ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) ||
    authorizationUrl.searchParams.has("code_verifier")
  ) {
    throw new Error("ChatHTML returned an unsafe app authorization URL.");
  }
  return {
    authorizationUrl: authorizationUrl.toString(),
    callbackScheme: "chathtml"
  };
}

function authSummary(payload: Record<string, unknown>): AuthSummary {
  const user = payload.user;
  const auth = payload.auth;
  if (
    !user ||
    typeof user !== "object" ||
    typeof (user as { id?: unknown }).id !== "string" ||
    typeof (user as { email?: unknown }).email !== "string" ||
    ((user as { role?: unknown }).role !== "admin" &&
      (user as { role?: unknown }).role !== "user") ||
    !auth ||
    typeof auth !== "object" ||
    typeof (auth as { available?: unknown }).available !== "boolean" ||
    typeof (auth as { requiresInvite?: unknown }).requiresInvite !== "boolean" ||
    typeof (auth as { firstUser?: unknown }).firstUser !== "boolean"
  ) {
    throw new Error("ChatHTML returned an invalid app authentication result.");
  }
  return payload as unknown as AuthSummary;
}

export async function startCloudAuthentication(
  dependencies: CloudAuthLaunchDependencies = {}
): Promise<AuthSummary | null> {
  const browserWindow = typeof window === "undefined" ? undefined : window;
  const bridge =
    dependencies.nativeBridge === undefined
      ? browserWindow?.chathtmlNativeAuth
      : dependencies.nativeBridge;
  if (!bridge) {
    const assign =
      dependencies.assignLocation ??
      ((url: string) => browserWindow?.location.assign(url));
    assign(apiUrl("/auth/start"));
    return null;
  }

  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const start = nativeRequest(
    await requireJson(
      await fetchImpl(apiUrl("/auth/native/start"), {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      }),
      "App authentication start"
    )
  );
  const callback = await bridge.authorize(start);
  if (!callback || typeof callback.callbackUrl !== "string") {
    throw new Error("The app did not return an OAuth callback URL.");
  }

  return authSummary(
    await requireJson(
      await fetchImpl(apiUrl("/auth/native/callback"), {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ callbackUrl: callback.callbackUrl })
      }),
      "App authentication completion"
    )
  );
}
