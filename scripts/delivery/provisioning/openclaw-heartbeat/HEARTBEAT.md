# Dashboard heartbeat v5 prompt

This immutable Markdown is the prompt source for
`agents.entries.ops.heartbeat.prompt`; it is not a workspace `HEARTBEAT.md` target.

The hourly `ops-check` is assessment and reporting only. It uses exactly two shell executions and
no other Dashboard, filesystem, repository, service, browser, network, or diagnostic call.

## 1. Collect once

Run this exact command once:

```bash
bun /home/ubuntu/projects/mira-dashboard/production/releases/current/server/openClawHeartbeat.js collect
```

The result must validate as `schemaVersion: 5`. It is the complete bounded, payload-free
assessment snapshot. Never retry, refresh, diagnose, or fan out to another endpoint when a leaf is
stale, unavailable, malformed, or ambiguous; report that condition through step 2.

Assess only actionable state:

- high/medium `agent-priority` tasks when their state needs attention, and every `owner-blocked`
  task;
- missing, unexpectedly disabled, failing, stale, stuck, or synchronization-conflicted recurring
  automation;
- unavailable or attention-state Dashboard schedules, cache, Gateway, backups, database
  maintenance, Docker, Git, capacity, logs, quota, and weather signals.

`last-known-good` is never fresh. A healthy/current/clean/available leaf stays quiet. Do not infer
provider details that schema v5 deliberately omits. Correlate duplicated symptoms into one root
problem rather than inventing provider identities.

## 2. Report once

Create one complete `monitoring.submitCompleteSnapshot` input and pipe it through stdin to this
exact command once:

```bash
bun /home/ubuntu/projects/mira-dashboard/production/releases/current/server/openClawHeartbeat.js report
```

The snapshot must use:

- `monitorKey`: `openclaw-heartbeat`
- one UUIDv7 `runId` for this assessment
- monotonic `startedAtMs` and `completedAtMs`
- report `kind`: `heartbeat`, `source`: `openclaw`, and `sourceJobId`: `ops-check`
- the complete current `problems` set; an empty array resolves previously active problems
- deterministic `kind`, `entityKey`, and `condition` values for a persisting root problem
- `ok`, `warning`, or `error` prose in the immutable report, with `HEARTBEAT_OK` for a healthy run

Never call the old REST heartbeat/report routes, a generic tRPC wrapper, `message`, or a second
collection/report command. If either fixed command fails, report that execution failure to the
calling heartbeat turn without fallback or investigation.
