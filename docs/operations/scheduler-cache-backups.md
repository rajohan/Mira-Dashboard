# Scheduler, Cache, And Backups

Dashboard runs background jobs from `backend/src/workerStart.ts`. Production
sets `MIRA_DASHBOARD_EXECUTION_ROLE=web` on the web unit and
`MIRA_DASHBOARD_EXECUTION_ROLE=worker` on the worker unit. The backward-
compatible default is `combined`; `MIRA_DASHBOARD_DISABLE_SCHEDULER=1` still
disables the in-process worker during local development.

## Scheduled Jobs

Dashboard-local scheduled jobs are stored in SQLite:

| Table                              | Purpose                                                   |
| ---------------------------------- | --------------------------------------------------------- |
| `scheduled_jobs`                   | Job definitions.                                          |
| `scheduled_job_runs`               | Run history, status, output, and errors.                  |
| `scheduled_job_execution_policies` | Resource class and timeout per job.                       |
| `job_executions`                   | Persistent queue, lease, heartbeat, and cancellation.     |
| `job_workers`                      | Worker capacity and liveness heartbeat.                   |
| `openclaw_cron_job_metadata`       | Dashboard-owned metadata for external OpenClaw cron jobs. |

Supported schedule shapes:

- interval;
- daily;
- cron.

Operational defaults:

- scheduler tick: 30 seconds;
- minimum interval schedule: 60 seconds;
- default run timeout: 5 minutes.
- global worker concurrency: 1;
- worker lease: 2 minutes, refreshed every second while an action runs;
- startup cache seeds: persistent, single-concurrency queue with five-second stagger
  plus bounded jitter.

Queue statuses are `queued`, `running`, `success`, `failed`, and `cancelled`.
An expired running lease is marked failed instead of automatically replayed;
this avoids repeating backup, update, or other non-idempotent side effects after
a worker crash.

`GET /api/job-executions` exposes queue depth, oldest wait, resource classes,
and worker liveness. `GET /api/job-executions/:id` includes the bounded
persisted output snapshot used for stdout/stderr and incremental progress.
HTTP waiters are observers only: disconnecting a request or restarting the web
service never writes a cancellation request. Cancellation is explicit through
`POST /api/job-executions/:id/cancel`.

Use the Jobs page to inspect definitions and run history before editing the
database manually.

Intentional-disable metadata never belongs in `action_payload_json`, which is
reserved for input passed to the scheduled action handler. Existing databases
are updated through the numbered migration registry; do not apply ad-hoc DDL
that bypasses `schema_migrations`.

## Built-In Startup Jobs

When enabled, worker startup registers jobs for:

- backup refresh/status;
- cache refresh;
- Dashboard SQLite backup, retention, optimization, and passive checkpoint;
- Docker update checks;
- OpenClaw workspace git sync for known safe generated workspace state;
- log rotation;
- quota notifications;
- OpenClaw update notifications;
- persistent scheduled job executor.

The same executor owns manual cache refresh, backups, log rotation, OpenClaw
Gateway restart, tracked shell/exec, Docker mutations and container exec,
Docker updater, GitHub pull-request mutations, and Dashboard deploy/build.
These adapters are registered only in the worker process; the web process only
validates, enqueues, and reads persisted state.

Resource classes are `interactive`, `light`, `network`, `host-heavy`, and
`exclusive`. The queue prioritizes interactive/light data ahead of maintenance
work, while the initial global concurrency of one prevents classes from
overlapping. Child commands launched by worker actions use transient systemd
scopes with class-specific `Nice`, `CPUWeight`, `IOWeight`, `MemoryHigh`,
`MemoryMax`, `TasksMax`, and maximum runtime limits. Each action scope is bound
to `mira-dashboard-worker.service`; restarting only
`mira-dashboard.service` leaves it running, while stopping/restarting the worker
cooperatively aborts the active execution and terminates its scoped child cgroup.

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

| Endpoint               | Consumer               | Payload contract                                                                           |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| `/api/cache/status`    | Dashboard UI polling   | Cache envelopes only; `data` is `null`.                                                    |
| `/api/cache/heartbeat` | OpenClaw ops heartbeat | `schemaVersion: 3` plus compact cache, task, OpenClaw cron, and Dashboard-job projections. |

Both responses retain every cache envelope so consumers can assess freshness,
status, errors, timestamps, and consecutive failures. Heartbeat v3 avoids
returning full provider payloads; consumers must use the documented compact
fields and must not assume the original cached object is present.

The heartbeat response also exposes these top-level operational projections:

- `dashboardJobs`: every Dashboard scheduled job with enabled/running state,
  next run, latest run status/message, and optional disable intent;
- `cronJobs`: one compact snapshot from a single Gateway `cron.list`, including
  enabled/running/last/next state and optional Dashboard-owned disable intent for
  every OpenClaw cron job;
- `tasks`: only open heartbeat-relevant tasks. Task automation contains its
  linked `cronJobId`; cron runtime and disable state remain canonical in
  `cronJobs` rather than being duplicated on tasks.
- compact `database.summary`: PostgreSQL maintenance plus Dashboard SQLite
  migration, WAL, permission, backup-freshness, maintenance, size, and
  `attention.sources` state. SQLite review is identified as
  `dashboard-sqlite`.

Completed tasks are excluded from the heartbeat task projection. A disabled
Dashboard or OpenClaw cron job remains quiet while an `indefinite` annotation
with a comment is present, or while an `until` annotation has not expired.
Missing, malformed, or expired intent remains actionable, as do missing or
failing jobs regardless of intent. Cache `entries` describe produced data and
freshness; `dashboardJobs` describes scheduler execution, so they are related
but not interchangeable. Heartbeat should correlate them and avoid reporting
the same root failure twice. The full `/api/tasks`, `/api/jobs`, and
`/api/cron/jobs` responses remain the UI contracts and are not required by
heartbeat.

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

Long-running backup jobs can run for hours. Restarting the web service does not
interrupt them. Do not restart the worker while a backup is active unless the
intent is to abort it; first inspect the execution row and host logs.

Dashboard's own SQLite backups are separate from those host backup surfaces.
The `database.maintenance` job is enabled by default at `02:40`, uses the
`host-heavy` class, and:

1. creates a WAL-consistent `scheduled` snapshot;
2. copies it into an isolated restore directory and validates `quick_check` and
   migration history;
3. removes expired/beyond-count history in one transaction;
4. runs `PRAGMA optimize`;
5. requests `PRAGMA wal_checkpoint(PASSIVE)`;
6. prunes only recognized Dashboard backup names.

History retention keeps:

| Data                                        | Retention                            |
| ------------------------------------------- | ------------------------------------ |
| completed scheduled runs and job executions | 90 days and at most 20,000 rows each |
| non-active deployment jobs                  | 90 days and at most 500 rows         |
| completed agent task history                | 90 days and at most 10,000 rows      |
| reports                                     | 365 days and at most 5,000 rows      |
| Docker update events                        | 180 days and at most 5,000 rows      |
| stale worker heartbeats                     | 7 days                               |
| expired auth sessions                       | removed after expiry                 |

Active, queued, and running execution/deployment rows are preserved. SQLite
snapshot retention is 14 scheduled/14 days, 20 pre-deploy/90 days, and 20
pre-migration/180 days. The job does not run automatic `VACUUM`.

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

Inspect SQLite lifecycle state:

```bash
set -euo pipefail
cd /home/ubuntu/projects/mira-dashboard/backend
db_path="$(
  /usr/local/bin/doppler run --config prd --project rajohan -- \
    sh -c 'realpath -m -- "${MIRA_DASHBOARD_DB_PATH:-data/mira-dashboard.db}"'
)"
sqlite3 -readonly "$db_path" \
  "SELECT version, name, applied_at FROM schema_migrations ORDER BY version;"
sqlite3 -readonly "$db_path" \
  "SELECT job_id, status, started_at, finished_at, message FROM scheduled_job_runs WHERE job_id = 'database.maintenance' ORDER BY id DESC LIMIT 5;"
```

Inspect cache freshness:

```bash
cd /home/ubuntu/projects/mira-dashboard/backend
sqlite3 "${MIRA_DASHBOARD_DB_PATH:-data/mira-dashboard.db}" \
  "SELECT key, status, updated_at FROM cache_entries ORDER BY updated_at DESC LIMIT 30;"
```
