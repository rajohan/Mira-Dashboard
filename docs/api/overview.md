# API Overview

The backend serves API routes directly through Bun's route table. There is no
separate OpenAPI spec today; this docs directory is the human-maintained API
reference.

Base URL in production:

```text
http://127.0.0.1:3100/api
```

Browser/external access goes through the Dashboard UI and session cookie.
Localhost requests still need a session cookie unless
`MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH=1` is set and the request is a direct
loopback request without forwarded-client headers.

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

Authenticated routes require a valid Dashboard session cookie.

Public routes:

- `GET /api/health`
- all `/api/auth/*` routes

The WebSocket endpoint `/ws` is also authenticated and origin-checked.

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
| `400`  | Invalid request JSON, params, or body.                                    |
| `401`  | Missing/invalid authentication or invalid Gateway token during bootstrap. |
| `403`  | Origin/Fetch Metadata/path/proxy policy rejection.                        |
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
