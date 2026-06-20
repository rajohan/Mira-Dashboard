# Mira Dashboard

[![frontend coverage](https://codecov.io/gh/rajohan/Mira-Dashboard/branch/main/graph/badge.svg?flag=frontend)](https://codecov.io/gh/rajohan/Mira-Dashboard)
[![backend coverage](https://codecov.io/gh/rajohan/Mira-Dashboard/branch/main/graph/badge.svg?flag=backend)](https://codecov.io/gh/rajohan/Mira-Dashboard)

Mira Dashboard is Raymond's local control surface for Mira/OpenClaw operations. It combines a React frontend with a Bun/Express backend that mirrors OpenClaw Gateway state, serves operational APIs, and persists dashboard-owned state in SQLite.

## What it includes

- Authenticated dashboard routes for chat, sessions, agents, tasks, logs, files, cron, Docker updater state, database checks, Moltbook, terminal access, and settings.
- A backend API on port `3100` with route modules under `backend/src/routes`.
- A shared WebSocket bridge for live OpenClaw Gateway updates.
- Local SQLite storage for dashboard tasks, task updates, notifications, auth sessions, quota alert state, OpenClaw alert state, and agent task history.
- Bun/TanStack Router frontend on port `5173` during development, proxying `/api` to the backend.

## Repository layout

```text
src/                     React app, routes, hooks, stores, types, and UI components
backend/src/             Express backend, Gateway bridge, route modules, services, DB setup
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

## Runtime notes

- Backend default port: `3100`.
- Frontend dev port: `5173`.
- Health endpoints: `/health` and `/api/health`.
- Frontend builds and the local frontend dev server use Bun's HTML bundler with Babel React Compiler and Bun Tailwind plugins.
- Dev server listens on all addresses so the dashboard can be reached over Tailscale when needed.
- Auth is enforced for API routes after `/api/auth/*`; route modules should assume authenticated access unless explicitly mounted before the auth middleware.

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
