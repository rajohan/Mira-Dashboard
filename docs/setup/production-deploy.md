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
- `mira-dashboard.service` runs the HTTP/WebSocket process from
  `bun dist/serverStart.js` through Doppler;
- `mira-dashboard-worker.service` runs the persistent scheduler/executor from
  `bun dist/workerStart.js` through Doppler;
- SQLite state lives under `backend/data/` unless `MIRA_DASHBOARD_DB_PATH` is set.

Both tracked units preserve the production environment contract by launching
through Doppler project/config `rajohan/prd`. Auth and origin settings such as
`MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH` and `MIRA_DASHBOARD_ALLOWED_ORIGINS`
remain owned by Doppler; do not duplicate their values in unit files.

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

## Install Or Refresh Units

After building, install the tracked resource-limited units:

```bash
cd /home/ubuntu/projects/mira-dashboard
install -m 0644 systemd/mira-dashboard.service \
  /home/ubuntu/.config/systemd/user/mira-dashboard.service
install -m 0644 systemd/mira-dashboard-worker.service \
  /home/ubuntu/.config/systemd/user/mira-dashboard-worker.service
systemctl --user daemon-reload
```

For the first split-process rollout, restart the web unit with its explicit
`web` role before starting the worker. This avoids overlapping the legacy
combined scheduler with the dedicated worker:

```bash
systemctl --user restart mira-dashboard.service
systemctl --user enable --now mira-dashboard-worker.service
```

## Restart

Always tell Raymond before restarting OpenClaw Gateway. Dashboard restart is
safe after a merged/deployed Dashboard change. A web-only restart does not
interrupt queued/running actions. Before restarting the worker, verify the Jobs
queue is idle or explicitly accept that its active action will be cancelled:

```bash
systemctl --user restart mira-dashboard.service
systemctl --user restart mira-dashboard-worker.service
systemctl --user status mira-dashboard.service --no-pager
systemctl --user status mira-dashboard-worker.service --no-pager
```

Logs:

```bash
journalctl --user -u mira-dashboard.service -n 120 --no-pager
journalctl --user -u mira-dashboard-worker.service -n 120 --no-pager
```

## Smoke Test

```bash
curl http://127.0.0.1:3100/api/health
curl http://127.0.0.1:3100/api/auth/bootstrap
```

The queue endpoint requires a valid Dashboard session unless the explicitly
configured direct-loopback bypass is enabled. Production currently sources
`MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH=1` from Doppler, but the portable smoke test
does not depend on that host-specific bypass.

For an authenticated browser session, also verify:

- header/WebSocket status is connected;
- Jobs shows the execution queue and the worker becomes idle after startup seeds;
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
(cd backend && bun run build)
install -m 0644 systemd/mira-dashboard.service \
  /home/ubuntu/.config/systemd/user/mira-dashboard.service
if test -f backend/dist/workerStart.js; then
  install -m 0644 systemd/mira-dashboard-worker.service \
    /home/ubuntu/.config/systemd/user/mira-dashboard-worker.service
  systemctl --user daemon-reload
  systemctl --user restart mira-dashboard.service
  systemctl --user restart mira-dashboard-worker.service
else
  systemctl --user disable --now mira-dashboard-worker.service
  systemctl --user daemon-reload
  systemctl --user restart mira-dashboard.service
fi
curl http://127.0.0.1:3100/api/health
```

If the known-good target predates `workerStart.js`, the branch above stops the
worker before starting that version and reinstalls the checked-out legacy
combined web unit. Do not repeatedly restart a worker unit whose target
entrypoint does not exist.

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
  background jobs settle, then inspect both service logs. Dashboard uses a
  five-second SQLite busy timeout; WAL remains a separate storage-lifecycle
  decision that must be paired with a tested backup/checkpoint plan.
