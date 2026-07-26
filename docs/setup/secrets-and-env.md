# Secrets And Environment

Dashboard production secrets come from Doppler project/config `rajohan/prd`.
Do not commit `.env`, `.env.local`, token dumps, or generated secret files.

## Required Core Runtime

| Variable                 | Required          | Used by                                  | Purpose                                                                                                     |
| ------------------------ | ----------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_GATEWAY_TOKEN` | Usually           | backend startup, auth bootstrap fallback | Authenticates the backend Gateway client to OpenClaw. Startup prefers this over the persisted SQLite token. |
| `OPENCLAW_TOKEN`         | Optional fallback | backend startup                          | Legacy/fallback Gateway token name. Used only if `OPENCLAW_GATEWAY_TOKEN` is absent.                        |
| `PORT`                   | Optional          | backend server                           | HTTP port. Defaults to `3100`.                                                                              |
| `NODE_ENV`               | Recommended       | backend/database                         | Production service sets `production`; tests set `test`.                                                     |

First-user bootstrap validates the submitted Gateway token and stores it as an
AES-256-GCM encrypted fallback envelope in `app_config.gateway_token`. The
external Dashboard secret-encryption key is required to decrypt it.
Environment token precedence is:

1. `OPENCLAW_GATEWAY_TOKEN`
2. `OPENCLAW_TOKEN`
3. persisted `app_config.gateway_token`

## Dashboard Storage And Paths

| Variable                                | Required                       | Default                                           | Purpose                                                                                                                            |
| --------------------------------------- | ------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `MIRA_DASHBOARD_DB_PATH`                | Explicit in production units   | `backend/data/mira-dashboard.db` from backend cwd | SQLite database path. Production uses `/home/ubuntu/projects/mira-dashboard-state/mira-dashboard.db`.                              |
| `MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE` | Explicit in production units   | `backend/data/log-rotation.lock` from backend cwd | Stable cross-release lock for elevated log rotation.                                                                               |
| `MIRA_DASHBOARD_FRONTEND_PATH`          | Optional                       | repo `dist/`                                      | Static frontend build served by the backend.                                                                                       |
| `OPENCLAW_HOME`                         | Optional                       | `~/.openclaw`                                     | Primary OpenClaw home for file/config/media/agent lookups when set.                                                                |
| `MIRA_DASHBOARD_OPENCLAW_HOME`          | Explicit in production units   | `backend/data/openclaw-client` from backend cwd   | Dashboard Gateway-client identity home. Production uses the persistent state root so its signed device identity survives releases. |
| `MIRA_DASHBOARD_RELEASE_ROOT`           | Explicit in production units   | inferred runtime root                             | Active immutable release root; production uses `/home/ubuntu/projects/mira-dashboard-releases/current`.                            |
| `MIRA_DASHBOARD_RELEASES_ROOT`          | Explicit in production tooling | `/home/ubuntu/projects/mira-dashboard-releases`   | Managed release layout containing `releases/`, `current`, `previous`, locks, and transition journal.                               |
| `WORKSPACE_ROOT`                        | Optional                       | OpenClaw workspace                                | Root exposed by `/api/files`. Must be absolute and normalized if set.                                                              |
| `MIRA_DASHBOARD_LOGS_ROOT`              | Optional                       | system log root default                           | Root used by log stream services.                                                                                                  |

`MIRA_DASHBOARD_FRONTEND_PATH` is a development/test escape hatch. Production
serves the active release's checksummed `dist/`; any configured value that does
not resolve exactly to that directory is rejected.

Production mutable state lives in
`/home/ubuntu/projects/mira-dashboard-state`, outside both the control checkout
and immutable releases. SQLite backups are derived as
`dirname(MIRA_DASHBOARD_DB_PATH)/backups`, so the production backup directory is
`/home/ubuntu/projects/mira-dashboard-state/backups/`. Versioned
`backend/config/` files are release artifacts, not external state.
`OPENCLAW_HOME` remains the primary OpenClaw installation/configuration root;
`MIRA_DASHBOARD_OPENCLAW_HOME` is the separate Dashboard client identity root
and is never used as a fallback for primary OpenClaw files, agents, config,
workspace, or media.

## Network, Auth, And Browser Access

| Variable                                | Required                    | Default                        | Purpose                                                                                                                                                    |
| --------------------------------------- | --------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIRA_DASHBOARD_ALLOWED_ORIGINS`        | Production browser access   | same-origin/localhost behavior | Comma-separated allowed origins for browser/WebSocket checks.                                                                                              |
| `MIRA_DASHBOARD_AUTOMATION_CREDENTIALS` | Local non-browser callers   | none                           | Strict JSON list of hash-only, minimum-scope automation credentials. There is no loopback auth bypass.                                                     |
| `MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY`  | Always                      | none                           | Base64 that decodes to exactly 32 bytes. External AES-256-GCM key for persisted Gateway token and TOTP seeds; preserve it with backups.                    |
| `MIRA_DASHBOARD_COOKIE_NAMESPACE`       | Optional                    | `mira_dashboard`               | Prefix for session and pending-login cookies. Dev stacks set a port-specific namespace so login cannot replace the production cookie on the same hostname. |
| `MIRA_DASHBOARD_WEBAUTHN_RP_ID`         | Security-key enrollment/use | none                           | Stable DNS relying-party id, for example `dashboard.example.com`. Raw IP addresses are rejected.                                                           |
| `MIRA_DASHBOARD_WEBAUTHN_ORIGINS`       | Security-key enrollment/use | none                           | Explicit comma-separated HTTPS origins belonging to the RP ID. `http://localhost` is allowed for dev only.                                                 |
| `MIRA_DASHBOARD_SESSION_IDLE_MINUTES`   | Optional                    | `30`                           | Idle session lifetime, integer `5`–`1440`. Polling alone does not refresh it.                                                                              |
| `MIRA_DASHBOARD_RECENT_AUTH_MINUTES`    | Optional                    | `10`                           | Fresh password/MFA verification window, integer `1`–`60`.                                                                                                  |
| `MIRA_DASHBOARD_TRUSTED_PROXY_IPS`      | Optional                    | none                           | Trusted proxy IPs. Only use if the proxy strips or overwrites untrusted forwarding headers.                                                                |
| `OPENCLAW_GATEWAY_URL`                  | Optional                    | `ws://127.0.0.1:18789`         | Gateway WebSocket URL.                                                                                                                                     |

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

| Variable                           | Production value    | Purpose                                                                                    |
| ---------------------------------- | ------------------- | ------------------------------------------------------------------------------------------ |
| `MIRA_DASHBOARD_EXECUTION_ROLE`    | `web` / `worker`    | Keeps HTTP/WebSocket handling in the web unit and scheduler/executor work in the worker.   |
| `MIRA_DASHBOARD_ENABLE_JOB_SCOPES` | `1` in both units   | Runs classified job children in constrained transient user scopes.                         |
| `MIRA_DASHBOARD_JOB_SCOPE_OWNER`   | owning service unit | Binds transient scopes to their service lifecycle so restarts terminate orphaned children. |
| `MIRA_DASHBOARD_DISABLE_SCHEDULER` | unset in production | Development/test escape hatch; `1` disables scheduler/executor startup.                    |

The tracked systemd units set these orchestration values directly and preserve
them, together with `NODE_ENV` and the managed state/release paths, through
Doppler. Doppler remains the source of auth, origin, provider, and credential
values. Production actions run in the worker, so their child scopes bind to
`mira-dashboard-worker.service`; restarting only the web unit leaves them
untouched.

## GitHub And PR Operations

| Variable                    | Required for                             | Purpose                                                         |
| --------------------------- | ---------------------------------------- | --------------------------------------------------------------- |
| `MIRA_GITHUB_TOKEN`         | PR list/approve/reject/deploy operations | Preferred GitHub token for agent-owned Dashboard operations.    |
| `MIRA_GITHUB_TOKEN_*`       | Optional                                 | Additional token candidates picked up by PR services.           |
| `RAJOHAN_GITHUB_TOKEN`      | Review/deploy flows                      | Raymond-owner token for operations that need owner permissions. |
| `RAJOHAN_GITHUB_USERNAME`   | Optional                                 | Reviewer username override.                                     |
| `GITHUB_TOKEN` / `GH_TOKEN` | Fallback                                 | Used only after preferred tokens.                               |
| `BUN_BINARY`                | Optional                                 | Overrides Bun executable for deploy/log-rotation jobs.          |

Do not expose these values in logs, docs, PR bodies, or reports.

## Docker Updater

| Variable                                     | Required for                                    | Purpose                                                                                                  |
| -------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `MIRA_DOCKER_COMPOSE_WRAPPER`                | Docker update execution                         | Compose wrapper path. Production commonly uses a Doppler-aware wrapper under `/opt/docker/bin`.          |
| `MIRA_DOCKER_UPDATER_PLATFORM`               | Optional                                        | Overrides host Docker platform selection.                                                                |
| `MIRA_DOCKER_UPDATER_SKIP_REGISTRY`          | Optional                                        | Set `1` to skip registry checks. Useful for tests/debugging only.                                        |
| `DOCKER_LOGIN`                               | Docker Hub private/rate-limited registry access | Docker Hub username. Required together with `DOCKER_TOKEN`; token alone is not used for Docker Hub auth. |
| `DOCKER_TOKEN`                               | Docker Hub private/rate-limited registry access | Docker Hub token. Required together with `DOCKER_LOGIN`.                                                 |
| `MIRA_GITHUB_USERNAME` / `MIRA_GITHUB_TOKEN` | GHCR access                                     | Auth for GHCR tag/digest lookup where needed.                                                            |

## External Feature Providers

| Variable                                          | Required for            | Purpose                                              |
| ------------------------------------------------- | ----------------------- | ---------------------------------------------------- |
| `MOLTBOOK_API_KEY`                                | Moltbook cache/features | Authenticates Moltbook API requests.                 |
| `ELEVENLABS_API_KEY`                              | STT/TTS                 | ElevenLabs speech-to-text and text-to-speech.        |
| `ELEVENLABS_STT_MODEL`                            | Optional                | Defaults to `scribe_v2`.                             |
| `ELEVENLABS_STT_LANGUAGE`                         | Optional                | Defaults to `nor`; use `auto` to omit language code. |
| `ELEVENLABS_TTS_MODEL`                            | Optional                | Defaults to `eleven_turbo_v2_5`.                     |
| `ELEVENLABS_TTS_VOICE_ID` / `ELEVENLABS_VOICE_ID` | TTS                     | Voice ID for `/api/tts/speak`.                       |
| `OPENROUTER_API_KEY`                              | Cache/provider checks   | Used by quota/cache refresh services.                |
| `SYNTHETIC_API_KEY`                               | Synthetic cache checks  | Used by cache refresh services.                      |

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

| Variable                                      | Default                                             | Purpose                                                                          |
| --------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| `MIRA_DASHBOARD_DEV_FRONTEND_PORT`            | `5173`                                              | Frontend hot-reload port.                                                        |
| `MIRA_DASHBOARD_DEV_BACKEND_PORT`             | `3101`                                              | Backend restart-on-change port.                                                  |
| `MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN`            | `http://localhost:5173`                             | Cookie/WebAuthn origin; remote dev derives the Tailscale HTTPS origin.           |
| `MIRA_DASHBOARD_DEV_SOURCE_WEBAUTHN_RP_ID`    | production `MIRA_DASHBOARD_WEBAUTHN_RP_ID`          | Source snapshot RP used to retain or remove copied WebAuthn public credentials.  |
| `MIRA_DASHBOARD_DEV_STATE_ROOT`               | `~/projects/mira-dashboard-dev-state/local`         | Owner-only isolated development state.                                           |
| `MIRA_DASHBOARD_DEV_DB_SOURCE`                | `~/projects/mira-dashboard-state/mira-dashboard.db` | Production database used only to create a scrubbed WAL-consistent snapshot.      |
| `MIRA_DASHBOARD_DEV_RELEASES_SOURCE`          | `~/projects/mira-dashboard-releases`                | Managed releases copied into isolated state.                                     |
| `MIRA_DASHBOARD_DEV_WORKSPACE_SOURCE`         | `~/.openclaw/workspace`                             | Workspace copied with secret and symlink filtering.                              |
| `MIRA_DASHBOARD_DEV_OPENCLAW_CONFIG_SOURCE`   | `~/.openclaw/openclaw.json`                         | Source for sanitized agent-only development config.                              |
| `MIRA_DASHBOARD_DEV_GATEWAY_URL`              | `ws://127.0.0.1:18789`                              | Live production Gateway used by trusted dev.                                     |
| `MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE`       | none                                                | Optional owner-only token file; local commands normally use Doppler environment. |
| `MIRA_DASHBOARD_PREVIEW_GATEWAY_TOKEN_FILE`   | `<managed-preview-root>/gateway.token`              | Host-local `0600` token materialized by prod backend for trusted PR dev.         |
| `MIRA_DASHBOARD_PREVIEW_OPENCLAW_SOURCE_ROOT` | `/home/ubuntu/.openclaw`                            | Source root for managed PR workspace/config snapshots.                           |
| `HOST` / `PORT` / `DASHBOARD_API_TARGET`      | `127.0.0.1` / `5173` / `http://127.0.0.1:3101`      | Child frontend bind and exact backend proxy target.                              |

See [Local development](../development/local-dev.md) for snapshot contents,
blocked production mutations, cookie isolation, and the managed trusted-PR
flow.

## CI

| Secret          | Required for   | Purpose                                                            |
| --------------- | -------------- | ------------------------------------------------------------------ |
| `CODECOV_TOKEN` | Codecov upload | Uploads frontend/backend LCOV with `frontend` and `backend` flags. |
