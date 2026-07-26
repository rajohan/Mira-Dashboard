# Local Development

Dashboard has one development mode. It is intentionally close to production:
frontend, backend, scheduler/worker, authentication, files, agents, sessions,
and chat all run through the same application paths.

## Install

From the repository or PR worktree:

```bash
bun install --frozen-lockfile
bun --cwd backend install --frozen-lockfile
```

## Start

Localhost HTTP is sufficient for local WebAuthn:

```bash
bun run dev
```

For a stable HTTPS origin and access from another Tailscale device:

```bash
bun run dev:remote
```

The remote command creates or reuses an exact Tailscale Serve route and prints
the HTTPS URL. On a clean exit it removes a route that it created itself. A
route enabled explicitly remains until it is disabled. Related commands are:

```bash
bun run dev:remote:status
bun run dev:remote:enable
bun run dev:remote:disable
```

Both start commands run:

- Bun frontend hot reload on `127.0.0.1:5173`;
- Bun backend restart-on-change on `127.0.0.1:3101`;
- the normal React Compiler and Tailwind development pipeline;
- one isolated Dashboard SQLite database;
- one writable snapshot of the production OpenClaw workspace;
- a combined, isolated scheduler/worker;
- the live production OpenClaw Gateway.

There is no separate reduced preview mode and no permanent development systemd
unit.

## Isolated State

Local state defaults to:

```text
/home/ubuntu/projects/mira-dashboard-dev-state/local/
```

It contains:

```text
mira-dashboard.db
openclaw-home/workspace/
openclaw-client/
releases-root/
```

The first start creates WAL-consistent snapshots from the production Dashboard
database, OpenClaw workspace, and managed releases. Later starts reuse them so
changes made while testing remain available.

The database snapshot removes active sessions and pending logins, WebAuthn
challenges, TOTP/recovery secrets, the persisted Gateway token, deployment/job
runtime state, and chat replay snapshots. Existing Dashboard users, password
hashes, and WebAuthn public credentials remain available. Cache refresh and
SQLite maintenance jobs retain their enabled state and schedule. Backup,
Docker, deploy, workspace-sync, and log-rotation jobs are forced disabled.

The workspace copy rejects symlinks and excludes Git metadata, credential/secret
directories, private-key names, `.env` files, and token/secret files. Safe
templates such as `.env.example` remain available. The generated
`openclaw.json` contains only sanitized agent configuration and points workspace
paths at the snapshot.

All state roots are owner-only and untracked. Refresh the snapshots by stopping
dev and running:

```bash
bun run dev:state:reset
bun run dev:state:prepare
```

Reset refuses to remove a directory unless it carries the exact development
ownership marker.

## Gateway And Safety Boundary

Dev reads `OPENCLAW_GATEWAY_TOKEN` from Doppler `rajohan/prd` at process start.
`MIRA_DASHBOARD_SESSION_IDLE_MINUTES` and
`MIRA_DASHBOARD_RECENT_AUTH_MINUTES` are selected from the same config and
forwarded unchanged, so login and elevated-auth timing matches production.

The child backend receives only an explicit environment allowlist. Secret values
do not appear in tracked code, package arguments, logs, snapshots, or browser
responses.

The shared Gateway makes agents, sessions, chat, and runtime status realistic.
It also means these allowed dev operations affect production Gateway data:

- send or abort chat runs;
- change model, thinking, or speed through `sessions.patch`;
- read live Gateway state.

Dev blocks Gateway config/cron/destructive-session RPCs and HTTP mutations for
production config, cron, sessions, host operations, backups, Docker, terminal,
exec, PR actions, and restarts. File and Dashboard-record mutations target only
the isolated snapshots.

The isolated worker registers the scheduler and safe local maintenance/cache
adapters. It does not register Kopia, WAL-G, Docker, deploy, PR, exec, log
rotation, or OpenClaw restart actions.

Dev cookies use a port-specific namespace. Logging into dev therefore does not
replace the production Dashboard session on the same Tailscale hostname, and
the frontend proxy strips non-dev Dashboard cookies before forwarding requests.

## Managed PR Dev

The Pull requests page exposes one shared **PR dev** slot:

- only PRs targeting `main` from the configured trusted-author allowlist can
  start;
- dependencies install with frozen lockfiles and lifecycle scripts disabled;
- source and Git metadata are read-only inside a Bubblewrap sandbox;
- state is stored under
  `/home/ubuntu/projects/mira-dashboard-preview-state/managed/states/pr-<number>/`;
- Tailscale provides HTTPS;
- a transient user unit enforces CPU, IO, memory, task, and four-hour runtime
  limits;
- stop removes the owned Tailscale route and materialized Gateway-token file,
  while keeping the worktree and isolated state for a faster restart.

The production backend decrypts its persisted Gateway token only when starting
trusted PR dev. It atomically writes an owner-only `0600` file outside the
repository and mounts that file read-only into the sandbox. The value is never
sent to the browser or included in the unit command. Trusted PR code can read
the token inside its sandbox because direct production-Gateway compatibility
requires it; this is why untrusted authors are rejected rather than given a
partial mode.

## Overrides

The stack validates all configured ports, origins, URLs, and paths. Useful
overrides include:

```text
MIRA_DASHBOARD_DEV_FRONTEND_PORT
MIRA_DASHBOARD_DEV_BACKEND_PORT
MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN
MIRA_DASHBOARD_DEV_STATE_ROOT
MIRA_DASHBOARD_DEV_DB_SOURCE
MIRA_DASHBOARD_DEV_RELEASES_SOURCE
MIRA_DASHBOARD_DEV_WORKSPACE_SOURCE
MIRA_DASHBOARD_DEV_OPENCLAW_CONFIG_SOURCE
MIRA_DASHBOARD_DEV_GATEWAY_URL
MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE
```

Use overrides only with absolute, non-root state/source paths. The ordinary
commands already select the host's production snapshots and runtime Gateway.

## Verification

Run commands from the repository root:

```bash
bun run lint:frontend
bun run lint:backend
bun run build:frontend
bun run build:backend
bun run test:frontend
bun run test:backend
bun run test:frontend:coverage
bun run test:backend:coverage
bun run format:check
```

Use Bun, keep backend imports on `.ts`, reuse shared frontend components, and do
not commit generated state, build output, database files, environment files, or
token output.
