# Scheduler, Cache, And Backups

Dashboard starts background jobs from `backend/src/serverStart.ts` unless
`MIRA_DASHBOARD_DISABLE_SCHEDULER=1` is set. Other values, such as `0`,
`false`, or `true`, do not disable schedulers. The backend development script
disables schedulers by default.

## Scheduled Jobs

Dashboard-local scheduled jobs are stored in SQLite:

| Table | Purpose |
| --- | --- |
| `scheduled_jobs` | Job definitions. |
| `scheduled_job_runs` | Run history, status, output, and errors. |

Supported schedule shapes:

- interval;
- daily;
- cron.

Operational defaults:

- scheduler tick: 30 seconds;
- minimum interval schedule: 60 seconds;
- default run timeout: 5 minutes.

Use the Jobs page to inspect definitions and run history before editing the
database manually.

## Built-In Startup Jobs

When enabled, startup registers jobs for:

- backup refresh/status;
- cache refresh;
- Docker update checks;
- OpenClaw workspace git sync for known safe generated workspace state;
- log rotation;
- quota notifications;
- OpenClaw update notifications;
- scheduled job runner.

Do not assume a job is running just because the code exists. Check the Jobs page
or `scheduled_jobs` table for enabled state and recent run history.

## Cache Entries

Cache refresh state is stored in `cache_entries`. It backs pages and health
cards for provider state that should not be fetched on every page render.

Common cache groups include:

- Moltbook feed/profile/content;
- backups;
- weather;
- git repository state, refreshed hourly by default for new installs;
- quota/provider checks;
- OpenClaw status.

OpenRouter quota checks use `/api/v1/key` monthly key limit fields
(`limit`, `limit_remaining`, and `limit_reset`) for warning thresholds. The
account balance from `/api/v1/credits` is displayed as supporting context and
must not be treated as the monthly quota.

External cache refreshes may require these env vars:

- `MOLTBOOK_API_KEY`
- `OPENROUTER_API_KEY`
- `ELEVENLABS_API_KEY`
- `SYNTHETIC_API_KEY`

If a page shows stale provider data, check the cache entry timestamp and the
latest scheduled job run before debugging the frontend.

## Backups

Dashboard exposes backup status and manual actions for Kopia and WAL-G style
host backups. Relevant scripts in production include:

```text
/opt/docker/apps/kopia/backup.sh
/usr/local/bin/backup-push.sh
```

Long-running backup jobs can run for hours. Do not restart Dashboard just
because a backup action is active; first inspect the active job and host logs.

## Operational Checks

List scheduled job tables:

```bash
cd /home/ubuntu/projects/mira-dashboard/backend
sqlite3 "${MIRA_DASHBOARD_DB_PATH:-data/mira-dashboard.db}" \
  "SELECT id, name, enabled, schedule_type, next_run_at, updated_at FROM scheduled_jobs ORDER BY id;"
```

Inspect recent runs:

```bash
cd /home/ubuntu/projects/mira-dashboard/backend
sqlite3 "${MIRA_DASHBOARD_DB_PATH:-data/mira-dashboard.db}" \
  "SELECT job_id, status, started_at, finished_at FROM scheduled_job_runs ORDER BY id DESC LIMIT 20;"
```

Inspect cache freshness:

```bash
cd /home/ubuntu/projects/mira-dashboard/backend
sqlite3 "${MIRA_DASHBOARD_DB_PATH:-data/mira-dashboard.db}" \
  "SELECT key, status, updated_at FROM cache_entries ORDER BY updated_at DESC LIMIT 30;"
```
