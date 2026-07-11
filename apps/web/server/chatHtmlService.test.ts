import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import express from "express";
import type { Server } from "node:http";
import {
  DEFAULT_CHATHTML_SERVICE_BASE_URL,
  createChatHtmlServiceGateway
} from "./chatHtmlService.js";

const servers: Server[] = [];

async function startGateway(fetchImpl: typeof fetch, nodeEnv = "test") {
  const gateway = createChatHtmlServiceGateway({
    baseUrl: "http://service.test/v1",
    fetchImpl,
    nodeEnv,
    publicOrigin: "http://chat.test"
  });
  const app = express();
  app.use(express.json());
  app.get("/api/auth/me", gateway.handleAuthMe);
  app.get("/api/auth/start", gateway.handleOAuthStart);
  app.get("/api/auth/callback", gateway.handleOAuthCallback);
  app.post("/api/auth/logout", gateway.handleAuthLogout);
  app.post("/managed", gateway.injectManagedApiSettings, (req, res) => {
    res.json(req.body);
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve()))
    )
  );
});

describe("ChatHTML Service gateway", () => {
  it("uses the dedicated service hostname by default", () => {
    assert.equal(
      DEFAULT_CHATHTML_SERVICE_BASE_URL,
      "https://service.aietheia.com/v1"
    );
  });

  it("uses Authorization Code with PKCE and keeps the token in an HttpOnly cookie", async () => {
    const token = "service_session_token_abcdefghijklmnopqrstuvwxyz";
    const calls: Array<{ url: string; authorization: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        authorization: new Headers(init?.headers).get("authorization") ?? ""
      });
      if (url.endsWith("/oauth/token")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.grant_type, "authorization_code");
        assert.equal(body.client_id, "chathtml");
        assert.equal(body.redirect_uri, "http://chat.test/api/auth/callback");
        assert.equal(
          body.code,
          "one-time-authorization-code-abcdefghijklmnopqrstuvwxyz"
        );
        assert.equal(typeof body.code_verifier, "string");
        return Response.json({
          user: { id: "user-1", email: "user@example.com", role: "user" },
          accessToken: token,
          expiresAt: Date.now() + 60_000
        });
      }
      if (url.endsWith("/auth/me")) {
        return Response.json({
          user: { id: "user-1", email: "user@example.com", role: "user" }
        });
      }
      if (url.endsWith("/auth/logout")) {
        return Response.json({ ok: true });
      }
      throw new Error(`Unexpected service request: ${url}`);
    };
    const origin = await startGateway(fetchImpl, "production");
    const started = await fetch(`${origin}/api/auth/start`, {
      redirect: "manual"
    });
    assert.equal(started.status, 302);
    const authorizationUrl = new URL(started.headers.get("location") ?? "");
    assert.equal(authorizationUrl.origin, "http://service.test");
    assert.equal(authorizationUrl.pathname, "/oauth/authorize");
    assert.equal(authorizationUrl.searchParams.get("client_id"), "chathtml");
    assert.equal(
      authorizationUrl.searchParams.get("redirect_uri"),
      "http://chat.test/api/auth/callback"
    );
    assert.equal(
      authorizationUrl.searchParams.get("code_challenge_method"),
      "S256"
    );
    assert.equal(authorizationUrl.searchParams.has("code_verifier"), false);
    const transientCookies = started.headers.get("set-cookie") ?? "";
    const state = authorizationUrl.searchParams.get("state") ?? "";
    const stateCookie =
      transientCookies.match(/chathtml_oauth_state=([^;]+)/)?.[1] ?? "";
    const verifierCookie =
      transientCookies.match(/chathtml_oauth_verifier=([^;]+)/)?.[1] ?? "";
    assert.equal(stateCookie, state);
    assert.ok(verifierCookie);
    assert.equal(
      authorizationUrl.searchParams.get("code_challenge"),
      createHash("sha256").update(verifierCookie).digest("base64url")
    );
    assert.match(transientCookies, /HttpOnly/);
    assert.match(transientCookies, /Secure/);

    const callback = await fetch(
      `${origin}/api/auth/callback?code=one-time-authorization-code-abcdefghijklmnopqrstuvwxyz&state=${state}`,
      {
        headers: {
          Cookie: `chathtml_oauth_state=${stateCookie}; chathtml_oauth_verifier=${verifierCookie}`
        },
        redirect: "manual"
      }
    );
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get("location"), "http://chat.test/");
    const setCookie = callback.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /chathtml_service_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.doesNotMatch(
      callback.headers.get("location") ?? "",
      /accessToken|service_session/
    );

    const cookie =
      setCookie.match(/chathtml_service_session=([^;]+)/)?.[0] ?? "";
    const me = await fetch(`${origin}/api/auth/me`, {
      headers: { Cookie: cookie }
    });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as { user: { id: string } }).user.id, "user-1");
    assert.equal(calls.at(-1)?.authorization, `Bearer ${token}`);

    const logout = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie }
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.equal(calls.at(-1)?.authorization, `Bearer ${token}`);
  });

  it("rejects an OAuth callback when state does not match", async () => {
    let calls = 0;
    const origin = await startGateway(async () => {
      calls += 1;
      throw new Error("Token exchange must not run.");
    });
    const response = await fetch(
      `${origin}/api/auth/callback?code=${"c".repeat(40)}&state=${"a".repeat(32)}`,
      {
        headers: {
          Cookie: `chathtml_oauth_state=${"b".repeat(32)}; chathtml_oauth_verifier=${"v".repeat(48)}`
        }
      }
    );

    assert.equal(response.status, 400);
    assert.equal(calls, 0);
    assert.match(await response.text(), /invalid or expired/);
  });

  it("injects the fixed service connection only for managed requests", async () => {
    const origin = await startGateway(async () => {
      throw new Error("Authentication service should not be called.");
    });
    const token = "managed_session_token_abcdefghijklmnopqrstuvwxyz";
    const managed = await fetch(`${origin}/managed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `chathtml_service_session=${token}`
      },
      body: JSON.stringify({
        apiSettings: {
          providerId: "chathtml-cloud",
          apiKeySource: "managed",
          model: "openai/gpt-5.5"
        }
      })
    });
    const managedBody = (await managed.json()) as {
      apiSettings: Record<string, unknown>;
    };

    assert.equal(managed.status, 200);
    assert.equal(managedBody.apiSettings.baseUrl, "http://service.test/v1");
    assert.equal(
      managedBody.apiSettings.modelsEndpoint,
      "http://service.test/v1/models"
    );
    assert.equal(managedBody.apiSettings.apiKey, token);
    assert.equal(managedBody.apiSettings.apiKeySource, "manual");
    assert.equal(managedBody.apiSettings.providerId, "custom");

    const ordinary = await fetch(`${origin}/managed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiSettings: {
          providerId: "openrouter",
          apiKeySource: "manual",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "user-owned-key"
        }
      })
    });
    const ordinaryBody = (await ordinary.json()) as {
      apiSettings: Record<string, unknown>;
    };
    assert.equal(ordinary.status, 200);
    assert.equal(ordinaryBody.apiSettings.apiKey, "user-owned-key");
    assert.equal(ordinaryBody.apiSettings.providerId, "openrouter");
  });

  it("rejects managed provider requests without an authenticated cookie", async () => {
    const origin = await startGateway(async () => {
      throw new Error("Authentication service should not be called.");
    });
    const response = await fetch(`${origin}/managed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiSettings: {
          providerId: "chathtml-cloud",
          apiKeySource: "managed"
        }
      })
    });

    assert.equal(response.status, 401);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "Sign in to use ChatHTML Service."
    );
  });

  it("clears an already-expired service session idempotently", async () => {
    const origin = await startGateway(async (input) => {
      assert.equal(String(input), "http://service.test/v1/auth/logout");
      return Response.json({ error: "Authentication is required." }, { status: 401 });
    });
    const response = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie:
          "chathtml_service_session=expired_session_token_abcdefghijklmnopqrstuvwxyz"
      }
    });

    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { user: unknown }).user, null);
    assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
  });

  it("returns registration availability without creating a browser token", async () => {
    const origin = await startGateway(async (input) => {
      assert.equal(String(input), "http://service.test/v1/auth/status");
      return Response.json({
        available: true,
        requiresInvite: false,
        firstUser: true
      });
    });
    const response = await fetch(`${origin}/api/auth/me`);
    const body = (await response.json()) as {
      user: unknown;
      auth: { available: boolean; firstUser: boolean };
    };

    assert.equal(response.status, 200);
    assert.equal(body.user, null);
    assert.equal(body.auth.available, true);
    assert.equal(body.auth.firstUser, true);
    assert.equal(response.headers.get("set-cookie"), null);
  });
});
