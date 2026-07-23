# Database

Dashboard uses SQLite through Bun's `bun:sqlite`.

Default path:

```text
backend/data/mira-dashboard.db
```

Override:

```bash
MIRA_DASHBOARD_DB_PATH=/absolute/path/to/mira-dashboard.db
```

## Startup Behavior

`backend/src/database.ts` opens the database and applies `CREATE TABLE IF NOT
EXISTS` schema SQL at startup. It sets:

```sql
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
```

Tests must use temp databases. When `NODE_ENV=test`, the database guard refuses
non-temporary paths and symlinked temp paths.

WAL mode creates `-wal` and `-shm` sidecars while the database is in use. They
are runtime files managed by SQLite and must not be removed while Dashboard is
running.

## Tables

| Table                              | Purpose                                                               |
| ---------------------------------- | --------------------------------------------------------------------- |
| `users`                            | Dashboard auth users.                                                 |
| `auth_sessions`                    | Cookie-backed Dashboard sessions.                                     |
| `app_config`                       | Small persistent config, currently including `gateway_token`.         |
| `tasks`                            | Local task records.                                                   |
| `task_events`                      | Audit/event records for task changes.                                 |
| `task_updates`                     | Markdown progress updates on tasks.                                   |
| `notifications`                    | Notification bell items, including report links and ops alerts.       |
| `reports`                          | Daily briefs, daily summaries, heartbeats, and custom reports.        |
| `cache_entries`                    | Cache refresh state and cached provider data.                         |
| `quota_alert_state`                | Notification arming state for quota thresholds.                       |
| `openclaw_alert_state`             | Notification arming state for OpenClaw update alerts.                 |
| `agent_task_history`               | Agent current/completed task history.                                 |
| `deployment_jobs`                  | Dashboard deploy job state/output.                                    |
| `deployment_lock`                  | Single active deployment lock.                                        |
| `scheduled_jobs`                   | Dashboard-local scheduled job definitions.                            |
| `scheduled_job_runs`               | Scheduled job run history.                                            |
| `scheduled_job_execution_policies` | Resource class and timeout for each Dashboard job.                    |
| `openclaw_cron_job_metadata`       | Disable intent and Dashboard metadata for OpenClaw cron jobs.         |
| `job_executions`                   | Persistent execution queue with leases, heartbeats, and cancellation. |
| `job_workers`                      | Worker capacity and liveness heartbeats.                              |
| `docker_managed_services`          | Docker updater managed service inventory.                             |
| `docker_update_events`             | Docker updater event history.                                         |

## Backup Before Manual DB Work

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
mkdir -p "$backend_dir/data/backups"
backup_path="$backend_dir/data/backups/mira-dashboard-before-manual-change-$(date +%Y%m%d-%H%M%S).db"
sqlite3 -cmd ".timeout 5000" "$db_path" ".backup '$backup_path'"
chmod 0600 "$backup_path"
test "$(sqlite3 "$backup_path" "PRAGMA quick_check;")" = "ok"
```

SQLite's online backup API creates a consistent single-file snapshot that
includes committed WAL contents. Do not copy only the main `.db` file while
Dashboard is running.

## Useful Inspection Commands

```bash
cd /home/ubuntu/projects/mira-dashboard/backend
sqlite3 data/mira-dashboard.db ".tables"
sqlite3 data/mira-dashboard.db "PRAGMA integrity_check;"
sqlite3 data/mira-dashboard.db "SELECT COUNT(*) FROM users;"
sqlite3 data/mira-dashboard.db "SELECT COUNT(*) FROM auth_sessions;"
sqlite3 data/mira-dashboard.db "SELECT key, length(value), updated_at FROM app_config;"
```

If SQLite reports `database is locked`, wait for background jobs to settle and
retry. The application already uses a 5 second busy timeout.

## Bootstrap Reset

Use this only when Raymond explicitly wants to re-run setup.

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
mkdir -p "$backend_dir/data/backups"
backup_path="$backend_dir/data/backups/mira-dashboard-before-bootstrap-reset-$(date +%Y%m%d-%H%M%S).db"
sqlite3 -cmd ".timeout 5000" "$db_path" ".backup '$backup_path'"
chmod 0600 "$backup_path"
test "$(sqlite3 "$backup_path" "PRAGMA quick_check;")" = "ok"
sqlite3 -cmd ".timeout 5000" "$db_path" "DELETE FROM auth_sessions; DELETE FROM users; DELETE FROM app_config WHERE key='gateway_token';"
sqlite3 -cmd ".timeout 5000" "$db_path" "PRAGMA integrity_check;"
curl http://127.0.0.1:3100/api/auth/bootstrap
```

Expected result:

```json
{ "isBootstrapRequired": true, "hasGatewayToken": false }
```
