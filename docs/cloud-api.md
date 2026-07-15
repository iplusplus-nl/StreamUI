# ChatHTML Cloud API Contract

The ChatHTML frontend can run against the local open-source backend or a hosted
Cloud backend. The hosted implementation can be private, but these HTTP shapes
are public so the frontend remains open.

## Runtime Capabilities

`GET /api/settings` may include:

```json
{
  "cloud": {
    "enabled": true,
    "authRequired": true,
    "billingEnabled": false,
    "managedProviderEnabled": true,
    "brandName": "ChatHTML Cloud"
  }
}
```

When `cloud.enabled` is absent or false, the frontend hides Cloud login and
billing surfaces.

## Authentication

```txt
GET  /api/auth/start
GET  /api/auth/callback
POST /api/auth/native/start
POST /api/auth/native/callback
GET  /api/auth/me
POST /api/auth/logout
```

`GET /api/auth/start` creates an OAuth state value and a PKCE verifier in
short-lived HttpOnly cookies, then redirects the browser to the configured
ChatHTML Service `/oauth/authorize` page. The user enters their email and
password only on that Service-hosted page.

After authentication, the Service redirects to `/api/auth/callback` with a
one-time authorization code and the original state. The ChatHTML backend
validates the state, exchanges the code and PKCE verifier server-to-server at
`/v1/oauth/token`, and stores the resulting opaque session token in a secure,
HttpOnly same-origin cookie. Passwords, PKCE verifiers, and session tokens are
never placed in browser URLs or exposed to frontend JavaScript.

`GET /api/auth/me` returns:

```json
{
  "user": {
    "id": "user_123",
    "email": "user@example.com",
    "role": "user",
    "balanceUsd": "-12.500000",
    "balanceMicros": -12500000,
    "spentInWindowUsd": "4.250000",
    "spentInWindowMicros": 4250000,
    "usageLimitUsd": "20.000000",
    "usageLimitMicros": 20000000,
    "usageWindowHours": 24,
    "limited": false,
    "retryAfterSeconds": 0
  },
  "auth": {
    "available": true,
    "requiresInvite": false,
    "firstUser": false
  }
}
```

When no valid session exists, `GET /api/auth/me` keeps the same response shape
with `"user": null`, and the frontend shows sign-in entry points.
`POST /api/auth/logout` revokes the Service session and clears the local
HttpOnly cookie.

### Native app authentication

A WebView-only wrapper can use the normal web redirect flow. A wrapper that
opens login in the system browser should inject this narrow bridge before the
web app starts:

```ts
window.chathtmlNativeAuth = {
  authorize(input: {
    authorizationUrl: string;
    callbackScheme: "chathtml";
  }): Promise<{ callbackUrl: string }>;
};
```

The bridge opens `authorizationUrl` in the system browser, waits for the OS to
deliver one `chathtml://oauth/callback?...` deep link, and resolves with that
full callback URL. ChatHTML then posts it to `/api/auth/native/callback` on its
own origin. The backend validates the exact scheme, path, state cookie, and PKCE
verifier before exchanging the code and setting the same HttpOnly session
cookie used by the web version.

The native shell must register the `chathtml` URL scheme and accept only
`chathtml://oauth/callback`. It must not exchange the code itself, expose the
PKCE verifier, or persist a Service token. Multiple sign-in clicks are
coalesced while one native authorization is active.

## Managed usage accounting

Account deposits and top-ups are disabled during the alpha. Managed-provider
costs accrue as debt, so the account balance is zero or negative. The Service
rejects a new managed request after the account reaches $20 of recorded usage
within the preceding rolling 24 hours. A rejected request uses HTTP 429 and the
code `ACCOUNT_USAGE_LIMIT_REACHED`; `Retry-After` reports when enough usage is
expected to age out of the window.

Browser-direct requests made with a user-provided provider key do not pass
through the Service and are not part of this balance or limit.

## Managed Provider

When the selected provider has `apiKeySource: "managed"`, the frontend sends the
normal `POST /api/chat` payload with serialized API settings. A hosted backend
should authenticate the request, apply managed-usage accounting, use its
server-side provider credentials, and stream the same NDJSON chat events as the
local backend.
