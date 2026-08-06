# Mira Dashboard

[![frontend coverage](https://img.shields.io/codecov/c/github/rajohan/Mira-Dashboard?branch=main&flag=frontend&label=frontend%20coverage&logo=codecov)](https://codecov.io/gh/rajohan/Mira-Dashboard)
[![backend coverage](https://img.shields.io/codecov/c/github/rajohan/Mira-Dashboard?branch=main&flag=backend&label=backend%20coverage&logo=codecov)](https://codecov.io/gh/rajohan/Mira-Dashboard)
[![checks](https://img.shields.io/github/actions/workflow/status/rajohan/Mira-Dashboard/dashboard-checks.yml?branch=main&label=checks&logo=github)](https://github.com/rajohan/Mira-Dashboard/actions/workflows/dashboard-checks.yml)
[![codeql](https://img.shields.io/github/actions/workflow/status/rajohan/Mira-Dashboard/codeql.yml?branch=main&label=codeql&logo=github)](https://github.com/rajohan/Mira-Dashboard/actions/workflows/codeql.yml)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun)](https://bun.sh)
[![License](https://img.shields.io/github/license/rajohan/Mira-Dashboard)](LICENSE)

Mira Dashboard is Raymond's local control surface for Mira/OpenClaw operations. It combines a React frontend with a Bun-native backend that mirrors OpenClaw Gateway state, serves operational APIs, and persists dashboard-owned state in SQLite.

## Documentation

The full repo-native wiki lives in [docs/index.md](docs/index.md). Start there
for new VPS setup, production deployment, env vars, architecture, API
reference, operations runbooks, reports delivery, and development workflow.

## What it includes

- Password-first Dashboard login with WebAuthn security keys, authenticator-app
  TOTP, one-time recovery codes, idle session expiry, and fresh-MFA step-up for
  privileged actions.
- Authenticated routes for chat, sessions, agents, tasks, logs, files, cron,
  Docker updater state, database checks, Moltbook, terminal access, and
  separate OpenClaw/Dashboard settings.
- A backend API on port `3100` with route modules under `backend/src/routes`.
- A shared WebSocket bridge for live OpenClaw Gateway updates.
- Local SQLite storage for dashboard tasks, task updates, notifications,
  selector/validator auth state, encrypted TOTP factors, WebAuthn public keys,
  hashed recovery codes, quota alert state, OpenClaw alert state, and agent task
  history.
- Bun/TanStack Router frontend on port `5173` during development, proxying `/api` to the backend.

## Repository layout

```text
frontend/                React HTML entrypoint, assets, application code, and tests
backend/src/             Bun backend, Gateway bridge, route modules, services, and DB setup
contracts/               Shared frontend/backend wire contracts and runtime schemas
scripts/                 Shared build, development, release, and repository tooling
dist/                    Bun production frontend build output
```

## Local development

The repository selects Bun Canary through `.bun-version`. Install or update that channel before
installing dependencies:

```bash
bun upgrade --canary
```

Then install all frontend, backend, and tooling dependencies from the repo root:

```bash
bun install --frozen-lockfile
```

The application targets the Bun 1.4 runtime API. Immutable release manifests still record the
exact Bun revision used for each build. The committed Bun config keeps the runtime-only
`bun-plugin-tailwind` peer from installing a second, stale Bun executable into `node_modules`.

Run the complete local dev stack:

```bash
bun run dev
```

For WebAuthn and access from another Tailscale device, use the HTTPS route:

```bash
bun run dev:remote
```

Both commands start frontend and backend hot reload, React Compiler, an isolated
Dashboard database/workspace snapshot, and a dev-only scheduler/worker. Dev
connects to the live OpenClaw Gateway, so chat and session changes can affect
production data. Production host, backup, config, cron, destructive session,
and PR actions remain blocked.

Only the Gateway token, production auth timing values, and non-secret WebAuthn
RP ID are selected from Doppler (`rajohan` / `prd`) at runtime. The RP ID is
used to discard incompatible copied WebAuthn credentials for local development.
No secret values are stored in scripts or tracked files. See
[Local development](docs/development/local-dev.md) for state paths, reset
commands, and the trusted PR-dev flow.

## Verification commands

From the repo root:

```bash
bun run lint
bun run format:check
bun run build
bun run test:frontend
bun run test:backend
bun run test:frontend:coverage
bun run test:backend:coverage
```

Use the smallest meaningful gate for the change you are making. For docs-only changes, `git diff --check` is usually enough; for frontend/backend code changes, prefer lint plus the relevant build.

Frontend and backend tests run directly with Bun. Coverage LCOV files are uploaded to Codecov from CI for PR status, diff coverage, and trend visibility.

Production preparation is deliberately separate from ordinary builds:

```bash
/usr/local/bin/doppler run --config prd --project rajohan -- \
  bun run deploy:prepare
```

This builds both applications, runs the restore-verified SQLite preflight, and
writes the checksummed release manifest used by production readiness and
activation. Use it before a production restart; plain `build` remains safe for
CI and local verification.

## Runtime notes

- Backend default port: `3100`.
- Frontend dev port: `5173`.
- Health endpoints: public `/api/health/live`, public `/api/health/ready`, and
  authenticated `/api/health/diagnostics`.
- Dashboard SQLite uses WAL, numbered checksum-validated migrations,
  restrictive storage modes, deploy/maintenance snapshots, and automated
  restore checks.
- Frontend builds and the local frontend dev server use Bun's HTML bundler with Babel React Compiler and Bun Tailwind plugins.
- Dev servers bind to loopback. `bun run dev:remote` publishes the frontend
  through an explicit Tailscale Serve HTTPS route.
- Auth is enforced by the backend request policy for every API route except
  `GET|HEAD /api/health/live`, `GET|HEAD /api/health/ready`,
  `GET|HEAD /api/auth/bootstrap`,
  `POST /api/auth/register-first-user`, `POST /api/auth/login`,
  `POST /api/auth/login/totp`, `POST /api/auth/login/recovery`,
  `POST /api/auth/login/webauthn/options`,
  `POST /api/auth/login/webauthn/verify`, `POST /api/auth/logout`, and
  `GET|HEAD /api/auth/session`. Factor management lives under authenticated
  `/api/account/security/*`. Hash-only automation credentials can reach only
  centrally mapped minimum scopes, never Terminal/exec or the other privileged
  route families.
- Direct loopback requests do not bypass authentication. Local automation,
  including heartbeat/report/task callers, must send a minimum-scope automation
  bearer credential. If `MIRA_DASHBOARD_TRUSTED_PROXY_IPS` is configured, the
  trusted proxy must overwrite or strip inbound `X-Real-IP` and
  `X-Forwarded-For` headers from untrusted clients.

## Production checkout and PR worktrees

`/home/ubuntu/projects/mira-dashboard/production/checkout` is the clean production control checkout. Keep it on `main`; after Raymond approves a merge/deploy, the deploy workflow updates this source and builds the exact commit in an isolated detached worktree. Production never builds in or executes from the control checkout.

Feature and autopilot work must use separate git worktrees under `/home/ubuntu/projects/mira-dashboard/development/worktrees`, for example:

```bash
mkdir -p /home/ubuntu/projects/mira-dashboard/development/worktrees
git -C /home/ubuntu/projects/mira-dashboard/production/checkout fetch --prune origin
git -C /home/ubuntu/projects/mira-dashboard/production/checkout worktree add \
  -b mira/<short-slug> \
  /home/ubuntu/projects/mira-dashboard/development/worktrees/<short-slug> \
  main
```

Run lint/build verification inside the worktree, not the production checkout. This prevents unapproved PR branches from writing live `dist/` or `backend/dist` artifacts.

The Dashboard PR approval/rejection endpoints attempt to remove the matching local worktree after a PR is merged or rejected. Cleanup is best-effort: it only removes paths under `/home/ubuntu/projects/mira-dashboard/development/worktrees` and skips worktrees with uncommitted changes.

## Safety notes for agents

- Do not merge PRs, deploy, restart services, rotate secrets, or change gateway configuration from this repo without Raymond's explicit approval.
- Keep changes small and reviewable; prefer existing hooks/components/utilities before introducing new patterns.
- Avoid broad rewrites around auth, device pairing, Gateway bootstrap, migrations, terminal execution, or config writes unless the work is first captured as a proposal/task.
