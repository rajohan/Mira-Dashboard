# Auth And Trust Boundaries

Mira Dashboard is a trusted single-operator tool, but it still crosses several
important trust boundaries:

- browser to Dashboard backend;
- Dashboard backend to OpenClaw Gateway;
- Dashboard backend to GitHub/Doppler/provider APIs;
- Dashboard backend to host shell/Docker operations;
- Dashboard backend to local SQLite state.

## Route Authentication

All `/api/*` routes require a Dashboard session except:

- `/api/health`
- `/api/auth/*`

An explicitly scoped automation credential can replace the session only for the
small route allowlist documented below. It cannot authenticate WebSockets or
other Dashboard route families.

The browser session is stored in the `mira_dashboard_session` HTTP-only cookie.
The cookie is SameSite Strict and is Secure only when the request is HTTPS or a
trusted forwarded proto says HTTPS.

Auth routes are rate-limited more tightly than general API routes.

## Scoped Automation Credentials

Configure hash-only credentials in the Dashboard runtime:

```text
MIRA_DASHBOARD_AUTOMATION_CREDENTIALS=[{"id":"mira-ops","tokenHash":"<64 lowercase hex characters>","scopes":["agents:write","cache:read","reports:write","tasks:read","tasks:write"]}]
```

Each client sends:

```http
Authorization: Bearer mira-ops.<64-lowercase-hex-validator>
```

The validator is 32 random bytes encoded as lowercase hex. Dashboard stores
only its lowercase SHA-256 hash in configuration, compares hashes in constant
time, and fails startup when the credential list, ids, hashes, scopes, or
duplicates are invalid. Keep the full bearer token only in the calling
automation's secret store.
Send it only over direct loopback or HTTPS, never over remote plaintext HTTP.
Credential ids are 1–64 lowercase letters, digits, dots, underscores, or
hyphens and must start with a letter or digit.

The route allowlist is fail-closed:

| Scope                 | Allowed route and method family             |
| --------------------- | ------------------------------------------- |
| `agents:read`         | `GET`/`HEAD /api/agents/config`             |
| `agents:write`        | `PUT /api/agents/:id/metadata`; state-reconciling agent reads |
| `audit:read`          | `GET`/`HEAD /api/audit-events`              |
| `cache:read`          | `GET`/`HEAD /api/cache/*`                   |
| `notifications:read`  | `GET`/`HEAD /api/notifications/*`           |
| `notifications:write` | Unsafe methods under `/api/notifications/*` |
| `reports:read`        | `GET`/`HEAD /api/reports/*`                 |
| `reports:write`       | Unsafe methods under `/api/reports/*`       |
| `tasks:read`          | `GET`/`HEAD /api/tasks/*`                   |
| `tasks:write`         | Unsafe methods under `/api/tasks/*`         |

Agent status reads (`GET`/`HEAD /api/agents/status`,
`/api/agents/:id/status`, and `/api/agents/tasks/history`) require
`agents:write` because their handlers reconcile stale task state in SQLite.

Terminal/exec, config, file access, sessions/chat, Docker, deploy/review,
restart, backup actions, cache refreshes, log rotation, scheduled-job mutation,
and all other unmapped routes are denied even if a credential contains every
known scope. Add a new route or capability only through a reviewed code change.

On protected routes, a bearer header takes precedence over cookie and loopback
authentication. An invalid bearer returns `401`. A valid credential without the
exact route scope returns `403`. Neither falls back to broader authentication.
Allowed and denied automation mutations use the credential id as the
append-only audit actor.

Generate a client token and its Dashboard-side hash without writing the
validator to a file:

```bash
bun -e 'const validator = crypto.getRandomValues(new Uint8Array(32)).toHex(); console.log(`client token: mira-ops.${validator}`); console.log(`Dashboard tokenHash: ${new Bun.CryptoHasher("sha256").update(validator).digest("hex")}`)'
```

Run this only in an untracked local shell connected to the intended secret
store. Do not use Dashboard Terminal or tracked exec because their persisted
job output would retain the validator. Treat the command output as secret
material. Do not paste the client token into Dashboard configuration, logs,
reports, PRs, or shell history.
When wiring a caller, do not place the token literal in process arguments or an
agent transcript. Load it from the caller's secret store and use an HTTP client
or standard-input configuration that redacts authorization headers.

## Transitional Loopback Auth Bypass

Loopback auth bypass is disabled unless:

```bash
MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH=1
```

Even then, bypass only applies to direct loopback requests without forwarded
client headers. A missing `Origin` header is accepted, so ordinary same-host
`curl` or scripts can bypass the session cookie when this flag is enabled, but
the request URL hostname must still be a recognized loopback name.
If an `Origin` header is present, it must exactly match the request origin and
both hostnames must be loopback names. Configured non-loopback origins never
receive the loopback identity. Production smoke tests should normally use a real
session cookie instead of relying on loopback bypass.

The bypass remains temporarily available so existing local automation keeps
working during migration. Configure a scoped credential, update each caller to
send it, verify its exact workflows, and only then unset
`MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH`. Do not disable the bypass before every
current caller has moved, because tokenless localhost requests will start
returning `401`.

## Origins And Proxies

Browser and WebSocket access depends on allowed origins. Configure:

```bash
MIRA_DASHBOARD_ALLOWED_ORIGINS=https://dashboard.example
```

Unsafe browser API methods (`POST`, `PUT`, `PATCH`, and `DELETE`) require an
allowed `Origin` when the browser sends one. Fetch Metadata must identify the
request as `same-origin` or `none`; explicit `same-site` and `cross-site`
mutations are rejected before authentication or route execution. Direct API
clients that do not emit browser provenance headers remain supported and still
pass through the normal session or explicitly enabled loopback-auth boundary.

Only set `MIRA_DASHBOARD_TRUSTED_PROXY_IPS` when the proxy strips or overwrites
untrusted forwarding headers. A misconfigured trusted proxy can make rate limits
and secure-cookie decisions trust attacker-controlled headers.

Loopback proxy peers are trusted by default even when
`MIRA_DASHBOARD_TRUSTED_PROXY_IPS` is unset. If Dashboard is behind a same-host
reverse proxy, that proxy must still strip or overwrite client-supplied
forwarding headers before forwarding to Dashboard.

The tracked frontend development proxy overwrites forwarding identity with the
actual client peer. If Bun cannot resolve that peer, it forwards an explicit
non-loopback `unknown` sentinel so the backend cannot mistake the proxy
connection for a direct loopback caller. The proxy rewrites only its own
same-origin browser `Origin` to the backend target. Cross-site origins remain
unchanged and are rejected by the backend.

## Response Security And Correlation

Every handled HTTP response includes a server-generated `X-Request-ID`.
Unexpected route errors include the same identifier in the backend log so an
operator can correlate a client failure without logging request bodies or
credentials.

Dashboard responses also set a central browser policy:

- CSP defaults resources to self, blocks object/embed and framing, and keeps the
  existing same-origin WebSocket, HTTPS image/media preview, inline style, and
  same-origin microphone flows available.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy: no-referrer`.
- `Permissions-Policy` denies camera, geolocation, payment, and USB while
  retaining same-origin microphone recording.
- `X-Frame-Options: DENY` as clickjacking defense in depth.

Routes that deliberately return a stricter CSP, such as sandboxed SVG previews,
retain their route-specific policy.

## Append-Only Audit Events

Every allowed unsafe API request writes an immutable `attempted` event before
its route handler runs. The final HTTP outcome is appended separately as
`accepted`, `denied`, or `failed`. An audit-write failure before route execution
causes the request to fail closed. If persistence of the outcome fails after a
handler has completed, the failure is logged with the request ID without
turning the completed mutation into a misleading, retriable response.
Cross-origin requests, missing sessions on protected routes, and requests
rejected by rate limiting are stopped before audit insertion so they cannot
grow the immutable table without reaching a handler. Permitted authentication
route attempts and authenticated route-level denials retain their outcome.

Worker-owned execution rows add their own lifecycle events:

- `job.enqueue` records durable acceptance in the same SQLite transaction as
  the queue row.
- `job.execute` records worker attempt and terminal success, failure, or
  cancellation.
- `job.cancel` records queued cancellation or a running cancellation request.

Async job events inherit the initiating request actor and `X-Request-ID`.
Automatic schedule/startup/system work uses an explicit system actor. Scoped
credentials use a distinct automation actor type, separate from users and the
transitional legacy loopback identity. Callers select only operational
lifecycle fields for audit metadata. The persistence
layer also bounds depth/size and defensively redacts keys that look like
credentials, request bodies, payloads, content, or process output. Command
arguments, file content, config bodies, cookies, tokens, stdout, and stderr are
never copied into the audit table.

SQLite triggers reject updates, deletes, and conflicting replacements against
`audit_events`, including `INSERT OR REPLACE` with an existing event id.
Consequently automated maintenance does not age-prune this table. A future
retention/export policy must be introduced as an explicit forward migration,
not an ad hoc deletion. Authenticated operators can page newest-first through
`GET /api/audit-events`.

## First-User Bootstrap

First-user bootstrap is special because it is unauthenticated by design. It must
stay narrow:

- reject once users exist;
- persist and validate the submitted OpenClaw Gateway token before creating the
  first user;
- serialize overlapping attempts;
- avoid publishing a usable Dashboard user while Gateway validation is pending;
- roll back submitted token and user/session state on failure;
- restore the previously active Gateway token, or shut Gateway down if no
  previous token existed.

After bootstrap is complete, `/api/auth/register-first-user` should behave as a
closed setup endpoint and must not switch Gateway tokens.

## Gateway Token Handling

Do not print Gateway token values. Inspect only metadata such as length and
timestamps.

Startup token precedence:

1. `OPENCLAW_GATEWAY_TOKEN`
2. `OPENCLAW_TOKEN`
3. persisted `app_config.gateway_token`

If an environment token exists, it should be considered the source of truth for
production.

## Host Operations

Dashboard can invoke host-level operations:

- Docker updater commands;
- deploy/build commands;
- backup scripts;
- log rotation;
- terminal helper flows;
- GitHub PR/deploy actions.

These capabilities are intentionally available to the operator, but they should
not be exposed without Dashboard auth. When adding new host operations:

- validate inputs before spawning commands;
- prefer allowlists over arbitrary command strings;
- avoid logging secret values;
- keep operation history useful but redacted;
- add tests for auth and rejection paths.

## Secrets

Secrets live in Doppler or process environment, not in docs or committed files.
Docs should name required variables but never include values.

Useful check before committing:

```bash
git diff --cached | rg -i "token|secret|password|api[_-]?key|webhook"
```

Inspect matches manually. Variable names are fine; values are not.
