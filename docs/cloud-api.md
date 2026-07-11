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
    "billingEnabled": true,
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
    "balanceUsd": "10.0000",
    "balanceMicros": 10000000
  },
  "auth": {
    "available": true,
    "requiresInvite": false,
    "firstUser": false
  }
}
```

When no valid session exists, `GET /api/auth/me` responds with `401` and the
frontend shows sign-in entry points. `POST /api/auth/logout` revokes the Service
session and clears the local HttpOnly cookie.

## Billing

```txt
POST /api/billing/top-up
```

Request:

```json
{ "amountUsd": "10" }
```

Response:

```json
{
  "ok": true,
  "amountMicros": 10000000,
  "amountUsd": "10.0000",
  "balanceMicros": 10000000,
  "balanceUsd": "10.0000"
}
```

## Managed Provider

When the selected provider has `apiKeySource: "managed"`, the frontend sends the
normal `POST /api/chat` payload with serialized API settings. A hosted backend
should authenticate the request, apply billing, use its server-side provider
credentials, and stream the same NDJSON chat events as the local backend.
