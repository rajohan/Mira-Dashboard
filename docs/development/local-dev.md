# Local Development

## Install

Root/frontend:

```bash
cd /home/ubuntu/projects/mira-dashboard
bun install --frozen-lockfile
```

Backend:

```bash
cd /home/ubuntu/projects/mira-dashboard/backend
bun install --frozen-lockfile
```

## Run

Backend dev server:

```bash
cd /home/ubuntu/projects/mira-dashboard/backend
bun run dev
```

The backend dev script runs through Doppler and disables the scheduler:

```text
MIRA_DASHBOARD_DISABLE_SCHEDULER=1 doppler run --config prd --project rajohan -- bun --watch src/serverStart.ts
```

Frontend dev server:

```bash
cd /home/ubuntu/projects/mira-dashboard
bun run dev
```

Defaults:

- frontend: `0.0.0.0:5173`
- backend: `127.0.0.1:3100`
- frontend `/api/*` proxy target: `http://localhost:3100`

Override frontend proxy:

```bash
DASHBOARD_API_TARGET=http://127.0.0.1:3100 bun run dev
```

## Build

```bash
cd /home/ubuntu/projects/mira-dashboard
bun run build
cd backend
bun run build
```

## Important Local Rules

- Use Bun; do not add Node/Express runtime fallbacks.
- Backend imports use `.ts` extension.
- React Compiler is enabled; avoid routine `useMemo`/`useCallback`.
- Reuse shared UI components under `src/components/ui`.
- Use shared date/time helpers in `src/utils/date.ts` and `src/utils/format.ts`.
- Do not run backend tests against the live SQLite database.
- Do not commit `dist/`, runtime DB changes, local env files, or token output.

## Worktrees

Production checkout must stay on `main`:

```text
/home/ubuntu/projects/mira-dashboard
```

Feature/PR work should use:

```text
/home/ubuntu/projects/mira-dashboard-worktrees
```

Create a worktree:

```bash
mkdir -p /home/ubuntu/projects/mira-dashboard-worktrees
git -C /home/ubuntu/projects/mira-dashboard fetch --prune origin
git -C /home/ubuntu/projects/mira-dashboard worktree add \
  -b <branch-name> \
  /home/ubuntu/projects/mira-dashboard-worktrees/<short-name> \
  main
```
