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

## Reset A Forgotten Dashboard Password

There is intentionally no password-reset page, email reset, recovery file
watched by the web service, or unauthenticated reset endpoint. Use the
host-local interactive command from an SSH/console TTY:

```bash
cd /home/ubuntu/projects/mira-dashboard/backend
bun run auth:reset-password -- --username <username>
```

The single standalone `--` ends Bun script options; `--username` is passed to
the reset program. The program reads the new password twice with terminal echo
disabled, preserves MFA, revokes every session and pending ceremony, clears
authentication cooldowns, and appends an audit event. It never accepts password
material through command arguments or environment variables.

Only when all registered second factors are also lost, run the deliberate
break-glass variant:

```bash
bun run auth:reset-password -- --username <username> --reset-mfa
```

`--reset-mfa` deletes registered WebAuthn credentials, encrypted TOTP factors,
and recovery-code validators. Sign in with the new password and immediately
enroll two named security keys (or a key plus TOTP), then store the newly shown
recovery codes offline.

## Inspect Gateway Token Metadata Without Printing It

```bash
cd /home/ubuntu/projects/mira-dashboard/backend
sqlite3 data/mira-dashboard.db "SELECT key, length(value), updated_at FROM app_config WHERE key='gateway_token';"
```

Do not print token values. A current row must contain a versioned encrypted
envelope; startup automatically upgrades a legacy plaintext row when
`MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY` is available.

## Provision Or Rotate OpenClaw Dashboard Callers

Client bearer tokens live only as regular owner-only `0600` files in:

```text
/home/ubuntu/.config/mira-dashboard/automation/
```

Use the tracked workspace provisioner; it writes the full token directly to
the file and prints only the Dashboard-side hash/scopes object:

```bash
cd /home/ubuntu/projects/mira-dashboard
bun scripts/provisionDashboardAutomationCredential.ts <profile>
```

Valid profiles are `heartbeat`, `daily-summary`, `daily-brief`, and
`task-tracking`. The provisioner refuses to overwrite an existing file. For
rotation, first move the existing `0600` token file to an owner-only
`.previous` file in the same `0700` directory. Run the provisioner to create
the replacement at the canonical path, replace the matching hash-only object
in `MIRA_DASHBOARD_AUTOMATION_CREDENTIALS`, restart the Dashboard web service,
and smoke-test the caller. Keep the old hash and `.previous` file only until
the smoke test succeeds, then remove both through the normal secret-retirement
procedure. A failed rollout is recovered by restoring the previous hash and
file together. Never expose either full token through a command argument,
prompt, terminal transcript, or Dashboard-managed exec output.

The authoritative file names, scopes, caller commands, and new-host procedure
are in [Auth and trust boundaries](../security/auth-and-trust-boundaries.md#scoped-automation-credentials)
and [New VPS setup](../setup/new-vps.md#provision-local-openclaw-api-callers).

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
- the maintenance job is missing or disabled, has never succeeded, or its
  newest successful run is older than 48 hours;
- the latest SQLite maintenance run ended in a non-success terminal state;
- reusable pages are both at least 16 MiB and at least 25% of the database,
  indicating that a planned file compaction may be worthwhile.

Inspect the `database.maintenance` job on Jobs and the Database page's attention
list. A manual deploy preflight can create and restore-verify a fresh snapshot:

```bash
cd /home/ubuntu/projects/mira-dashboard/backend
/usr/local/bin/doppler run --config prd --project rajohan -- \
  bun run db:preflight
```

“Reusable space” is SQLite freelist capacity that can be reused by future
writes. It has no configured maximum and is not PostgreSQL-style dead tuples.
The combined absolute/relative review threshold avoids warnings for harmless
small freelists. A review is still advisory: file shrinking with `VACUUM`
requires a separate maintenance decision with enough temporary disk and service
planning.

## Reports Smoke Test

`/api/reports` is authenticated. Prefer the browser, or use a dedicated
temporary automation credential with only `reports:read` and `reports:write`.
Read its bearer token without echo and pass it to curl through standard input,
not a command argument:

```bash
read -r -s -p "Dashboard reports bearer: " dashboard_reports_bearer
printf "\n"
dashboard_reports_curl() {
  printf 'header = "Authorization: Bearer %s"\n' \
    "$dashboard_reports_bearer" | curl --config - "$@"
}
```

Create:

```bash
dashboard_reports_curl -sS -X POST http://127.0.0.1:3100/api/reports \
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
dashboard_reports_curl -sS \
  "http://127.0.0.1:3100/api/reports?type=custom"
unset dashboard_reports_bearer
unset -f dashboard_reports_curl
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
