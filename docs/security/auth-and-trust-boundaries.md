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

The browser session is stored in the `mira_dashboard_session` HTTP-only cookie.
The cookie is SameSite Strict and is Secure only when the request is HTTPS or a
trusted forwarded proto says HTTPS.

Auth routes are rate-limited more tightly than general API routes.

## Loopback Auth Bypass

Loopback auth bypass is disabled unless:

```bash
MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH=1
```

Even then, bypass only applies to direct loopback requests without forwarded
client headers. A missing `Origin` header is accepted, so ordinary same-host
`curl` or scripts can bypass the session cookie when this flag is enabled.
If an `Origin` header is present, it must be allowed. Production smoke tests
should normally use a real session cookie instead of relying on loopback bypass.

## Origins And Proxies

Browser and WebSocket access depends on allowed origins. Configure:

```bash
MIRA_DASHBOARD_ALLOWED_ORIGINS=https://dashboard.example
```

Only set `MIRA_DASHBOARD_TRUSTED_PROXY_IPS` when the proxy strips or overwrites
untrusted forwarding headers. A misconfigured trusted proxy can make rate limits
and secure-cookie decisions trust attacker-controlled headers.

Loopback proxy peers are trusted by default even when
`MIRA_DASHBOARD_TRUSTED_PROXY_IPS` is unset. If Dashboard is behind a same-host
reverse proxy, that proxy must still strip or overwrite client-supplied
forwarding headers before forwarding to Dashboard.

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
