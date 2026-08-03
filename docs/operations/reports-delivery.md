# Reports Delivery

Reports are Dashboard-owned records for daily briefs, daily summaries,
heartbeats, and custom operational output.

## Report Types

| Type            | Source                                | Notification behavior                               |
| --------------- | ------------------------------------- | --------------------------------------------------- |
| `daily_brief`   | OpenClaw daily brief cron             | Creates/updates notification by default.            |
| `daily_summary` | OpenClaw daily summary cron           | Creates/updates notification by default.            |
| `heartbeat`     | OpenClaw ops heartbeat                | `ok` does not notify; `warning` and `error` notify. |
| `custom`        | Manual or integration-created reports | Notifies by default unless `notify:false`.          |

## OpenClaw Delivery Shape

After the Dashboard reports cutover:

- daily brief and daily summary cron jobs keep their schedule but use no direct
  external delivery;
- their prompts POST Markdown output to `/api/reports`;
- ops heartbeat target is `none`;
- `HEARTBEAT_OK` is stored as a report with `notify:false`;
- warning/error heartbeats are stored as reports and create Dashboard
  notifications.

Heartbeat alert policy should use the structured Dashboard cache state rather
than raw provider prose. For OpenRouter, warnings should be based on monthly key
quota usage from `/api/v1/key`; low account balance text from `/api/v1/credits`
is informational unless quota calls fail or the key quota itself crosses the
warning thresholds.

## Heartbeat Run and Incident Keys

Every heartbeat report uses a run-time history key with minute precision:

```text
heartbeat:ops-check:<YYYY-MM-DDTHH-mm>
```

The report key must stay unique per run, including for warnings and errors. This
preserves the complete heartbeat history. Notification deduplication is driven
separately by the full active incident snapshot in
`metadata.heartbeatIncidents`:

```json
{
    "heartbeatIncidents": [
        {
            "key": "task:394:blocked",
            "summary": "Task #394 is blocked and needs attention."
        },
        {
            "key": "cache:database.summary:stale",
            "summary": "The database summary cache is stale."
        }
    ]
}
```

Each key uses the canonical shape `<category>:<stable-resource-id>:<condition>`.
Keys are lowercase, contain no timestamps or severity, and must remain exactly
the same while the same problem persists. Examples across heartbeat checks:

```text
task:394:blocked
cache:database.summary:stale
cron:workspace-sync:failed
dashboard-job:cache-refresh:stuck
docker:postgres:unhealthy
database:dashboard-sqlite:review
quota:openrouter:near-exhaustion
git:mira-dashboard:production-drift
weather:spydeberg:heavy-precipitation
moltbook:home:request-failed
heartbeat:collection:schema-mismatch
```

Warning/error reports send every currently active incident, sorted by key. An
`ok` report sends an empty array. Dashboard diffs the snapshot against the
previous run for the same source job:

- a new key creates one unread notification;
- an unchanged key does not update or reopen its notification;
- a missing key marks that incident resolved;
- a resolved key that appears again creates or reopens one notification;
- multiple simultaneous incidents are tracked independently.

Heartbeat requests without a valid `heartbeatIncidents` snapshot are rejected;
there is no run-key notification fallback. Heartbeat `source` and `sourceJobId`
are required so incident streams cannot collide, and warning/error heartbeats
cannot disable notifications.

## API Contract

Create/upsert:

```http
POST /api/reports
Content-Type: application/json
```

```json
{
    "type": "heartbeat",
    "status": "warning",
    "title": "Heartbeat warning",
    "bodyMd": "Git workspace needs attention.",
    "summary": "Git workspace needs attention.",
    "source": "openclaw",
    "sourceJobId": "ops-check",
    "dedupeKey": "heartbeat:ops-check:2026-06-30T01-20",
    "metadata": {
        "heartbeatIncidents": [
            {
                "key": "git:mira-workspace:production-drift",
                "summary": "The Mira workspace has production drift."
            }
        ]
    },
    "occurredAt": "2026-06-29T23:20:00.000Z",
    "notify": true
}
```

Accepted status values:

- `ok`
- `warning`
- `error`

Accepted type values:

- `daily_brief`
- `daily_summary`
- `heartbeat`
- `custom`

If `dedupeKey` is present, the report row is upserted. If it is omitted, a new
row is created.

## Notification Links

Report notifications store:

```json
{
    "heartbeatIncidentKey": "git:mira-workspace:production-drift",
    "reportId": 123,
    "reportStatus": "warning",
    "reportType": "heartbeat",
    "sourceJobId": "ops-check"
}
```

The notification bell links to:

```text
/reports?reportId=<id>
```

The Reports page can load linked reports outside the first list page through
the detail endpoint.

## UI Refresh

Reports list and detail queries poll every 30 seconds. Polling failures keep
cached reports visible and should not replace visible report content with a
blocking error if data already exists.
