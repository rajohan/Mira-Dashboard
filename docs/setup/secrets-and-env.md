# Secrets And Environment

Dashboard production secrets come from Doppler project/config `rajohan/prd`.
Do not commit `.env`, `.env.local`, token dumps, or generated secret files.

## Required Core Runtime

| Variable                 | Required    | Used by                                  | Purpose                                                                                                     |
| ------------------------ | ----------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_GATEWAY_TOKEN` | Usually     | backend startup, auth bootstrap fallback | Authenticates the backend Gateway client to OpenClaw. Startup prefers this over the persisted SQLite token. |
| `PORT`                   | Optional    | backend server                           | HTTP port. Defaults to `3100`.                                                                              |
| `NODE_ENV`               | Recommended | backend/database                         | Production service sets `production`; tests set `test`.                                                     |

First-user bootstrap validates the submitted Gateway token and stores it as an
AES-256-GCM encrypted fallback envelope in `app_config.gateway_token`. The
external Dashboard secret-encryption key is required to decrypt it.
Environment token precedence is:

1. `OPENCLAW_GATEWAY_TOKEN`
2. persisted `app_config.gateway_token`

## Dashboard Storage And Paths

| Variable                      | Required                    | Fallback                               | Purpose                                                                                                   |
| ----------------------------- | --------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `MIRA_DASHBOARD_PROJECT_ROOT` | Explicit in production unit | `/home/ubuntu/projects/mira-dashboard` | Single host-layout root. Every production, state, release, preview, and worktree path is derived from it. |
| `OPENCLAW_HOME`               | Optional                    | `~/.openclaw`                          | Primary OpenClaw home for file/config/media/agent lookups when set.                                       |
| `WORKSPACE_ROOT`              | Optional                    | OpenClaw workspace                     | Root exposed by `/api/files`. Must be absolute and normalized if set.                                     |

Below, `<project-root>` means the validated
`MIRA_DASHBOARD_PROJECT_ROOT`; the fallback is
`/home/ubuntu/projects/mira-dashboard` only when that variable is unset.

Production accepts no per-path Dashboard overrides. The service unit supplies
only `MIRA_DASHBOARD_PROJECT_ROOT`; values with names such as
`MIRA_DASHBOARD_DB_PATH`, `MIRA_DASHBOARD_RELEASES_ROOT`,
`MIRA_DASHBOARD_ROOT`, and `MIRA_DASHBOARD_WORKTREE_ROOT` are internal
development/test child-process contracts. They are deliberately ignored in
production whenever the derived project layout is available and must not be
stored in Doppler or added to a production unit.

`MIRA_DASHBOARD_FRONTEND_PATH`, `MIRA_DASHBOARD_LOGS_ROOT`,
`MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE`, and
`MIRA_DASHBOARD_OPENCLAW_HOME` have the same internal-only status. They let an
isolated development child use its private state and let tests inject temporary
fixtures; they are not operator configuration.

Production mutable state lives in `<project-root>/production/state`, outside
both the control checkout and immutable releases. SQLite backups live below
that derived state root.
Versioned `backend/config/` files are release artifacts, not external state.
`OPENCLAW_HOME` remains the primary OpenClaw installation/configuration root;
`MIRA_DASHBOARD_OPENCLAW_HOME` is the separate Dashboard client identity root
and is never used as a fallback for primary OpenClaw files, agents, config,
workspace, or media.

## Network, Auth, And Browser Access

| Variable                                | Required                    | Default                        | Purpose                                                                                                                                 |
| --------------------------------------- | --------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `MIRA_DASHBOARD_ALLOWED_ORIGINS`        | Production browser access   | same-origin/localhost behavior | Comma-separated allowed origins for browser/WebSocket checks.                                                                           |
| `MIRA_DASHBOARD_AUTOMATION_CREDENTIALS` | Local non-browser callers   | none                           | Strict JSON list of hash-only, minimum-scope automation credentials. There is no loopback auth bypass.                                  |
| `MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY`  | Always                      | none                           | Base64 that decodes to exactly 32 bytes. External AES-256-GCM key for persisted Gateway token and TOTP seeds; preserve it with backups. |
| `MIRA_DASHBOARD_WEBAUTHN_RP_ID`         | Security-key enrollment/use | none                           | Stable DNS relying-party id, for example `dashboard.example.com`. Raw IP addresses are rejected.                                        |
| `MIRA_DASHBOARD_WEBAUTHN_ORIGINS`       | Security-key enrollment/use | none                           | Explicit comma-separated HTTPS origins belonging to the RP ID. `http://localhost` is allowed for dev only.                              |
| `MIRA_DASHBOARD_SESSION_IDLE_MINUTES`   | Optional                    | `30`                           | Idle session lifetime, integer `5`–`1440`. Polling alone does not refresh it.                                                           |
| `MIRA_DASHBOARD_RECENT_AUTH_MINUTES`    | Optional                    | `10`                           | Fresh password/MFA verification window, integer `1`–`60`.                                                                               |
| `MIRA_DASHBOARD_TRUSTED_PROXY_IPS`      | Optional                    | none                           | Trusted proxy IPs. Only use if the proxy strips or overwrites untrusted forwarding headers.                                             |
| `OPENCLAW_GATEWAY_URL`                  | Optional                    | `ws://127.0.0.1:18789`         | Gateway WebSocket URL.                                                                                                                  |

See [Auth and trust boundaries](../security/auth-and-trust-boundaries.md) for
route auth, scope names, token generation, two-step login, proxy trust,
bootstrap, recovery, and token handling.

Generate the Dashboard secret-envelope key in an untracked privileged shell and write it
directly to Doppler. Do not print or persist it in Dashboard output:

```bash
bun -e 'console.log(crypto.getRandomValues(new Uint8Array(32)).toBase64())'
```

Losing this key makes the persisted Gateway fallback and existing TOTP seeds
unusable after restore. It is not stored in SQLite. WebAuthn public keys and
password-hashed recovery validators need no equivalent decryption key.

## Execution Roles And Resource Scopes

Execution policy is code, not environment configuration. The web unit runs
`dist/serverStart.js`; the worker unit runs `dist/workerStart.js`. In
production, classified job children automatically run in constrained transient
scopes bound to `mira-dashboard-worker.service`. Local development uses the
combined server entry point and automatically selects the isolated job profile
when dev safe mode is active.

The tracked systemd units therefore preserve only `NODE_ENV` and
`MIRA_DASHBOARD_PROJECT_ROOT` through Doppler. Doppler remains the source of
auth, origin, provider, and credential values.

## GitHub And PR Operations

| Variable                    | Required for                           | Purpose                                                                                       |
| --------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `MIRA_GITHUB_TOKEN`         | PR list/merge/reject/deploy operations | Preferred GitHub token for agent-owned Dashboard operations.                                  |
| `RAJOHAN_GITHUB_TOKEN`      | PR review approval                     | Approves Mira-authored PR reviews as `rajohan`; merge/deploy continues to use the Mira token. |
| `GITHUB_TOKEN` / `GH_TOKEN` | Fallback                               | Used only after the Mira token.                                                               |

Do not expose these values in logs, docs, PR bodies, or reports.

Managed jobs always reuse the absolute Bun executable running the Dashboard.
There is no executable-path environment override.

## Docker Updater

| Variable                                     | Required for                                    | Purpose                                                                                                  |
| -------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `MIRA_DOCKER_COMPOSE_WRAPPER`                | Docker update execution                         | Compose wrapper path. Production commonly uses a Doppler-aware wrapper under `/opt/docker/bin`.          |
| `DOCKER_LOGIN`                               | Docker Hub private/rate-limited registry access | Docker Hub username. Required together with `DOCKER_TOKEN`; token alone is not used for Docker Hub auth. |
| `DOCKER_TOKEN`                               | Docker Hub private/rate-limited registry access | Docker Hub token. Required together with `DOCKER_LOGIN`.                                                 |
| `MIRA_GITHUB_USERNAME` / `MIRA_GITHUB_TOKEN` | GHCR access                                     | Auth for GHCR tag/digest lookup where needed.                                                            |

## External Feature Providers

| Variable             | Required for            | Purpose                                       |
| -------------------- | ----------------------- | --------------------------------------------- |
| `MOLTBOOK_API_KEY`   | Moltbook cache/features | Authenticates Moltbook API requests.          |
| `ELEVENLABS_API_KEY` | STT/TTS                 | ElevenLabs speech-to-text and text-to-speech. |
| `OPENROUTER_API_KEY` | Cache/provider checks   | Used by quota/cache refresh services.         |
| `SYNTHETIC_API_KEY`  | Synthetic cache checks  | Used by cache refresh services.               |

The ElevenLabs STT model and TTS model/voice are product constants in code. STT
uses `scribe_v2` without a `language_code`, allowing ElevenLabs to detect the
spoken language automatically. Changing these settings is a reviewed code
change, not a Doppler setting.

## Database Overview Integration

The Database page probes Postgres/PgBouncer using these values:

| Variable            | Default           | Purpose                      |
| ------------------- | ----------------- | ---------------------------- |
| `DATABASE_USERNAME` | `postgres`        | Postgres/PgBouncer user.     |
| `DATABASE_PASSWORD` | `postgres`        | Postgres/PgBouncer password. |
| `DATABASE_HOST`     | `postgres`        | Postgres host.               |
| `DATABASE_PORT`     | Postgres default  | Postgres port.               |
| `PGBOUNCER_HOST`    | `pgbouncer`       | PgBouncer host.              |
| `PGBOUNCER_PORT`    | PgBouncer default | PgBouncer port.              |

## Development Stack

`bun run dev` and `bun run dev:remote` select only
`OPENCLAW_GATEWAY_TOKEN`, `MIRA_DASHBOARD_SESSION_IDLE_MINUTES`, and
`MIRA_DASHBOARD_RECENT_AUTH_MINUTES`, plus the non-secret
`MIRA_DASHBOARD_WEBAUTHN_RP_ID`, from Doppler `rajohan/prd`. The explicit backend
child environment forwards the two auth timing values unchanged, uses the
production RP ID only to decide whether copied WebAuthn public credentials are
compatible, and does not inherit other provider or host credentials.

| Variable                                    | Default                                             | Purpose                                                                                                            |
| ------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `MIRA_DASHBOARD_DEV_FRONTEND_PORT`          | `5173`                                              | Frontend hot-reload port.                                                                                          |
| `MIRA_DASHBOARD_DEV_BACKEND_PORT`           | `3101`                                              | Backend restart-on-change port.                                                                                    |
| `MIRA_DASHBOARD_DEV_HOT_RELOAD`             | `1` when unset or empty                             | Accepts only `0` or `1`; enables frontend HMR and backend/frontend source watchers, while managed PR dev sets `0`. |
| `MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN`          | `http://localhost:5173`                             | Cookie/WebAuthn origin; remote dev derives the Tailscale HTTPS origin.                                             |
| `MIRA_DASHBOARD_DEV_STATE_ROOT`             | `<project-root>/development/state/local`            | Owner-only isolated development state.                                                                             |
| `MIRA_DASHBOARD_DEV_DB_SOURCE`              | `<project-root>/production/state/mira-dashboard.db` | Production database used only to create a scrubbed WAL-consistent snapshot.                                        |
| `MIRA_DASHBOARD_DEV_RELEASES_SOURCE`        | `<project-root>/production/releases`                | Managed releases copied into isolated state.                                                                       |
| `MIRA_DASHBOARD_DEV_WORKSPACE_SOURCE`       | `~/.openclaw/workspace`                             | Workspace copied with secret and symlink filtering.                                                                |
| `MIRA_DASHBOARD_DEV_OPENCLAW_CONFIG_SOURCE` | `~/.openclaw/openclaw.json`                         | Source for sanitized agent-only development config.                                                                |
| `MIRA_DASHBOARD_DEV_GATEWAY_URL`            | `ws://127.0.0.1:18789`                              | Live production Gateway used by trusted dev.                                                                       |
| `MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE`     | none                                                | Optional owner-only token file; local commands normally use Doppler environment.                                   |
| `HOST` / `PORT` / `DASHBOARD_API_TARGET`    | `127.0.0.1` / `5173` / `http://127.0.0.1:3101`      | Child frontend bind and exact backend proxy target.                                                                |

Managed PR dev has one fixed slot. Its checkout/state paths derive from
`MIRA_DASHBOARD_PROJECT_ROOT`; frontend `5173`, backend `3101`, proxy `18790`,
and transient unit names are code constants. `OPENCLAW_GATEWAY_URL` selects the
upstream Gateway when its default loopback URL is not sufficient. The trusted
GitHub authors (`mira-2026` and `rajohan`) are code constants too.

Variables such as `MIRA_DASHBOARD_DEV_STATE_ROOT`,
`MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE`, and the
`MIRA_DASHBOARD_PREVIEW_GATEWAY_*` values passed with `systemd-run --setenv`
are internal subprocess contracts. The Dashboard creates them from its resolved
configuration; they are not Doppler/operator settings.

See [Local development](../development/local-dev.md) for snapshot contents,
blocked production mutations, cookie isolation, and the managed trusted-PR
flow.

## CI

| Secret          | Required for   | Purpose                                                            |
| --------------- | -------------- | ------------------------------------------------------------------ |
| `CODECOV_TOKEN` | Codecov upload | Uploads frontend/backend LCOV with `frontend` and `backend` flags. |
