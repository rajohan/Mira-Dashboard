# Greenfield Rewrite Status

[Back to the blueprint map](../greenfield-rewrite.md)

This page describes the current implementation state. Git and pull-request history own the
chronology; this document does not retain superseded milestones or obsolete inventories.

## Current status

| Phase                               | Status   | Current implementation and remaining gate                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 — Evidence and qualification      | Complete | The qualified Bun runtime, transport, SQLite/Drizzle, browser-data, shutdown, build, and bounded-resource foundations have executable coverage.                                                                                                                                                                                                                                |
| 1 — Foundation                      | Complete | The repository builds immutable browser, web, and worker artifacts; validates migrations; promotes release/database pairs atomically; and supports readiness, rollback, and shutdown.                                                                                                                                                                                          |
| 2 — Trust and transport             | Complete | Authentication, WebAuthn/MFA, automation credentials, audit, authenticated realtime transport, and the documented trust boundaries are implemented. Production activation remains a Phase 6 gate.                                                                                                                                                                              |
| 3 — Core operator domains           | Complete | Tasks, agents, monitoring, reports, incidents, notifications, Dashboard Jobs/schedules, cache, host metrics, and application observability are implemented. `/jobs` includes OpenClaw cron. `/` provides the operator-focused overview without duplicating the dedicated Agents page or header Notifications surface. The cache browser uses one generic saved-payload viewer. |
| 4 — Gateway and chat                | Started  | Gateway lifecycle, sessions, agents, cron/tasks, heartbeat schema v5, chat journal/runtime, bounded history/reconciliation, transcript-authorized media, and `/chat` are implemented. Live Gateway smoke/restart evidence and the credential/config cutover remain open.                                                                                                       |
| 5 — Privileged and external domains | Complete | Files, Logs, Moltbook, Terminal, Settings, nine bounded Service Actions, database observability, Docker, Delivery, Kopia/WAL-G and SQLite backup status/control, quota, Git, and weather are implemented. Generic exec remains removed and no operator-facing restore operation is exposed.                                                                                    |
| 6 — Parity, hardening, and cutover  | Started  | All retained browser routes and reviewed endpoint behaviors are implemented with generated references, full-page stories, tests, and resource gates. External heartbeat cutover, remaining production/Gateway smokes, restore rehearsal, production activation, and full-cycle monitoring remain open.                                                                         |

## Current Overview composition

The Overview presents compact host metrics and weather first, followed by quota and managed Git,
unfinished tasks and Dashboard background jobs, recent reports and active incidents, independent
Kopia/PostgreSQL/SQLite backup cards, Docker/database/log summaries, fixed Service Actions,
application observability, and the generic saved-cache browser. Each reader preserves its own
available, stale, failure, and empty states so one unavailable provider does not hide unrelated
operational data.

The nine Service Actions are Dashboard web restart, Dashboard web-and-worker restart, Dashboard
worker restart, OpenClaw cleanup/restart/update, and system cleanup/restart/update. The browser can
submit only the fixed action identity and an idempotency key; execution and detail remain durable
Jobs.

## Remaining release gates

- Run the complete static, test, coverage, build, documentation, and production-shaped checks on
  the final commit.
- Complete the production authority, Gateway, heartbeat, backup/restore, cutover, rollback, and
  monitoring rehearsals described in the runbooks.
- Activate only the exact reviewed release after those gates pass.
