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

If no environment Gateway token is present, the first-user bootstrap can store a
token in `app_config.gateway_token`. Environment token precedence is:

1. `OPENCLAW_GATEWAY_TOKEN`
2. `OPENCLAW_TOKEN`
3. persisted `app_config.gateway_token`

## Dashboard Storage And Paths

| Variable                       | Required | Default                                           | Purpose                                                                                                                |
| ------------------------------ | -------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MIRA_DASHBOARD_DB_PATH`       | Optional | `backend/data/mira-dashboard.db` from backend cwd | SQLite database path.                                                                                                  |
| `MIRA_DASHBOARD_FRONTEND_PATH` | Optional | repo `dist/`                                      | Static frontend build served by the backend.                                                                           |
| `OPENCLAW_HOME`                | Optional | `~/.openclaw`                                     | Primary OpenClaw home for file/config/media/agent lookups when set.                                                    |
| `MIRA_DASHBOARD_OPENCLAW_HOME` | Optional | `~/.openclaw`                                     | Dashboard-specific fallback OpenClaw home. Most file/config/media routes use this only when `OPENCLAW_HOME` is absent. |
| `WORKSPACE_ROOT`               | Optional | OpenClaw workspace                                | Root exposed by `/api/files`. Must be absolute and normalized if set.                                                  |
| `MIRA_DASHBOARD_LOGS_ROOT`     | Optional | system log root default                           | Root used by log stream services.                                                                                      |
| `MIRA_LOG_ROTATION_CONFIG`     | Optional | `backend/config/log-rotation.json`                | Log rotation config path.                                                                                              |

## Network, Auth, And Browser Access

| Variable                              | Required | Default                        | Purpose                                                                                     |
| ------------------------------------- | -------- | ------------------------------ | ------------------------------------------------------------------------------------------- |
| `MIRA_DASHBOARD_ALLOWED_ORIGINS`      | Optional | same-origin/localhost behavior | Comma-separated allowed origins for browser/WebSocket checks.                               |
| `MIRA_DASHBOARD_TRUSTED_PROXY_IPS`    | Optional | none                           | Trusted proxy IPs. Only use if the proxy strips or overwrites untrusted forwarding headers. |
| `MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH` | Optional | disabled unless set            | Enables loopback auth bypass when set to `1`.                                               |
| `OPENCLAW_GATEWAY_URL`                | Optional | `ws://127.0.0.1:18789`         | Gateway WebSocket URL.                                                                      |

See [Auth and trust boundaries](../security/auth-and-trust-boundaries.md) for
route auth, loopback bypass, proxy trust, bootstrap, and token handling.

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

## Frontend Development

| Variable               | Default                 | Purpose                        |
| ---------------------- | ----------------------- | ------------------------------ |
| `HOST`                 | `0.0.0.0`               | Frontend dev server bind host. |
| `PORT`                 | `5173` for frontend dev | Frontend dev server port.      |
| `DASHBOARD_API_TARGET` | `http://localhost:3100` | Dev proxy target for `/api/*`. |

## CI

| Secret          | Required for   | Purpose                                                            |
| --------------- | -------------- | ------------------------------------------------------------------ |
| `CODECOV_TOKEN` | Codecov upload | Uploads frontend/backend LCOV with `frontend` and `backend` flags. |
