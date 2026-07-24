# API Overview

The backend serves API routes directly through Bun's route table. There is no
separate OpenAPI spec today; this docs directory is the human-maintained API
reference.

Base URL in production:

```text
http://127.0.0.1:3100/api
```

Browser/external access goes through the Dashboard UI and session cookie.
Non-browser automation can use a deliberately scoped bearer credential.
Tokenless localhost requests still need a session cookie. Direct loopback is
not an authentication mechanism.

## Response Shape

The API is an internal flat JSON API. Success responses return the resource or
a small object such as:

```json
{ "isOk": true }
```

Errors generally use:

```json
{ "error": "Message" }
```

Handled responses include a server-generated `X-Request-ID`. Unexpected backend
route errors log the same identifier for correlation.

## Authentication

Authenticated routes require a valid Dashboard session cookie or, for the
explicit automation-safe allowlist, a valid scoped bearer credential.

Automation bearer tokens have the strict form
`<credential-id>.<64-lowercase-hex-validator>`. Valid credentials are limited to
their configured `agents:*`, `audit:read`, `cache:read`, `notifications:*`,
`reports:*`, or `tasks:*` capabilities. Privileged route families such as
terminal/exec, config/files, sessions/chat, Docker, deploy, restart, backups,
cache refresh, and scheduled-job mutation are not automation-token accessible.
Invalid or insufficient bearer credentials never fall back to a browser session
or another authentication mechanism.

Public routes:

- `GET /api/health`
- `GET /api/auth/bootstrap`
- `GET /api/auth/session`
- `POST /api/auth/register-first-user`
- `POST /api/auth/login`
- `POST /api/auth/login/totp`
- `POST /api/auth/login/recovery`
- `POST /api/auth/login/webauthn/options`
- `POST /api/auth/login/webauthn/verify`
- `POST /api/auth/logout`

The WebSocket endpoint `/ws` is also authenticated and origin-checked.

Account-security endpoints under `/api/account/security/*` are protected
session routes. They manage MFA, passwords, recovery codes, and browser
sessions and never inherit public auth-route treatment.

Sessions expire after 30 days absolutely and after 30 minutes of inactivity by
default. Password and second-factor failures additionally use persistent
account-scoped throttling. Privileged browser actions require a second-factor
verification within the configured recent-auth window.

Unsafe browser mutations must come from an allowed exact `Origin` and may not
carry `Sec-Fetch-Site: same-site` or `cross-site`. Same-origin Dashboard calls
and direct API clients without browser provenance headers retain their existing
contracts.

## Rate Limiting

`backend/src/requestPolicy.ts` applies in-memory per-client buckets:

| Scope            | Limit               |
| ---------------- | ------------------- |
| Auth routes      | 20 requests/minute  |
| Other API routes | 600 requests/minute |

Responses include `RateLimit-Policy` and `RateLimit` headers. Limited requests
return HTTP `429` with `Retry-After`.

## Status Codes

Common statuses:

| Status | Meaning                                                                   |
| ------ | ------------------------------------------------------------------------- |
| `200`  | Read/update/action succeeded.                                             |
| `201`  | Resource created.                                                         |
| `202`  | Password accepted; a second login factor is still required.              |
| `400`  | Invalid request JSON, params, or body.                                    |
| `401`  | Missing/invalid authentication or invalid Gateway token during bootstrap. |
| `403`  | Origin, scope, path, or proxy policy rejection.                           |
| `404`  | Resource/path not found.                                                  |
| `409`  | Bootstrap closed or operation conflicts with current state.               |
| `413`  | File/media payload too large.                                             |
| `429`  | Rate limited.                                                             |
| `500`  | Unexpected backend failure.                                               |
| `503`  | Frontend build missing for static page serving.                           |

## Route Families

See [Endpoint reference](endpoints.md) for the route table.

High-impact families:

- auth and bootstrap: `/api/auth/*`
- append-only audit history: `/api/audit-events`
- OpenClaw config and restart: `/api/config`, `/api/restart`, `/api/skills`
- chat/session bridge: `/api/sessions/*` plus `/ws`
- tasks: `/api/tasks/*`
- reports: `/api/reports/*`
- notifications: `/api/notifications/*`
- Docker: `/api/docker/*`
- PR/deploy operations: `/api/pull-requests/*`
- filesystem/config editing: `/api/files/*`, `/api/config-files/*`
- execution/terminal: `/api/exec/*`, `/api/terminal/*`

## Safety Notes

Several endpoints mutate local state or external systems:

- `/api/restart` restarts OpenClaw Gateway;
- `/api/pull-requests/:number/approve` may merge/deploy depending on request;
- `/api/docker/*` can restart containers or update compose images;
- `/api/files/*` and `/api/config-files/*` can write files;
- `/api/exec/*` starts local commands.

These routes are intended for Raymond/Mira's trusted Dashboard session, not
public API consumers.
