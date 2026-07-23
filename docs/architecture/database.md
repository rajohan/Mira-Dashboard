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

`backend/src/database.ts` secures storage, opens the database, validates WAL,
and applies numbered migrations before exposing the shared database proxy. It
sets:

```sql
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA wal_autocheckpoint = 1000;
```

The data directory is enforced as `0700`; the database and any present
`-wal`/`-shm` sidecars are enforced as `0600`. Both production systemd units
also use `UMask=0077`.

Tests must use temp databases. When `NODE_ENV=test`, the database guard refuses
non-temporary paths and symlinked temp paths.

WAL mode creates `-wal` and `-shm` sidecars while the database is in use. They
are runtime files managed by SQLite and must not be removed while Dashboard is
running.

## Migrations

Migrations live in `backend/src/databaseMigrations/` and are immutable after
release. `schema_migrations` records the contiguous version, name, SHA-256
checksum, and application timestamp.

Startup behavior is fail-closed:

1. validate every recorded version/name/checksum against the registry;
2. acquire `BEGIN IMMEDIATE`, then revalidate after the write lock;
3. while that lock excludes other writers, create and restore-verify a
   `pre-migration` backup through a separate read-only connection when adopting
   or changing an existing application schema;
4. apply all pending migrations in one transaction;
5. stop startup on unknown versions, gaps, checksum drift, or SQL failure.

The second validation makes simultaneous web/worker startup safe: one process
applies migrations while the other waits and then observes the completed
history. The same writer lock spans the backup and migration, so the rollback
snapshot cannot miss commits that are included in the migrated database. Never
edit a released migration. Add the next numbered file instead.

## Tables

| Table                              | Purpose                                                               |
| ---------------------------------- | --------------------------------------------------------------------- |
| `schema_migrations`                | Applied migration versions and immutable checksums.                   |
| `users`                            | Dashboard auth users.                                                 |
| `auth_sessions`                    | Selector plus hashed-validator Dashboard sessions.                    |
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
| `chat_runtime_snapshots`           | Durable OpenClaw chat replay/session snapshots.                       |
| `chat_runtime_snapshot_events`     | Ordered durable replay events for those snapshots.                    |
| `docker_managed_services`          | Docker updater managed service inventory.                             |
| `docker_update_events`             | Docker updater event history.                                         |

## Automated Backup And Restore Verification

The deploy flow uses one combined build/preflight command before restart:

```bash
cd /home/ubuntu/projects/mira-dashboard
/usr/local/bin/doppler run --config prd --project rajohan -- \
  bun run deploy:prepare
```

This builds the frontend and backend before invoking the backend
`db:preflight`. Preflight requires the live database to be in WAL mode,
validates its recorded migration prefix, creates a `pre-deploy` snapshot with
`VACUUM INTO`, copies the snapshot to an isolated temporary restore directory,
requires `PRAGMA quick_check = ok` plus valid migration history, then applies
every pending migration to that disposable copy and validates it again. The
retained `pre-deploy` snapshot and live database remain unchanged. Ordinary
builds remain side-effect free.

The enabled `database.maintenance` worker job runs daily at `02:40`. It creates
and restore-verifies a `scheduled` backup before pruning bounded history, runs
`PRAGMA optimize`, and requests a passive WAL checkpoint. It deliberately does
not run automatic `VACUUM`; freelist pages are reusable by SQLite and are not a
hard size limit.

Snapshots live beside the database under `data/backups/` by default:

| Kind            | Maximum age | Maximum count |
| --------------- | ----------- | ------------- |
| `scheduled`     | 14 days     | 14            |
| `pre-deploy`    | 90 days     | 20            |
| `pre-migration` | 180 days    | 20            |

Only recognized Dashboard snapshot names are pruned. Unrelated files are never
removed. Do not copy only the main `.db` file while Dashboard is running;
committed data may still be in `-wal`.

## Useful Inspection Commands

Run production inspection through Doppler so the command resolves the same
`MIRA_DASHBOARD_DB_PATH` value as the services:

```bash
set -euo pipefail
cd /home/ubuntu/projects/mira-dashboard/backend
db_path="$(
  /usr/local/bin/doppler run --config prd --project rajohan -- \
    sh -c 'realpath -m -- "${MIRA_DASHBOARD_DB_PATH:-data/mira-dashboard.db}"'
)"
sqlite3 -readonly "$db_path" ".tables"
sqlite3 -readonly "$db_path" "PRAGMA integrity_check;"
sqlite3 -readonly "$db_path" \
  "SELECT version, name, applied_at FROM schema_migrations ORDER BY version;"
sqlite3 -readonly "$db_path" "SELECT COUNT(*) FROM users;"
sqlite3 -readonly "$db_path" "SELECT COUNT(*) FROM auth_sessions;"
sqlite3 -readonly "$db_path" \
  "SELECT key, length(value), updated_at FROM app_config;"
```

If SQLite reports `database is locked`, wait for background jobs to settle and
retry. The application already uses a 5 second busy timeout.

The Database page has separate **PostgreSQL** and **Dashboard SQLite** sources.
The SQLite source reports migration state, WAL/SHM size, reusable space,
permissions, verified-backup freshness, and the latest maintenance run. Its
compact `database.summary` heartbeat projection marks `dashboard-sqlite` for
review when lifecycle checks need attention.

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
cd "$backend_dir"
/usr/local/bin/doppler run --config prd --project rajohan -- \
  bun run db:preflight
sqlite3 -cmd ".timeout 5000" "$db_path" "DELETE FROM auth_sessions; DELETE FROM users; DELETE FROM app_config WHERE key='gateway_token';"
sqlite3 -cmd ".timeout 5000" "$db_path" "PRAGMA integrity_check;"
curl http://127.0.0.1:3100/api/auth/bootstrap
```

Expected result:

```json
{ "isBootstrapRequired": true, "hasGatewayToken": false }
```
