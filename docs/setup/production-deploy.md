# Production Deploy

Dashboard production runs from:

```text
/home/ubuntu/projects/mira-dashboard
```

The service runs from the backend directory:

```text
/home/ubuntu/projects/mira-dashboard/backend
```

## Deployment Model

This is a single-host service:

- frontend assets are built into `dist/`;
- backend TypeScript is built into `backend/dist/`;
- `mira-dashboard.service` runs `bun dist/serverStart.js` through Doppler;
- SQLite state lives under `backend/data/` unless `MIRA_DASHBOARD_DB_PATH` is set.

There is no container image for the Dashboard service today.

## Build

From repo root:

```bash
cd /home/ubuntu/projects/mira-dashboard
git pull --ff-only
bun install --frozen-lockfile
bun run build
```

From backend:

```bash
cd /home/ubuntu/projects/mira-dashboard/backend
bun install --frozen-lockfile
bun run build
```

## Restart

Always tell Raymond before restarting OpenClaw Gateway. Dashboard restart is
safe after a merged/deployed Dashboard change:

```bash
systemctl --user restart mira-dashboard.service
systemctl --user status mira-dashboard.service --no-pager
```

Logs:

```bash
journalctl --user -u mira-dashboard.service -n 120 --no-pager
```

## Smoke Test

```bash
curl http://127.0.0.1:3100/api/health
curl http://127.0.0.1:3100/api/auth/bootstrap
```

For an authenticated browser session, also verify:

- header/WebSocket status is connected;
- Dashboard page cards load;
- Reports page loads recent reports;
- Notifications bell loads without global chat/tool errors.

## Rollback

Rollback is git-based:

```bash
cd /home/ubuntu/projects/mira-dashboard
git log --oneline -n 10
git switch main
git reset --hard <known-good-sha>
bun run build
cd backend
bun run build
systemctl --user restart mira-dashboard.service
curl http://127.0.0.1:3100/api/health
```

Do not use `git reset --hard` casually in normal work. It is a rollback
procedure for production incidents after an explicit decision.

`backend/src/database.ts` creates missing SQLite tables and indexes on startup,
but the schema uses `CREATE TABLE IF NOT EXISTS`. Existing tables are not
altered automatically. Any change that adds/removes columns, changes
constraints, or backfills data needs an explicit migration/manual rollout plan.

Before risky auth/database changes, copy the configured live DB first:

```bash
backend_dir=/home/ubuntu/projects/mira-dashboard/backend
db_path="$(cd "$backend_dir" && /usr/local/bin/doppler run --config prd --project rajohan -- printenv MIRA_DASHBOARD_DB_PATH || true)"
db_path="${db_path:-$backend_dir/data/mira-dashboard.db}"
mkdir -p "$backend_dir/data/backups"
cp "$db_path" "$backend_dir/data/backups/mira-dashboard-before-change-$(date +%Y%m%d-%H%M%S).db"
```

## Health Signals

Healthy `/api/health`:

```json
{
    "status": "isOk",
    "gatewayConnected": true,
    "sessionCount": 9,
    "backendCommit": "abc1234"
}
```

Important failures:

- `gatewayConnected: false`: check OpenClaw Gateway service and Gateway token.
- HTTP `503 Frontend Not Built`: build root frontend with `bun run build`.
- `Unauthorized` on API routes: auth/session or cookie issue.
- `database is locked`: another process is holding SQLite; retry after
  background jobs settle, then inspect service logs.
