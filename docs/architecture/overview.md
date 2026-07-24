# Architecture Overview

Mira Dashboard is a local operations dashboard for Mira/OpenClaw. It is designed
as a trusted, single-operator control surface rather than a multi-tenant SaaS
application.

## Runtime Components

```text
Browser
  |
  | HTTP + /ws
  v
Mira Dashboard web on :3100
  |-- static frontend from dist/
  |-- /api/* route table
  |-- authenticated Dashboard WebSocket
  |-- OpenClaw Gateway WebSocket --> OpenClaw Gateway on :18789
  `-- SQLite via bun:sqlite <------------------.
                                               |
Mira Dashboard worker                         |
  |-- scheduler                               |
  |-- bounded action executor                 |
  |-- resource-scoped child processes         |
  `-- persistent execution queue (SQLite) ----'
```

## Frontend

- React 19.
- TanStack Router routes in `src/router.tsx`.
- TanStack Query and TanStack DB collections for data fetching/state.
- Shared UI primitives in `src/components/ui`.
- Domain pages in `src/pages`.
- Feature components under `src/components/features`.
- React Compiler is enabled; avoid routine `useMemo` and `useCallback` unless
  semantics require stable identity for a third-party contract.

Primary pages:

| Path             | Purpose                                                  |
| ---------------- | -------------------------------------------------------- |
| `/`              | Operations dashboard overview.                           |
| `/tasks`         | Local task board and task updates.                       |
| `/agents`        | Agent status and task history.                           |
| `/sessions`      | OpenClaw session table and actions.                      |
| `/chat`          | Gateway-backed chat UI.                                  |
| `/logs`          | Log file browsing/tailing.                               |
| `/jobs`          | Dashboard scheduled jobs.                                |
| `/reports`       | Daily briefs, summaries, heartbeats, and custom reports. |
| `/pull-requests` | Dashboard PR review/deploy operations.                   |
| `/files`         | Workspace file browser/editor.                           |
| `/docker`        | Docker state and managed updater.                        |
| `/database`      | Postgres/PgBouncer and Dashboard SQLite overview.        |
| `/moltbook`      | Moltbook dashboard.                                      |
| `/settings`      | OpenClaw/Dashboard settings.                             |
| `/terminal`      | Terminal helper/completion UI.                           |

## Backend

The backend is native Bun:

- `Bun.serve({ routes, fetch, websocket })`
- `bun:sqlite`
- `Bun.spawn` / `Bun.spawnSync`
- `Bun.CryptoHasher`, `Bun.randomUUIDv7`, `Bun.file`, `Bun.write`, and
  `import.meta.main` where their contracts fit
- no Express server

Bun's documented Node compatibility layer remains intentional for APIs Bun
does not expose directly: path manipulation, host/temporary-directory
information, directory enumeration, permission/no-follow filesystem
operations, synchronous Ed25519 key handling, and request-scoped
`AsyncLocalStorage`.

Key files:

| File                                     | Responsibility                                                    |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `backend/src/server.ts`                  | HTTP server, static frontend serving, `/ws` upgrade.              |
| `backend/src/routes.ts`                  | Route table assembly.                                             |
| `backend/src/requestPolicy.ts`           | Auth requirement, rate limiting, error wrapper.                   |
| `backend/src/automationAuth.ts`          | Hash-only automation credentials and route capability mapping.    |
| `backend/src/requestSecurity.ts`         | Mutation provenance, request IDs, browser response headers.       |
| `backend/src/requestAuditContext.ts`     | Request actor/correlation context for queued work.                |
| `backend/src/http.ts`                    | JSON helpers, cookies, origin/proxy/IP helpers.                   |
| `backend/src/services/auditEvents.ts`    | Redacted append-only audit persistence and cursor reads.          |
| `backend/src/gateway.ts`                 | OpenClaw Gateway client lifecycle and Dashboard WebSocket fanout. |
| `backend/src/database.ts`                | SQLite path, PRAGMAs, migration startup, database proxy.          |
| `backend/src/databaseMigrationRunner.ts` | Version/checksum validation and transactional migrations.         |
| `backend/src/sqliteBackup.ts`            | WAL-safe snapshots, restore verification, and retention.          |
| `backend/src/serverStart.ts`             | HTTP/WebSocket production startup (or combined fallback role).    |
| `backend/src/workerStart.ts`             | Dedicated scheduler/executor production startup.                  |

## Authentication

All `/api/*` routes are authenticated except:

- `/api/health`
- the exact bootstrap, session-state, login-factor, and logout endpoints under
  `/api/auth/*`.

The browser authenticates with an HTTP-only session cookie. Password-first
login creates only a short-lived pending cookie when MFA is enabled; the
durable session is created after WebAuthn, TOTP, or recovery verification.
Sessions have absolute and idle expiration, and privileged actions require
recent second-factor verification. Non-browser callers may use a hash-only
bearer identity, but only for centrally mapped capabilities. Direct loopback is
not an authentication mechanism. The first-user bootstrap flow validates the
OpenClaw Gateway token before creating the first user, then directs the
operator to Dashboard settings to enroll MFA.

Rate limits:

- auth routes: `20` requests/minute per client bucket;
- other API routes: `600` requests/minute per client bucket.

If trusted proxy headers are enabled, the proxy must strip or overwrite
untrusted `X-Real-IP` and `X-Forwarded-For` headers before forwarding.

Unsafe browser API methods additionally pass exact Origin and Fetch Metadata
checks before authentication. API and static responses receive central CSP,
clickjacking, MIME-sniffing, referrer, permissions, and request-correlation
headers. Direct non-browser clients remain supported when provenance headers
are absent. They still require a scoped credential or session.

## Gateway Integration

The backend holds one persistent OpenClaw Gateway client and exposes gateway
state to the browser through a Dashboard WebSocket.

Startup token precedence:

1. `OPENCLAW_GATEWAY_TOKEN`
2. `OPENCLAW_TOKEN`
3. decrypted `app_config.gateway_token` AES-GCM envelope

The Dashboard WebSocket at `/ws` requires:

- allowed origin;
- authenticated Dashboard user.

See [Gateway and chat runtime](gateway-and-chat.md) for bootstrap validation,
token recovery, browser WebSocket behavior, and chat event handling.

## Background Jobs

The dedicated worker registers scheduled jobs and every long-running or
mutating execution-plane adapter. The web process validates requests, enqueues
work in SQLite, and observes persisted result/progress snapshots when an API
must retain a synchronous response shape. Restarting the web process therefore
does not terminate worker-owned deploy, exec, Docker, backup, cache refresh,
log rotation, GitHub, or OpenClaw restart actions.

Worker startup registers scheduled jobs for:

- backups;
- cache refresh;
- Dashboard SQLite backup, retention, optimization, and passive checkpoint;
- Docker updater;
- log rotation;
- quota notifications;
- OpenClaw update notifications;
- scheduled job runner.

Production uses `MIRA_DASHBOARD_EXECUTION_ROLE=web` and `worker` in separate
systemd services. The default `combined` role exists for compatibility and
tests; local backend development disables it through
`MIRA_DASHBOARD_DISABLE_SCHEDULER=1`.

See [Scheduler, cache, and backups](../operations/scheduler-cache-backups.md)
for job tables, cache entries, backup scripts, and inspection commands.
