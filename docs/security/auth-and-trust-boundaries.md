# Auth And Trust Boundaries

Mira Dashboard is a trusted single-operator tool, but it still crosses several
important trust boundaries:

- browser to Dashboard backend;
- Dashboard backend to OpenClaw Gateway;
- Dashboard backend to GitHub/Doppler/provider APIs;
- Dashboard backend to host shell/Docker operations;
- Dashboard backend to local SQLite state.

## Route Authentication

All `/api/*` routes require a Dashboard session except the exact public
bootstrap/login surface:

- `/api/health`
- `GET /api/auth/bootstrap`
- `GET /api/auth/session`
- `POST /api/auth/register-first-user`
- `POST /api/auth/login`
- `POST /api/auth/login/{totp,recovery}`
- `POST /api/auth/login/webauthn/{options,verify}`
- `POST /api/auth/logout`

An explicitly scoped automation credential can replace the session only for the
small route allowlist documented below. It cannot authenticate WebSockets or
other Dashboard route families. Account-security routes are never public merely
because they contain authentication functionality.

The browser session is stored in the `mira_dashboard_session` HTTP-only cookie.
The cookie is SameSite Strict and is Secure only when the request is HTTPS or a
trusted forwarded proto says HTTPS. Sessions use a 30-day absolute lifetime and
a configurable 30-minute idle lifetime. Polling does not extend idle time;
frontend requests only touch activity after recent keyboard, pointer, touch, or
focus activity. Session validators are stored only as SHA-256 hashes.

Auth routes are rate-limited more tightly than general API routes. Password,
second-factor, and account-password failures also use persistent, hashed,
account-scoped buckets with progressive cooldowns. Pending MFA logins expire
after five minutes and are consumed after success or eight failed attempts.

## Two-Step Login And Step-Up

Password verification is always the first login step. Users without MFA receive
the normal session response and are directed to **Settings → Dashboard** to
enroll. Users with MFA receive only a short-lived
`mira_dashboard_pending_login` cookie and method list; no durable session is
created until one configured method succeeds.

Supported second factors:

- **Security key (YubiKey/WebAuthn/FIDO2):** origin-bound, phishing-resistant
  public-key authentication with user verification required. Register two named
  keys and store the backup separately. Dashboard stores credential public keys,
  counters, transports, device/backup state, labels, and timestamps; it does not
  store a YubiKey secret.
- **Authenticator app (RFC 6238 TOTP):** interoperable SHA-1, six-digit,
  30-second codes. Each seed is encrypted with versioned AES-256-GCM and
  context-bound associated data using
  `MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY`. The last accepted time step is stored and
  reused codes are rejected atomically. The pinned `otplib` v13 package uses
  its audited Noble/scure defaults and is tested by the library for Bun.
  TOTP is supported but is not phishing-resistant.
- **Recovery code:** ten high-entropy one-time codes are shown only when first
  enabling MFA or explicitly rotating the set. Only a selector and
  password-hashed validator are stored. A successful code is consumed
  atomically.

The first enrolled factor enables MFA, revokes every other session, rotates the
current session, and returns the recovery-code set. The final active factor
cannot be removed. Disabling MFA requires both a recent second factor and the
current password, removes all factors/codes, and revokes all sessions.

Host-control actions require a second-factor verification within the
configurable recent-auth window (10 minutes by default). This includes config
or workspace writes, raw secret reveal/config backup, Gateway restart,
Docker/exec, backups, scheduled jobs/cron, PR/deploy operations, session
mutations, job cancellation, and other centrally classified privileged
mutations. A user without MFA receives `mfa_enrollment_required`; a stale MFA
session receives `step_up_required`. The frontend opens one global verification
dialog and requires the original action to be retried after successful step-up.

Changing the Dashboard password requires the current password plus recent MFA
when enabled, rotates the current session, and revokes every other session.
Forgotten-password recovery is intentionally host-local:

```bash
cd /home/ubuntu/projects/mira-dashboard/backend
bun run auth:reset-password -- --username <username>
```

Use `--reset-mfa` only for deliberate factor-loss recovery. The command requires
an interactive TTY, never accepts password material through arguments or
environment variables, preserves MFA by default, revokes all sessions and
pending ceremonies, and writes an audit event.

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
`agents:write` because their handlers reconcile stale task state in SQLite. The
request policy audits automation calls to them as mutations even though they use
safe HTTP methods.

Terminal/exec, config, file access, sessions/chat, Docker, deploy/review,
restart, backup actions, cache refreshes, log rotation, scheduled-job mutation,
and all other unmapped routes are denied even if a credential contains every
known scope. Add a new route or capability only through a reviewed code change.

On protected routes, a bearer header takes precedence over cookie
authentication. An invalid bearer returns `401`. A valid credential without the
exact route scope returns `403`. Neither falls back to broader authentication.
Allowed and denied automation mutations use the credential id as the
append-only audit actor.

The Dashboard repository tracks a fixed local wrapper and one credential
profile per OpenClaw caller. On the current host the runtime layout is:

| Wrapper profile | Client token file under `/home/ubuntu/.config/mira-dashboard/automation/` | Exact scopes |
| --- | --- | --- |
| `heartbeat` | `openclaw-heartbeat.token` | `cache:read`, `reports:write` |
| `daily-summary` | `openclaw-daily-summary.token` | `cache:read`, `reports:write` |
| `daily-brief` | `openclaw-daily-brief.token` | `cache:read`, `reports:write`, `tasks:read` |
| `task-tracking` | `openclaw-task-tracking.token` | `agents:write`, `tasks:read`, `tasks:write` |

The directory must be owned by the OpenClaw user with mode `0700`; every token
file must be a regular, non-symlink file owned by that user with mode `0600`.
The tracked Dashboard helper
`/home/ubuntu/projects/mira-dashboard/scripts/provisionDashboardAutomationCredential.ts`
writes the full token directly to the correct file and prints only the
hash-only Dashboard configuration entry. It refuses to overwrite an existing
file. Run it once for each profile from an untracked host shell:

```bash
cd /home/ubuntu/projects/mira-dashboard
bun scripts/provisionDashboardAutomationCredential.ts heartbeat
bun scripts/provisionDashboardAutomationCredential.ts daily-summary
bun scripts/provisionDashboardAutomationCredential.ts daily-brief
bun scripts/provisionDashboardAutomationCredential.ts task-tracking
```

Combine the four printed objects into the JSON array stored as
`MIRA_DASHBOARD_AUTOMATION_CREDENTIALS` in Doppler. The full tokens remain only
in the client files; they are not stored in Doppler, SQLite, prompts, cron
payloads, unit files, or command arguments. The caller wrapper
`/home/ubuntu/projects/mira-dashboard/scripts/miraDashboardApi.ts` reads the
selected file only after checking type, ownership, exact mode, size, and token
format. Request bodies come from standard input and the token is attached only
as an `Authorization` header.

Do not run provisioning through Dashboard Terminal or tracked exec because
their persisted output would retain operational details. On a new host, create
new credentials instead of restoring the full token files from Dashboard
backups. Update the Doppler hash-only array in the same maintenance window and
smoke-test every allowed and denied profile route.

## No Loopback Authentication Bypass

Loopback is a transport location, not an identity. Requests to
`127.0.0.1:3100` require either a valid browser session or an exact
minimum-scope automation credential. `MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH` is no
longer a supported setting, and setting it grants no access.

Keep a distinct credential per local caller so heartbeat, task tracking, and
report delivery can be revoked and audited independently. Tokenless localhost
requests to protected routes must return `401`; a scoped token presented to an
unmapped host-control route must return `403`.

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
require a scoped credential or session.

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
credentials use a distinct automation actor type, separate from users. Callers
select only operational lifecycle fields for audit metadata. The persistence
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
- encrypt, persist, and validate the submitted OpenClaw Gateway token before
  creating the first user;
- serialize overlapping attempts;
- avoid publishing a usable Dashboard user while Gateway validation is pending;
- roll back submitted token and user/session state on failure;
- restore the previously active Gateway token, or shut Gateway down if no
  previous token existed.

After bootstrap is complete, `/api/auth/register-first-user` should behave as a
closed setup endpoint and must not switch Gateway tokens.

Bootstrap still creates an ordinary password-authenticated session after
Gateway validation. It does not require a physical key during initial setup.
Privileged actions remain blocked until the operator enrolls a security key or
authenticator app from Dashboard settings.

## Config Secret Display

Structured OpenClaw config and `openclaw.json` are recursively masked by
default. Submitted structured updates may carry the redaction sentinel only
where the server can restore an existing value; clients cannot overwrite a
secret with the placeholder. Raw `openclaw.json` is read-only while masked.
Explicit raw reveal and full config backup require recent MFA and are audited.
Other allowed config files retain their existing bounded file policy.

## Gateway Token Handling

Do not print Gateway token values. `app_config.gateway_token` contains a
versioned AES-256-GCM envelope bound to its storage context; the external
`MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY` remains outside SQLite. A legacy
plaintext value is encrypted in place before requests are served. Inspect only
metadata such as length and timestamps.

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
