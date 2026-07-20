# Endpoint Reference

This page lists the backend route table. It is intentionally concise: use the
route files under `backend/src/routes/` for exact validation details.

## Health

| Method | Path            | Purpose                               |
| ------ | --------------- | ------------------------------------- |
| `GET`  | `/health`       | Public health check.                  |
| `GET`  | `/api/health`   | Public API health check.              |
| `GET`  | `/api/sessions` | Legacy/session snapshot from Gateway. |

## Auth

| Method | Path                            | Purpose                                             |
| ------ | ------------------------------- | --------------------------------------------------- |
| `GET`  | `/api/auth/bootstrap`           | Returns first-user/bootstrap state.                 |
| `GET`  | `/api/auth/session`             | Returns current auth/session state.                 |
| `POST` | `/api/auth/register-first-user` | Validates Gateway token and creates the first user. |
| `POST` | `/api/auth/login`               | Creates a Dashboard auth session.                   |
| `POST` | `/api/auth/logout`              | Deletes current auth session cookie.                |

## Agents

| Method | Path                        | Purpose                                         |
| ------ | --------------------------- | ----------------------------------------------- |
| `PUT`  | `/api/agents/:id/metadata`  | Updates agent metadata, including current task. |
| `GET`  | `/api/agents/:id/status`    | Reads one agent status.                         |
| `GET`  | `/api/agents/config`        | Reads agent config.                             |
| `GET`  | `/api/agents/status`        | Reads all agent statuses.                       |
| `GET`  | `/api/agents/tasks/history` | Reads agent task history.                       |

## Tasks

| Method   | Path                               | Purpose                                |
| -------- | ---------------------------------- | -------------------------------------- |
| `GET`    | `/api/tasks`                       | Lists local tasks.                     |
| `POST`   | `/api/tasks`                       | Creates a task.                        |
| `GET`    | `/api/tasks/:id`                   | Reads one task.                        |
| `PATCH`  | `/api/tasks/:id`                   | Updates title/body/labels/automation.  |
| `DELETE` | `/api/tasks/:id`                   | Deletes a task and its updates/events. |
| `POST`   | `/api/tasks/:id/assign`            | Assigns or unassigns a task.           |
| `POST`   | `/api/tasks/:id/move`              | Moves a task between status columns.   |
| `GET`    | `/api/tasks/:id/updates`           | Lists task progress updates.           |
| `POST`   | `/api/tasks/:id/updates`           | Adds a Markdown progress update.       |
| `PATCH`  | `/api/tasks/:id/updates/:updateId` | Edits a task update.                   |
| `DELETE` | `/api/tasks/:id/updates/:updateId` | Deletes a task update.                 |

Allowed task assignees are currently `mira-2026` and `rajohan`.

## Reports

| Method   | Path               | Purpose                                                                      |
| -------- | ------------------ | ---------------------------------------------------------------------------- |
| `GET`    | `/api/reports`     | Lists reports, default limit `100`, max `200`. Supports `type` and `status`. |
| `POST`   | `/api/reports`     | Creates or upserts a report.                                                 |
| `GET`    | `/api/reports/:id` | Reads one report with full Markdown body.                                    |
| `DELETE` | `/api/reports/:id` | Deletes a report and linked notifications.                                   |

Report types: `daily_brief`, `daily_summary`, `heartbeat`, `custom`.
Report statuses: `ok`, `warning`, `error`.

Create body:

```json
{
    "type": "heartbeat",
    "status": "ok",
    "title": "Heartbeat OK",
    "bodyMd": "All heartbeat checks passed.",
    "summary": "All heartbeat checks passed.",
    "source": "openclaw",
    "sourceJobId": "ops-check",
    "dedupeKey": "heartbeat:ops-check:2026-06-30T01-25",
    "metadata": {},
    "occurredAt": "2026-06-29T23:25:00.000Z",
    "notify": false
}
```

## Notifications

| Method   | Path                               | Purpose                                           |
| -------- | ---------------------------------- | ------------------------------------------------- |
| `GET`    | `/api/notifications`               | Lists notifications with filters/limit.           |
| `POST`   | `/api/notifications`               | Creates/upserts a notification.                   |
| `POST`   | `/api/notifications/mark-all-read` | Marks notifications read.                         |
| `POST`   | `/api/notifications/clear-read`    | Deletes read notifications, optionally by source. |
| `POST`   | `/api/notifications/:id/read`      | Marks one notification read.                      |
| `DELETE` | `/api/notifications/:id`           | Deletes one notification.                         |

## Sessions And Chat

| Method    | Path                       | Purpose                                                   |
| --------- | -------------------------- | --------------------------------------------------------- |
| `GET`     | `/api/sessions/list`       | Lists Gateway sessions with optional filters.             |
| `POST`    | `/api/sessions/:id/action` | Sends a session action.                                   |
| `DELETE`  | `/api/sessions/:id`        | Deletes/removes a session.                                |
| `GET`     | `/api/sessions/stats`      | Returns session stats.                                    |
| WebSocket | `/ws`                      | Browser Dashboard socket for Gateway-backed live updates. |

## Jobs And Cron

| Method  | Path                        | Purpose                                |
| ------- | --------------------------- | -------------------------------------- |
| `GET`   | `/api/jobs`                 | Lists Dashboard scheduled jobs.        |
| `GET`   | `/api/jobs/:id`             | Reads a scheduled job.                 |
| `PATCH` | `/api/jobs/:id`             | Updates scheduled job settings.        |
| `POST`  | `/api/jobs/:id/run`         | Runs a scheduled job now.              |
| `GET`   | `/api/jobs/:id/runs`        | Lists job run history.                 |
| `GET`   | `/api/cron/jobs`            | Lists OpenClaw cron jobs.              |
| `POST`  | `/api/cron/jobs/:id/run`    | Runs an OpenClaw cron job.             |
| `POST`  | `/api/cron/jobs/:id/toggle` | Enables/disables an OpenClaw cron job. |
| `POST`  | `/api/cron/jobs/:id/update` | Updates an OpenClaw cron job patch.    |
| `POST`  | `/api/cron/jobs/:id/delete` | Deletes an OpenClaw cron job.          |

## OpenClaw Config

| Method | Path                | Purpose                                   |
| ------ | ------------------- | ----------------------------------------- |
| `GET`  | `/api/config`       | Reads OpenClaw config snapshot plus hash. |
| `PUT`  | `/api/config`       | Writes OpenClaw config with hash check.   |
| `GET`  | `/api/skills`       | Lists OpenClaw skills.                    |
| `POST` | `/api/skills/:name` | Toggles a skill.                          |
| `POST` | `/api/backup`       | Creates config backup.                    |
| `POST` | `/api/restart`      | Restarts OpenClaw Gateway.                |

## Files, Config Files, Logs, Media

| Method | Path                         | Purpose                                                             |
| ------ | ---------------------------- | ------------------------------------------------------------------- |
| `GET`  | `/api/files`                 | Lists workspace files.                                              |
| `GET`  | `/api/files/*`               | Reads workspace file/media metadata/content.                        |
| `PUT`  | `/api/files/*`               | Writes workspace file content.                                      |
| `GET`  | `/api/config-files`          | Lists OpenClaw config files.                                        |
| `GET`  | `/api/config-files/*`        | Reads a config file under OpenClaw root.                            |
| `PUT`  | `/api/config-files/*`        | Writes a config file under OpenClaw root.                           |
| `GET`  | `/api/logs/info`             | Lists log files/metadata.                                           |
| `GET`  | `/api/logs/content`          | Reads log content.                                                  |
| `GET`  | `/api/media`                 | Serves or safely previews media bytes from OpenClaw media roots.    |
| `GET`  | `/api/chat/media/outgoing/*` | Proxies an exact managed Gateway media path with backend-held auth. |

File routes reject hidden paths and paths outside their configured roots.
`/api/media` accepts `preview=text` only for bounded TXT, JSON, CSV, and Markdown
files, and `preview=image` only for sandboxed SVG display.
`/api/chat/media/outgoing/*?preview=text` applies the same 1 MiB bound to managed
Gateway text media after validating its upstream type or filename.
`preview=image` accepts validated image responses up to 16 MiB; SVG additionally
returns the same restrictive sandbox CSP as local SVG preview. Without a preview
query, active document types such as SVG and HTML are forced to an attachment
download with `application/octet-stream`; other managed media retain their
upstream download metadata.

## Docker

| Method   | Path                                             | Purpose                          |
| -------- | ------------------------------------------------ | -------------------------------- |
| `GET`    | `/api/docker/containers`                         | Lists containers.                |
| `GET`    | `/api/docker/containers/:containerId`            | Reads container details.         |
| `POST`   | `/api/docker/containers/:containerId/action`     | Starts/stops/restarts container. |
| `GET`    | `/api/docker/containers/:containerId/logs`       | Reads container logs.            |
| `POST`   | `/api/docker/exec/start`                         | Starts a container exec job.     |
| `GET`    | `/api/docker/exec/:jobId`                        | Reads exec job output/state.     |
| `POST`   | `/api/docker/exec/:jobId/stop`                   | Stops exec job.                  |
| `GET`    | `/api/docker/images`                             | Lists images.                    |
| `DELETE` | `/api/docker/images/:imageId`                    | Deletes an image.                |
| `GET`    | `/api/docker/volumes`                            | Lists volumes.                   |
| `DELETE` | `/api/docker/volumes/:volumeName`                | Deletes a volume.                |
| `POST`   | `/api/docker/prune`                              | Runs Docker prune target.        |
| `POST`   | `/api/docker/stack/action`                       | Runs a compose stack action.     |
| `GET`    | `/api/docker/updater/services`                   | Lists managed update services.   |
| `GET`    | `/api/docker/updater/events`                     | Lists update events.             |
| `POST`   | `/api/docker/updater/run`                        | Runs updater scan.               |
| `POST`   | `/api/docker/updater/services/:serviceId/update` | Updates one managed service.     |

## Pull Requests And Deployments

| Method | Path                                         | Purpose                              |
| ------ | -------------------------------------------- | ------------------------------------ |
| `GET`  | `/api/pull-requests`                         | Lists Dashboard PRs.                 |
| `POST` | `/api/pull-requests/:number/approve`         | Approves/merges, optionally deploys. |
| `POST` | `/api/pull-requests/:number/reject`          | Rejects/closes.                      |
| `POST` | `/api/pull-requests/:number/review-approval` | Approves review.                     |
| `POST` | `/api/pull-requests/:number/update-branch`   | Updates branch.                      |
| `POST` | `/api/pull-requests/deploy`                  | Starts deploy latest job.            |
| `GET`  | `/api/pull-requests/deployments`             | Lists deploy jobs.                   |
| `GET`  | `/api/pull-requests/production-checkout`     | Reads production checkout status.    |

## Backups, Cache, Metrics, Ops

| Method | Path                                       | Purpose                                                                |
| ------ | ------------------------------------------ | ---------------------------------------------------------------------- |
| `GET`  | `/api/backups/kopia`                       | Reads Kopia backup state.                                              |
| `POST` | `/api/backups/kopia/run`                   | Starts Kopia backup.                                                   |
| `POST` | `/api/backups/kopia/clear-needs-attention` | Clears Kopia attention state.                                          |
| `GET`  | `/api/backups/walg`                        | Reads WAL-G backup state.                                              |
| `POST` | `/api/backups/walg/run`                    | Starts WAL-G backup.                                                   |
| `POST` | `/api/backups/walg/clear-needs-attention`  | Clears WAL-G attention state.                                          |
| `GET`  | `/api/cache/heartbeat`                     | Reads schema v2 cache envelopes with compact operational projections.  |
| `GET`  | `/api/cache/status`                        | Reads cache envelopes without payload data for lightweight UI polling. |
| `GET`  | `/api/cache/:key`                          | Reads one cache entry.                                                 |
| `POST` | `/api/cache/:key/refresh`                  | Refreshes one cache entry.                                             |
| `GET`  | `/api/metrics`                             | Reads host metrics.                                                    |
| `GET`  | `/api/database/overview`                   | Reads Postgres/PgBouncer overview.                                     |
| `GET`  | `/api/ops/log-rotation/status`             | Reads log rotation status.                                             |
| `POST` | `/api/ops/log-rotation/dry-run`            | Runs log rotation dry-run.                                             |
| `POST` | `/api/ops/log-rotation/run`                | Runs log rotation.                                                     |

`/api/database/overview` includes Comet/Bitmagnet torrent counts and a
conservative Postgres maintenance assessment. Bloat is marked for review at an
estimated 5 GiB reclaimable, or at 1 GiB plus 25% of assessed heap. At least
1 GiB of heap that cannot be assessed produces `not_assessed` unless an
actionable review signal already exists. High dead tuples contribute a review
signal only for tables with at least 64 MiB of heap, 1,000 dead tuples, and a
20% dead-tuple ratio. `VACUUM FULL` remains a manual, approval-only operation.

`/api/cache/heartbeat` and `/api/cache/status` are not interchangeable. See
[Scheduler, cache, and backups](../operations/scheduler-cache-backups.md) for
their consumer contracts.

## Moltbook And Voice

| Method | Path                     | Purpose                               |
| ------ | ------------------------ | ------------------------------------- |
| `GET`  | `/api/moltbook/home`     | Reads Moltbook home cache/API.        |
| `GET`  | `/api/moltbook/feed`     | Reads feed with query params.         |
| `GET`  | `/api/moltbook/profile`  | Reads profile.                        |
| `GET`  | `/api/moltbook/my-posts` | Reads own content.                    |
| `POST` | `/api/stt/transcribe`    | Transcribes audio through ElevenLabs. |
| `POST` | `/api/tts/speak`         | Streams ElevenLabs TTS audio.         |

## Exec And Terminal

| Method | Path                     | Purpose                               |
| ------ | ------------------------ | ------------------------------------- |
| `POST` | `/api/exec`              | Runs one command.                     |
| `POST` | `/api/exec/start`        | Starts long-running exec job.         |
| `GET`  | `/api/exec/:jobId`       | Reads exec job output/state.          |
| `POST` | `/api/exec/:jobId/stop`  | Stops exec job.                       |
| `POST` | `/api/terminal/complete` | Returns shell/path completions.       |
| `POST` | `/api/terminal/cd`       | Resolves validated directory changes. |

The Terminal page executes commands through `/api/exec/start` and polls the
result by job ID. The backend validates the argv contract. The Terminal UI
prevents another submission while a start is pending or its current job is
active; the API itself permits concurrent jobs up to its global limit. A
missing/expired job is presented as a synthetic terminal failure instead of
leaving the UI permanently pending.
