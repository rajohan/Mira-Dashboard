# Frontend Feature Map

The frontend is a React/TanStack Router app. Routes live in `src/router.tsx`,
pages live in `src/pages`, feature code lives under `src/components/features`,
and shared primitives live under `src/components/ui`.

React Compiler is enabled. Avoid routine `useMemo` and `useCallback`; use them
only when stable identity is part of an external contract that React Compiler
cannot infer.

## Route Map

| Route            | Page                    | Main data source                           |
| ---------------- | ----------------------- | ------------------------------------------ |
| `/`              | `Dashboard.tsx`         | health, agents, tasks, jobs, notifications |
| `/tasks`         | `Tasks.tsx`             | task APIs and TanStack DB collections      |
| `/agents`        | `Agents.tsx`            | agent metadata/status/history APIs         |
| `/sessions`      | `Sessions.tsx`          | Gateway session list/actions               |
| `/chat`          | `Chat.tsx`              | Gateway sessions, `/ws` runtime events     |
| `/jobs`          | `Jobs.tsx`              | scheduled jobs and run history             |
| `/reports`       | `Reports.tsx`           | reports list/detail APIs                   |
| `/notifications` | notification bell/modal | notification APIs                          |
| `/pull-requests` | `PullRequests.tsx`      | GitHub/PR backend services                 |
| `/docker`        | `Docker.tsx`            | Docker inventory/updater APIs              |
| `/files`         | `Files.tsx`             | workspace file APIs                        |
| `/logs`          | `Logs.tsx`              | log file APIs                              |
| `/database`      | `Database.tsx`          | Postgres/PgBouncer probes                  |
| `/moltbook`      | `Moltbook.tsx`          | Moltbook cache/API data                    |
| `/settings`      | `Settings.tsx`          | OpenClaw config and Dashboard settings     |
| `/terminal`      | `Terminal.tsx`          | terminal helper APIs                       |

## Data Fetching Expectations

- Operational pages that represent live system state should poll or subscribe.
- Reports poll every 30 seconds and keep cached data visible during refresh
  errors.
- Tasks also keep the last successful collection visible during transient
  refresh failures; the error is non-blocking when cached rows exist.
- Database metrics keep the last successful cache entry visible during transient
  refresh failures and show a non-blocking warning.
- Jobs keep the active view's last successful list visible during transient
  refresh failures and show a non-blocking warning.
- Dashboard cache badges poll the lightweight `/api/cache/status` endpoint.
  Heartbeat automation uses `/api/cache/heartbeat`; it is not the UI polling
  endpoint.
- Notifications poll separately from Reports.
- Global `refetchOnWindowFocus` is disabled; pages that need freshness should
  configure their own intervals or explicit invalidation.
- Mutations should invalidate the smallest relevant query keys.

## Layout Expectations

Dashboard is an operations tool. Prefer dense, readable, predictable layouts:

- stable button/icon sizes;
- no nested cards;
- responsive grids with explicit min/max constraints;
- mobile actions that remain close to the content they act on;
- no decorative elements that compete with operational data.

For destructive actions:

- use icon buttons with accessible labels where space is limited;
- require confirmation for permanent deletion;
- keep confirmation text specific to the record being deleted.

## Common Frontend Pitfalls

| Pitfall                                   | Expected handling                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| Accidental `useMemo`/`useCallback`        | Remove unless identity stability is semantically required.                            |
| Polling error hides cached data           | Show blocking error only when no cached data exists.                                  |
| Tool failures shown as global chat errors | Keep failed tool diagnostics in tool rows.                                            |
| Refresh error clears useful state         | Keep the last successful tasks/reports payload visible and show a non-blocking error. |
| Linked report outside first page          | Load detail endpoint and prepend only if it matches the active filter.                |
| Mobile action misplacement                | Keep actions in the header row and use icon-only buttons on narrow screens.           |

## Current Operational Surfaces

- Task search includes title, body, labels, assignee, automation schedule,
  session target, model, and thinking level. Text filters trim surrounding
  whitespace before matching. Automation filters remain distinct from Kanban
  status and assignee filters.
- Chat composer settings own model, thinking level, speed, and context
  compaction. Thinking and tool visibility are independent persisted toggles.
- The quota card shows provider-specific windows. OpenAI may expose a weekly
  window with an optional five-hour window; a missing five-hour value means
  unlimited, not a parse failure.
- The Git workspace card distinguishes an explicitly missing repository
  (`exists === false`) from legacy cache rows where `exists` is absent. Missing
  repositories do not count as off-main checkouts.
- The Database page shows Comet and Bitmagnet torrent totals plus conservative
  Postgres maintenance/bloat assessment.
- Docker container statistics refresh independently from cached inventory so
  live CPU and memory values do not remain frozen after the page loads.
- Docker console commands use the shared single-line input; Enter submits and a
  pending command cannot be submitted twice.
- Pull Request sections expose their own counts and distinguish a blocked
  deployment action from an empty Mira-authored review queue.

## Validation

For frontend-only changes, run the narrowest relevant test plus the standard
frontend gates:

```bash
bun test ./src/test/frontendBehavior.test.tsx --test-name-pattern "<feature>"
bun run lint
bun run build
bun run format:check
git diff --check
```

Run Playwright or screenshot checks for visual changes that are hard to assert
with DOM tests.
