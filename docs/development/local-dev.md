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

The ordinary commands run directly from the repository or feature worktree in
which they were started. There is no permanent development systemd unit.

## Isolated State

Local state defaults to:

```text
/home/ubuntu/projects/mira-dashboard/development/state/local/
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
challenges, TOTP/recovery secrets, the persisted Gateway token, active
deployment locks/nonterminal deployment jobs, job-execution runtime, and chat
replay snapshots. Terminal release-job history remains available as read-only
dev context. Existing Dashboard users and password hashes remain available.
WebAuthn public credentials remain available only when the source and
development relying-party IDs match. For a different RP, such as the default
`localhost`, the snapshot removes incompatible credentials and disables MFA so
password login and local factor enrollment remain possible. Cache refresh and
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

The isolated worker registers the scheduler, SQLite maintenance, and only the
database-summary cache job. It does not register the host-facing weather,
quota, system, git, backup, Docker, or Moltbook cache jobs, nor Kopia, WAL-G,
deploy, PR, exec, log rotation, or OpenClaw restart actions.

Dev cookies use a port-specific namespace. Logging into dev therefore does not
replace the production Dashboard session on the same Tailscale hostname, and
the frontend proxy strips non-dev Dashboard cookies before forwarding requests.

## Managed PR Dev

The Delivery page exposes one shared **PR dev** slot:

- Only PRs targeting `main` from the configured trusted-author allowlist can
  start.
- The exact PR commit is checked out at
  `/home/ubuntu/projects/mira-dashboard/development/preview`.
- Dependencies install with frozen lockfiles and lifecycle scripts disabled.
- Source and Git metadata are read-only inside a Bubblewrap sandbox.
- Source watchers and frontend HMR are disabled because the managed checkout is
  fixed and read-only. Ordinary `bun run dev` and `bun run dev:remote` still
  provide frontend and backend hot reload from their current worktree.
- State is stored under
  `/home/ubuntu/projects/mira-dashboard/development/state/preview/states/pr-<number>/`.
- Tailscale publishes HTTPS only after the managed frontend/backend pair is
  locally ready.
- Separate transient user units run the sandbox and a host-owned Gateway
  capability proxy. Both enforce CPU, IO, memory, task, and four-hour runtime
  limits; no permanent unit file is installed.
- Stop removes the owned Tailscale route, stops both transient units, and removes
  materialized credentials while keeping the shared checkout and isolated PR
  state for a faster restart while the PR remains open.
- Merge or rejection through Delivery removes the closed PR's isolated state.
  If that PR owns the slot, it also removes the shared checkout and active
  preview record.
- A successful Delivery refresh also reconciles a PR closed or merged directly
  on GitHub. Cleanup is rechecked in the exclusive worker before any data is
  removed, so a still-open PR is kept.
- Status reconciliation performs the same unit, route, and credential cleanup
  if a transient unit exits, is collected, or reaches its four-hour limit.

`bun-cache` is a shared dependency cache retained between PRs to speed up frozen
installs. `installer-home` is an isolated, normally empty home directory for
those installs; both live directly under `development/state/preview`, and
neither contains per-PR application state.

The production backend decrypts its persisted Gateway token only when starting
trusted PR dev. It atomically writes that token to an owner-only `0600` file
outside the repository for the host-owned proxy, then removes the file as soon
as the proxy has authenticated. The production token is never mounted into the
sandbox, sent to the browser, or included in a unit command.

The sandbox instead receives a separate random `0600` proxy-token file. That
credential works only against the loopback proxy, which forwards the explicit
read/chat/session allowlist, including redacted config reads and cron listing,
while rejecting config writes, cron mutations, destructive-session, and other
host-capability RPCs. Unrelated Gateway event families are filtered at the same
boundary. A PR can read its disposable proxy token, but cannot use it to
authenticate directly to the production Gateway.

## Overrides

The stack validates all configured ports, origins, URLs, and paths. Useful
overrides include:

```text
MIRA_DASHBOARD_PROJECT_ROOT
MIRA_DASHBOARD_DEV_FRONTEND_PORT
MIRA_DASHBOARD_DEV_BACKEND_PORT
MIRA_DASHBOARD_DEV_HOT_RELOAD
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
Managed PR dev paths are always derived from `MIRA_DASHBOARD_PROJECT_ROOT`.

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

During development, `bun run test:changed` runs only frontend and backend tests
affected by uncommitted changes. Run the full test and coverage commands before
push.

Use Bun, keep backend imports on `.ts`, reuse shared frontend components, and do
not commit generated state, build output, database files, environment files, or
token output.
