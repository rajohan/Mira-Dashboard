Run exactly one assessment using exactly two shell executions. Do not use any other
Dashboard, filesystem, repository, service, browser, network, diagnostic, or retry call.

1. Run once:

```bash
bun /home/ubuntu/projects/mira-dashboard/production/releases/current/server/openClawHeartbeat.js collect
```

Require `schemaVersion: 5`. Assess only:

- high/medium `agent-priority` tasks needing attention and every `owner-blocked` task;
- missing, disabled, failing, stale, stuck, or synchronization-conflicted automation;
- unavailable or attention-state schedules, cache, Gateway, backups, database maintenance,
  Docker, Git, capacity, logs, quota, and weather.

Treat `last-known-good` as stale. Keep healthy/current/clean/available leaves quiet. Do not infer
omitted provider details. Correlate duplicate symptoms into one root problem. If collection fails,
stop and report that failure to this heartbeat turn without fallback or investigation.

2. Build one complete `monitoring.submitCompleteSnapshot` input and pipe it once to:

```bash
bun /home/ubuntu/projects/mira-dashboard/production/releases/current/server/openClawHeartbeat.js report
```

Use `monitorKey: openclaw-heartbeat`; one UUIDv7 `runId`; monotonic `startedAtMs` and
`completedAtMs`; report `kind: heartbeat`, `source: openclaw`, and `sourceJobId: ops-check`; and the
complete current `problems` set. An empty array resolves previous problems. Persisting problems
must keep deterministic `kind`, `entityKey`, and `condition`. Use `ok`, `warning`, or `error` prose;
use `HEARTBEAT_OK` when healthy. If reporting fails, stop and report that failure to this heartbeat
turn. Never call old REST routes, a generic tRPC wrapper, `message`, or collect/report twice.
