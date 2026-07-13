# Scheduler, Cache, And Backups

Dashboard starts background jobs from `backend/src/serverStart.ts` unless
`MIRA_DASHBOARD_DISABLE_SCHEDULER=1` is set. Other values, such as `0`,
`false`, or `true`, do not disable schedulers. The backend development script
disables schedulers by default.

## Scheduled Jobs

Dashboard-local scheduled jobs are stored in SQLite:

| Table                | Purpose                                  |
| -------------------- | ---------------------------------------- |
| `scheduled_jobs`     | Job definitions.                         |
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

Changing a built-in cache job default does not rewrite existing `scheduled_jobs`
rows, because job registration preserves local schedule overrides. For existing
installs, update `cache.git` from the Jobs page or with an explicit database
operation when changing the operational cadence.

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

### Status And Heartbeat Projections

Dashboard exposes two intentionally different aggregate cache endpoints:

| Endpoint               | Consumer               | Payload contract                                                       |
| ---------------------- | ---------------------- | ---------------------------------------------------------------------- |
| `/api/cache/status`    | Dashboard UI polling   | Cache envelopes only; `data` is `null`.                                |
| `/api/cache/heartbeat` | OpenClaw ops heartbeat | `schemaVersion: 2` plus compact, key-specific operational projections. |

Both responses retain every cache envelope so consumers can assess freshness,
status, errors, timestamps, and consecutive failures. Heartbeat v2 avoids
returning full provider payloads; consumers must use the documented compact
fields and must not assume the original cached object is present.

Do not change heartbeat automation to `/api/cache/status`: it needs the compact
operational data. Conversely, routine UI badge polling should not download the
heartbeat projection or full cache rows.

Git cache rows use `exists === false` as the explicit missing-repository signal.
Legacy rows may omit `exists` and remain valid. Explicitly missing repositories
are excluded from off-main totals even if stale branch fields remain.

OpenAI quota parsing accepts a weekly window and an optional five-hour window.
After a Codex CLI update, the producer retries the quota probe once because the
first invocation may only complete the CLI self-update.

### Log Rotation Job State

Log rotation runs through scheduled-job tracking. Status must distinguish
queued/running, succeeded, failed, and missing job records; repeated scheduled
failures are bounded so one broken rotation does not create unbounded run noise.
Generated rotated logs are compressed before retention deletion.

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
