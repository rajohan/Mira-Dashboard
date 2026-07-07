# Reports Delivery

Reports are Dashboard-owned records for daily briefs, daily summaries,
heartbeats, and custom operational output.

## Report Types

| Type | Source | Notification behavior |
| --- | --- | --- |
| `daily_brief` | OpenClaw daily brief cron | Creates/updates notification by default. |
| `daily_summary` | OpenClaw daily summary cron | Creates/updates notification by default. |
| `heartbeat` | OpenClaw ops heartbeat | `ok` does not notify; `warning` and `error` notify. |
| `custom` | Manual or integration-created reports | Notifies by default unless `notify:false`. |

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

## Heartbeat Dedupe Keys

OK heartbeats use run-time history keys with minute precision:

```text
heartbeat:ops-check:<YYYY-MM-DDTHH-mm>
```

Warnings/errors should use:

```text
heartbeat:ops-check:<runId>:<status>:<problemKey>
```

Examples:

```text
heartbeat:ops-check:2026-06-30T01-20
heartbeat:ops-check:2026-06-30T01-20:warning:git-dirty
heartbeat:ops-check:2026-06-30T01-20:error:dashboard-health
```

This preserves heartbeat history while preventing separate warning/error
problems from overwriting each other.

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
  "dedupeKey": "heartbeat:ops-check:2026-06-30T01-20:warning:git-dirty",
  "metadata": {
    "problemKey": "git-dirty"
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
