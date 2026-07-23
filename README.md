# Mira Dashboard

[![frontend coverage](https://img.shields.io/codecov/c/github/rajohan/Mira-Dashboard/main?flag=frontend&label=frontend%20coverage&logo=codecov)](https://codecov.io/gh/rajohan/Mira-Dashboard)
[![backend coverage](https://img.shields.io/codecov/c/github/rajohan/Mira-Dashboard/main?flag=backend&label=backend%20coverage&logo=codecov)](https://codecov.io/gh/rajohan/Mira-Dashboard)
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

- Authenticated dashboard routes for chat, sessions, agents, tasks, logs, files, cron, Docker updater state, database checks, Moltbook, terminal access, and settings.
- A backend API on port `3100` with route modules under `backend/src/routes`.
- A shared WebSocket bridge for live OpenClaw Gateway updates.
- Local SQLite storage for dashboard tasks, task updates, notifications, auth sessions, quota alert state, OpenClaw alert state, and agent task history.
- Bun/TanStack Router frontend on port `5173` during development, proxying `/api` to the backend.

## Repository layout

```text
src/                     React app, routes, hooks, stores, types, and UI components
backend/src/             Bun backend, Gateway bridge, route modules, services, DB setup
backend/data/            Local runtime SQLite databases; do not commit runtime data changes
dist/                    Bun production frontend build output
scripts/                 Bun frontend build/dev scripts and React Compiler/Tailwind plugins
```

## Local development

Install frontend dependencies from the repo root:

```bash
bun install
```

Install backend dependencies separately:

```bash
cd backend
bun install
```

Run the frontend dev server:

```bash
bun run dev
```

Run the backend dev server from `backend/`:

```bash
bun run dev
```

The backend scripts use Doppler (`rajohan` / `prd`) for runtime secrets. Do not commit `.environment` files, tokens, database dumps, or generated runtime state.

## Verification commands

From the repo root:

```bash
bun run lint
bun run build
bun run test
bun run test:coverage
bun run format:check
```

From `backend/`:

```bash
bun run lint
bun run build
bun run test
bun run test:coverage
bun run format:check
```

Use the smallest meaningful gate for the change you are making. For docs-only changes, `git diff --check` is usually enough; for frontend/backend code changes, prefer lint plus the relevant build.

Frontend and backend tests run directly with Bun. Coverage LCOV files are uploaded to Codecov from CI for PR status, diff coverage, and trend visibility.

Production preparation is deliberately separate from ordinary builds:

```bash
/usr/local/bin/doppler run --config prd --project rajohan -- \
  bun run deploy:prepare
```

This builds both applications and runs the restore-verified SQLite preflight.
Use it before a production restart; plain `build` remains safe for CI and local
verification.

## Runtime notes

- Backend default port: `3100`.
- Frontend dev port: `5173`.
- Health endpoints: `/health` and `/api/health`.
- Dashboard SQLite uses WAL, numbered checksum-validated migrations,
  restrictive storage modes, deploy/maintenance snapshots, and automated
  restore checks.
- Frontend builds and the local frontend dev server use Bun's HTML bundler with Babel React Compiler and Bun Tailwind plugins.
- Dev server listens on all addresses so the dashboard can be reached over Tailscale when needed.
- Auth is enforced by the backend request policy for API routes except `/api/auth/*` and `/api/health`; route modules should assume authenticated access unless explicitly public.
- If `MIRA_DASHBOARD_TRUSTED_PROXY_IPS` is configured, the trusted proxy must overwrite or strip inbound `X-Real-IP` and `X-Forwarded-For` headers from untrusted clients before forwarding to the backend. These headers are used only for proxied client identity such as rate-limit buckets; optional loopback auth bypass requires `MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH=1` and is granted only to immediate loopback peers without forwarded-client headers.

## Production checkout and PR worktrees

`/home/ubuntu/projects/mira-dashboard` is the production checkout. Keep it on `main`; the running service and deploy workflow build from this path only after Raymond approves a merge/deploy.

Feature and autopilot work must use separate git worktrees under `/home/ubuntu/projects/mira-dashboard-worktrees`, for example:

```bash
mkdir -p /home/ubuntu/projects/mira-dashboard-worktrees
git -C /home/ubuntu/projects/mira-dashboard fetch --prune origin
git -C /home/ubuntu/projects/mira-dashboard worktree add \
  -b mira/<short-slug> \
  /home/ubuntu/projects/mira-dashboard-worktrees/<short-slug> \
  main
```

Run lint/build verification inside the worktree, not the production checkout. This prevents unapproved PR branches from writing live `dist/` or `backend/dist` artifacts.

The Dashboard PR approval/rejection endpoints attempt to remove the matching local worktree after a PR is merged or rejected. Cleanup is best-effort: it only removes paths under `/home/ubuntu/projects/mira-dashboard-worktrees` and skips worktrees with uncommitted changes.

## Safety notes for agents

- Do not merge PRs, deploy, restart services, rotate secrets, or change gateway configuration from this repo without Raymond's explicit approval.
- Keep changes small and reviewable; prefer existing hooks/components/utilities before introducing new patterns.
- Avoid broad rewrites around auth, device pairing, Gateway bootstrap, migrations, terminal execution, or config writes unless the work is first captured as a proposal/task.
