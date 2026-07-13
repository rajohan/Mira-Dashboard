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
```

Tests must use temp databases. When `NODE_ENV=test`, the database guard refuses
non-temporary paths and symlinked temp paths.

## Tables

| Table                     | Purpose                                                         |
| ------------------------- | --------------------------------------------------------------- |
| `users`                   | Dashboard auth users.                                           |
| `auth_sessions`           | Cookie-backed Dashboard sessions.                               |
| `app_config`              | Small persistent config, currently including `gateway_token`.   |
| `tasks`                   | Local task records.                                             |
| `task_events`             | Audit/event records for task changes.                           |
| `task_updates`            | Markdown progress updates on tasks.                             |
| `notifications`           | Notification bell items, including report links and ops alerts. |
| `reports`                 | Daily briefs, daily summaries, heartbeats, and custom reports.  |
| `cache_entries`           | Cache refresh state and cached provider data.                   |
| `quota_alert_state`       | Notification arming state for quota thresholds.                 |
| `openclaw_alert_state`    | Notification arming state for OpenClaw update alerts.           |
| `agent_task_history`      | Agent current/completed task history.                           |
| `deployment_jobs`         | Dashboard deploy job state/output.                              |
| `deployment_lock`         | Single active deployment lock.                                  |
| `scheduled_jobs`          | Dashboard-local scheduled job definitions.                      |
| `scheduled_job_runs`      | Scheduled job run history.                                      |
| `docker_managed_services` | Docker updater managed service inventory.                       |
| `docker_update_events`    | Docker updater event history.                                   |

## Backup Before Manual DB Work

```bash
cd /home/ubuntu/projects/mira-dashboard/backend
mkdir -p data/backups
cp data/mira-dashboard.db "data/backups/mira-dashboard-before-manual-change-$(date +%Y%m%d-%H%M%S).db"
```

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
cd /home/ubuntu/projects/mira-dashboard/backend
mkdir -p data/backups
cp data/mira-dashboard.db "data/backups/mira-dashboard-before-bootstrap-reset-$(date +%Y%m%d-%H%M%S).db"
sqlite3 data/mira-dashboard.db "DELETE FROM auth_sessions; DELETE FROM users; DELETE FROM app_config WHERE key='gateway_token';"
sqlite3 data/mira-dashboard.db "PRAGMA integrity_check;"
curl http://127.0.0.1:3100/api/auth/bootstrap
```

Expected result:

```json
{ "isBootstrapRequired": true, "hasGatewayToken": false }
```
