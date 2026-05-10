# Mira Dashboard

Mira Dashboard is Raymond's local control surface for Mira/OpenClaw operations. It combines a React frontend with a Node/Express backend that mirrors OpenClaw Gateway state, serves operational APIs, and persists dashboard-owned state in SQLite.

## What it includes

- Authenticated dashboard routes for chat, sessions, agents, tasks, logs, files, cron, Docker updater state, database checks, Moltbook, terminal access, and settings.
- A backend API on port `3100` with route modules under `backend/src/routes`.
- A shared WebSocket bridge for live OpenClaw Gateway updates.
- Local SQLite storage for dashboard tasks, task updates, notifications, auth sessions, quota alert state, OpenClaw alert state, and agent task history.
- Vite/TanStack Router frontend on port `5173` during development, proxying `/api` to the backend.

## Repository layout

```text
src/                     React app, routes, hooks, stores, types, and UI components
backend/src/             Express backend, Gateway bridge, route modules, services, DB setup
backend/data/            Local runtime SQLite databases; do not commit runtime data changes
dist/                    Production frontend build output
vite.config.ts           Vite config, React Compiler preset, dev proxy, and build chunking
```

## Local development

Install frontend dependencies from the repo root:

```bash
npm install
```

Install backend dependencies separately:

```bash
cd backend
npm install
```

Run the frontend dev server:

```bash
npm run dev
```

Run the backend dev server from `backend/`:

```bash
npm run dev
```

The backend scripts use Doppler (`rajohan` / `prd`) for runtime secrets. Do not commit `.env` files, tokens, database dumps, or generated runtime state.

## Verification commands

From the repo root:

```bash
npm run lint
npm run build
npm run format:check
```

From `backend/`:

```bash
npm run lint
npm run build
npm run format:check
```

Use the smallest meaningful gate for the change you are making. For docs-only changes, `git diff --check` is usually enough; for frontend/backend code changes, prefer lint plus the relevant build.

## Runtime notes

- Backend default port: `3100`.
- Frontend dev port: `5173`.
- Health endpoints: `/health` and `/api/health`.
- Vite is configured with React Compiler via `reactCompilerPreset()`.
- Dev server listens on all addresses so the dashboard can be reached over Tailscale when needed.
- Auth is enforced for API routes after `/api/auth/*`; route modules should assume authenticated access unless explicitly mounted before the auth middleware.

## Production checkout and PR worktrees

`/home/ubuntu/projects/mira-dashboard` is the production checkout. Keep it on `master`; the running service and deploy workflow build from this path only after Raymond approves a merge/deploy.

Feature and autopilot work must use separate git worktrees under `/home/ubuntu/projects/mira-dashboard-worktrees`, for example:

```bash
mkdir -p /home/ubuntu/projects/mira-dashboard-worktrees
git -C /home/ubuntu/projects/mira-dashboard fetch --prune origin
git -C /home/ubuntu/projects/mira-dashboard worktree add \
  -b mira/<short-slug> \
  /home/ubuntu/projects/mira-dashboard-worktrees/<short-slug> \
  master
```

Run lint/build verification inside the worktree, not the production checkout. This prevents unapproved PR branches from writing live `dist/` or `backend/dist` artifacts.

## Safety notes for agents

- Do not merge PRs, deploy, restart services, rotate secrets, or change gateway configuration from this repo without Raymond's explicit approval.
- Keep changes small and reviewable; prefer existing hooks/components/utilities before introducing new patterns.
- Avoid broad rewrites around auth, device pairing, Gateway bootstrap, migrations, terminal execution, or config writes unless the work is first captured as a proposal/task.
