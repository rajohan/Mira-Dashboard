# Operations Runbooks

For symptom-oriented triage, see [Troubleshooting](troubleshooting.md). For
Docker image update behavior, see [Docker updater](docker-updater.md).

## Check Dashboard Health

```bash
curl http://127.0.0.1:3100/api/health
systemctl --user status mira-dashboard.service --no-pager
systemctl --user status mira-dashboard-worker.service --no-pager
journalctl --user -u mira-dashboard.service -n 120 --no-pager
journalctl --user -u mira-dashboard-worker.service -n 120 --no-pager
```

Expected health:

```json
{
    "status": "isOk",
    "gatewayConnected": true,
    "sessionCount": 9,
    "backendCommit": "abc1234"
}
```

## Restart Dashboard

```bash
systemctl --user restart mira-dashboard.service
systemctl --user status mira-dashboard.service --no-pager
curl http://127.0.0.1:3100/api/health
```

## Dashboard Shows WebSocket Disconnected

1. Check `/api/health`.
2. Check OpenClaw Gateway:

```bash
systemctl --user status openclaw-gateway.service --no-pager
openclaw status
```

3. Check Dashboard logs for `gateway token mismatch`.
4. Verify token precedence:
    - `OPENCLAW_GATEWAY_TOKEN`
    - `OPENCLAW_TOKEN`
    - persisted `app_config.gateway_token`
5. If bootstrap was just reset, ensure the new token was accepted by bootstrap.

## Reset Dashboard Users And Sessions

Use only when Raymond wants to re-run bootstrap.

```bash
set -euo pipefail
backend_dir=/home/ubuntu/projects/mira-dashboard/backend
configured_db_path="$(
  cd "$backend_dir"
  /usr/local/bin/doppler run --config prd --project rajohan -- \
    sh -c 'printf "%s" "${MIRA_DASHBOARD_DB_PATH-}"'
)"
if [[ -z "$configured_db_path" ]]; then
  db_path="$backend_dir/data/mira-dashboard.db"
elif [[ "$configured_db_path" = /* ]]; then
  db_path="$configured_db_path"
else
  db_path="$backend_dir/$configured_db_path"
fi
cd "$backend_dir"
/usr/local/bin/doppler run --config prd --project rajohan -- \
  bun run db:preflight
sqlite3 -cmd ".timeout 5000" "$db_path" "DELETE FROM auth_sessions; DELETE FROM users;"
sqlite3 -cmd ".timeout 5000" "$db_path" "PRAGMA integrity_check;"
curl http://127.0.0.1:3100/api/auth/bootstrap
```

To force Gateway token entry during bootstrap too:

```bash
sqlite3 data/mira-dashboard.db "DELETE FROM app_config WHERE key='gateway_token';"
```

## Inspect Gateway Token Metadata Without Printing It

```bash
cd /home/ubuntu/projects/mira-dashboard/backend
sqlite3 data/mira-dashboard.db "SELECT key, length(value), updated_at FROM app_config WHERE key='gateway_token';"
```

Do not print token values.

## Frontend Not Built

Symptom: browser shows `Frontend Not Built` or `/` returns 503.

```bash
cd /home/ubuntu/projects/mira-dashboard
bun run build
systemctl --user restart mira-dashboard.service
```

## SQLite Locked

Transient `database is locked` can happen when a write transaction is active.
Retry once after a short delay. If persistent:

```bash
journalctl --user -u mira-dashboard.service -n 200 --no-pager
journalctl --user -u mira-dashboard-worker.service -n 200 --no-pager
systemctl --user status mira-dashboard.service --no-pager
systemctl --user status mira-dashboard-worker.service --no-pager
```

Avoid running multiple manual `sqlite3` write sessions while the service is
busy.

## Restore Dashboard SQLite

Use only after an explicit restore decision. Pair the snapshot with code that
is compatible with its schema. Never overwrite the live database or remove
`-wal`/`-shm` while either Dashboard process is running.

1. Confirm the execution queue is idle and record the absolute snapshot path.
2. In one shell invocation, resolve the configured database path, verify the
   snapshot, stop worker then web, preserve the current SQLite files, install
   and validate the standalone snapshot, and only then start web and worker:

```bash
set -euo pipefail
backend_dir=/home/ubuntu/projects/mira-dashboard/backend
backup_path=/absolute/path/to/selected/mira-dashboard-....db
configured_db_path="$(
  cd "$backend_dir"
  /usr/local/bin/doppler run --config prd --project rajohan -- \
    sh -c 'printf "%s" "${MIRA_DASHBOARD_DB_PATH-}"'
)"
if [[ -z "$configured_db_path" ]]; then
  db_path="$backend_dir/data/mira-dashboard.db"
elif [[ "$configured_db_path" = /* ]]; then
  db_path="$configured_db_path"
else
  db_path="$backend_dir/$configured_db_path"
fi
test -f "$backup_path"
test "$(sqlite3 -readonly "$backup_path" "PRAGMA quick_check;")" = "ok"
has_migration_history="$(
  sqlite3 -readonly "$backup_path" \
    "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations';"
)"
if [[ "$has_migration_history" = "1" ]]; then
  sqlite3 -readonly "$backup_path" \
    "SELECT version, name FROM schema_migrations ORDER BY version;"
else
  printf '%s\n' "Legacy snapshot without schema_migrations; pair it with pre-lifecycle code."
fi
systemctl --user stop mira-dashboard-worker.service
systemctl --user stop mira-dashboard.service
db_dir="$(dirname "$db_path")"
recovery_dir="$(mktemp -d "$db_dir/.sqlite-pre-restore.XXXXXX")"
chmod 0700 "$recovery_dir"
for suffix in "" "-wal" "-shm"; do
  current_path="${db_path}${suffix}"
  if test -e "$current_path"; then
    mv "$current_path" "$recovery_dir/$(basename "$current_path")"
  fi
done
install -m 0600 "$backup_path" "$db_path"
test "$(sqlite3 -readonly "$db_path" "PRAGMA quick_check;")" = "ok"
systemctl --user start mira-dashboard.service
systemctl --user start mira-dashboard-worker.service
curl --fail --show-error --silent http://127.0.0.1:3100/api/health
printf '\nRecovery files retained at %s\n' "$recovery_dir"
```

3. Verify Database → Dashboard SQLite, migrations, and queue state. Keep the
   printed recovery directory until the restore has been validated. Removing
   it later is a separate destructive cleanup decision.

## PostgreSQL Maintenance Review

The Database page uses catalog statistics for a conservative heap-bloat
estimate. `Review` can also include slow-query or high-dead-tuple signals, so
inspect the detail fields before interpreting the status as reclaimable disk.
The high-dead-tuple signal requires at least 20% and 1,000 dead tuples on a
table with at least 64 MiB of heap; smaller high-churn tables remain visible in
the autovacuum detail table without changing the aggregate status.
`Not assessed` means at least 1 GiB of physical table heap lacks usable row-width
or live-tuple statistics.

Run `ANALYZE` when statistics are missing, then let the hourly database cache
refresh. Do not run `VACUUM FULL` from the status alone: it takes exclusive
locks, requires explicit approval, and must be planned as service disruption.

The bloat query intentionally excludes the default `postgres` database and
reports only user-database scope shown by Dashboard.

## Dashboard SQLite Requests Review

The Dashboard SQLite source and heartbeat mark review when:

- journal mode is not WAL or foreign keys are disabled;
- migration history is not current;
- the data directory/database/sidecar modes are not `0700`/`0600`;
- no verified snapshot exists or the newest is older than 48 hours;
- the latest SQLite maintenance run ended in a non-success terminal state.

Inspect the `database.maintenance` job on Jobs and the Database page's attention
list. A manual deploy preflight can create and restore-verify a fresh snapshot:

```bash
cd /home/ubuntu/projects/mira-dashboard/backend
/usr/local/bin/doppler run --config prd --project rajohan -- \
  bun run db:preflight
```

“Reusable space” is SQLite freelist capacity that can be reused by future
writes. It has no configured maximum and is not itself a health failure. Do not
run `VACUUM` solely because this value is high; file shrinking requires a
separate maintenance decision with enough temporary disk and service planning.

## Reports Smoke Test

`/api/reports` is authenticated by default. Use a browser-created session
cookie, log in with a temporary cookie jar, or run these curls only in an
environment where `MIRA_DASHBOARD_ENABLE_LOOPBACK_AUTH=1` is intentionally set.

Cookie jar login:

```bash
read -r -p "Dashboard username: " dashboard_user
read -r -s -p "Dashboard password: " dashboard_password
printf "\n"
cookie_jar="$(mktemp)"
login_body="$(bun -e 'console.log(JSON.stringify({ username: process.argv[1], password: process.argv[2] }))' "$dashboard_user" "$dashboard_password")"
curl -sS -c "$cookie_jar" \
  -H "Content-Type: application/json" \
  -d "$login_body" \
  http://127.0.0.1:3100/api/auth/login
```

Create:

```bash
curl -sS -b "$cookie_jar" -X POST http://127.0.0.1:3100/api/reports \
  -H "Content-Type: application/json" \
  -d '{
    "type":"custom",
    "status":"ok",
    "title":"Smoke test",
    "bodyMd":"Smoke test body",
    "summary":"Smoke test",
    "source":"manual",
    "notify":false
  }'
```

List:

```bash
curl -sS -b "$cookie_jar" http://127.0.0.1:3100/api/reports?type=custom
```

Delete the smoke report from the UI or with `DELETE /api/reports/:id`.

## PR Worktree Cleanup

Dashboard PR worktrees live under:

```text
/home/ubuntu/projects/mira-dashboard-worktrees
```

List:

```bash
git -C /home/ubuntu/projects/mira-dashboard worktree list
```

Remove only clean, known worktrees:

```bash
git -C /home/ubuntu/projects/mira-dashboard worktree remove /home/ubuntu/projects/mira-dashboard-worktrees/<name>
git -C /home/ubuntu/projects/mira-dashboard worktree prune
```

## Docker Compose Validation

For Docker/Stremio operations under `/opt/docker`, use the Doppler-aware wrapper:

```bash
cd /opt/docker
/opt/docker/bin/docker-compose-doppler config
```

Do not run ad hoc compose commands that bypass the documented wrapper unless
Raymond explicitly asks.
