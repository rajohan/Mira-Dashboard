# Greenfield Rewrite Implementation Plan

[Back to the blueprint map](../greenfield-rewrite.md)

## Implementation Sequence

This is a new implementation beside the current production release, not an endpoint-by-endpoint
compatibility migration inside it.

### Phase 0: evidence and qualification

- freeze the current frontend parity inventory and redacted integration fixtures;
- qualify the latest Bun canary, tRPC Fetch/SSE, frontend build mode, Drizzle/native SQLite
  behavior, SQLite concurrency, and the TanStack DB direct-write model;
- measure current bundle, latency, memory, job, chat, and database baselines; and
- lock ADRs, exact package versions, and the Bun channel/version policy.

**Exit gate:** every architecture risk marked mandatory below has a passing executable spike.

**Status (2026-08-06): complete.** Exact-candidate qualification, source-derived parity, and the
eight executable spikes below pass. This closes evidence selection only; Phase 1 foundation and
the remaining rewrite phases are still incomplete.

### Phase 1: foundation

- create source boundaries, configuration, logging, errors, contract registry, Drizzle/native
  SQLite layer, migration runner, outbox, and generated docs;
- create immutable build/release manifests and resource-capped development/test scripts; and
- implement probes and observability.

**Exit gate:** greenfield bootstrap protects the existing project ancestor chain and provisions one
canonical `<project-root>/production/state` root for the static web/worker UID; empty database,
docs, build, web, worker, and paired rollback then work end-to-end.

**Status (2026-08-06): complete in the greenfield future root.** The executable browser/web/worker
build, manifest-verified runtime and systemd artifacts, protected project-local state, copied
candidate migration, atomic database promotion, crash journal, paired rollback, readiness, logs,
and shutdown pass a disposable-project lifecycle. Production cutover, authenticated product
smokes, and the remaining domain/UI phases are deliberately not claimed by this foundation gate.

### Phase 2: trust and transport

- implement bootstrap, sessions, password, MFA, WebAuthn, recovery, step-up, automation
  principals, exact capabilities, staged credential rotation, audit, tRPC context, raw HTTP
  policy, and one browser SSE stream.

**Exit gate:** security threat-model tests, reconnect/resume tests, and lost-response-safe
credential rotation pass. Automation administration must be browser-session-only, revalidate
recent MFA inside the state-change transaction, and prove that revocation, capability replacement,
and terminal disablement affect new requests and renewable leases without a process restart.

The server-side Phase 2 exit is now evidenced by the automation lifecycle, native one-shot Gateway
credential verifier, authenticated resumable SSE, and the consolidated
[security threat model](../../security/security-threat-model.md). The Gateway verifier
uses a protocol-v4 handshake audited against installed OpenClaw `2026.7.2-beta.7 (dabe191)` and is
restricted to the installed protocol's direct-loopback backend path. It requires token-mode proof
in the authenticated hello and is bounded by the process-owned authentication Effect service. This
closes trust and transport for the stated server scope; the greenfield browser UI, persistent
Gateway client, chat, production credential cutover, and complete rewrite remain later phases.

### Phase 3: core operator domains

- implement tasks/agents, reports/incidents/notifications, schedules/jobs, cache/metrics, and
  their frontend routes/collections;
- verify incident reopen and notification exactly-once semantics under concurrency.

**Exit gate:** dashboard, tasks, agents, jobs, reports, and notifications satisfy parity tests.

### Phase 4: Gateway and chat

- re-audit the current installed OpenClaw source and protocol before implementation, then implement
  the native persistent Gateway client, session operations, chat state machine/journal, adapters,
  attachments, reconciliation, recovery, and the full virtualized frontend. Current-production
  Dashboard Gateway/chat/session/agent/cron code is parity evidence, not protocol authority.
- replace legacy voice paths with capability-scoped, same-origin raw HTTP for ephemeral
  transcription and speech generation. The server alone holds the optional provider credential;
  audio/text are strictly bounded, abortable, no-store, and never persisted or logged.
- expose a versioned compact automation heartbeat from process-owned state: bounded payload-free
  cache status, sanitized Gateway phase/freshness, identity-free current-session count/truncation,
  and global OpenClaw-cron count/pending-sync state. It must own a bounded, fresh-only cron
  inventory refresh rather than infer health from unrelated browser traffic, fetch pages
  sequentially under explicit row/byte/deadline budgets, immediately retain only heartbeat fields,
  never expose raw errors or identities, and not claim legacy schema-v3 task/job-row parity.

**Exit gate:** recorded Gateway fixtures and live smoke tests cover every chat parity item,
including restart during streaming.

### Phase 5: privileged and external domains

- implement files/logs, Docker, database, Moltbook, settings, terminal/exec,
  GitHub/PR/release/deploy/rollback, backup, and OpenClaw operations through worker adapters.
- the Docker parity vertical is implemented in the greenfield tree. Fifteen legacy behaviors map
  to four strict Docker procedures, while the three actively consumed Docker-console routes map
  to an exact-container, fixed-shell handoff into the existing bounded interactive Terminal
  lifecycle. No second generic exec/job/output API is introduced. Production deployment remains a separate activation step; this implementation
  does not mutate or restart the live `/opt/docker` stack.
- Delivery is implemented as five bounded reads and nine durable operations over the existing cache,
  Jobs, audit, and immutable activation foundations. Pull requests, preview, checkout, and release
  authority refresh and retain independently; deployment history is an exact indexed projection
  of `delivery.production.v1` Jobs rather than a second deployment queue. All ordinary GitHub and
  Git synchronization uses only the verified `mira-2026` worker credential. Review approval is the
  sole `rajohan` mutation and has a separate, non-fallback worker credential and port. It preserves
  normal, inferred, and native stacked PR inventory, grouping, preview, and review scope. Ordinary
  merge/update/review use provider-enforced exact-head guards. Native stack create/merge and pull
  request close dispatch nothing while GitHub lacks full-scope or expected-head CAS; the browser
  exposes the stable `head-guard-unavailable` reason instead of reproducing legacy post-effect
  validation. One isolated four-hour global PR preview slot runs without production credentials
  or host-network authority. Deploy and paired rollback use one fsynced,
  versioned cross-release operation capsule and immutable transient executor so cutover survives
  stopping its originating worker, process crashes, and host reboot without adding a second queue
  or permanent service.
- keep `/opt/docker` as the separate Docker-stack project and source of truth. Dashboard is its
  control plane: reviewed worker adapters may inspect or queue bounded operations, but compose
  files, application data, and deployment ownership do not move into Dashboard state.
- treat external topology as runtime data, never as a source-code or configuration allowlist.
  PostgreSQL inventory must be re-enumerated from the server catalog on every observation and
  Docker inventory is re-enumerated from the Docker Engine with batched inspect data on every
  refresh.
  Both projections are bounded, deterministically sorted, and reconcile additions, removals, and
  renames without a Dashboard release or an operator-maintained name list. Approved Compose roots
  and resource ceilings define authority boundaries; they
  must not become inventories. Standard Compose labels may enrich observed Docker identity but may
  not gate discovery. Reuse the existing `mira.updater.enabled`, `mira.updater.autoUpdate`,
  `mira.updater.track`, `mira.updater.tagPattern`, and
  `mira.updater.tagPatternIsRegex` Compose labels as update-policy input. The implementation
  normalizes the supported list/map forms and requires explicit valid opt-in for mutation; missing
  or invalid policy leaves a discovered service inventory-only. A transient source or per-item
  failure remains explicit and preserves the last known good projection instead of fabricating an
  empty topology.
- database observability already applies that Engine rule narrowly for endpoint discovery: every
  snapshot uses bounded ID-only `docker ps -a` plus one fixed-template batched inspect, accepts one
  healthy `mira.dashboard.database-observability=pgbouncer-v1` capability, resolves its loopback
  binding, and keeps only the observer password in Dashboard configuration. That single opt-in
  capability owns the fixed `mira_dashboard_observability` PgBouncer control alias. Approved
  provisioning creates a dedicated same-named physical database from `template0`; PgBouncer's
  existing wildcard route preserves that name without an explicit mapping or environment lookup.
  No second database-name label or setting exists. The inspect template
  excludes container environment, mounts, unrelated labels, and resolved Compose output. The full
  Docker slice now applies the same source-derived pattern to Engine inventory and Compose updater
  discovery without copying endpoint identities into code or configuration.
- preserve `/opt/docker/compose.yaml` as the canonical whole-stack Compose root and resolve its
  bounded include graph beneath `/opt/docker` for update targeting. All Compose start/stop/apply
  mutations must execute the fixed `/opt/docker/bin/docker-compose-doppler` wrapper with
  worker-built argument vectors; Dashboard must not invoke an alternate Compose command or accept
  caller-supplied paths/arguments. `/opt/docker/.env` and app-local `.env` files remain opaque
  Compose/Doppler inputs: validate containment, ownership, and mode where required, but never read
  them into contracts, logs, audit payloads, or browser state and never edit them from this slice.
  Resolve each update target to the one canonical included app Compose file that owns both the
  service `image` field and its `mira.updater.*` labels. Apply a compare-and-swap replacement to the
  exact image-scalar byte range in that file only, preserving indentation, spacing, comments,
  quoting, line endings, and every byte outside the scalar. Validate the full root Compose project
  and invoke the root wrapper for the resolved service. Bind rollback to the exact pre-update
  running image ID; restore a mutable prior tag locally with pulling disabled and accept recovery
  only after both Compose source and runtime identity match. A missing, duplicated, moved, or
  concurrently changed image definition fails closed and is rediscovered; never patch the root
  include list or infer an app filename from a container name.
- keep the existing worker process as the only Docker authority. Its protected local Unix broker
  exposes only bounded redacted container logs and prune preview to the web process; it adds no
  systemd unit, timer, generic command, Compose argument, or container-exec surface. Recent-MFA,
  audit-first, source-revision-fenced durable jobs own fixed container/stack operations, exact
  unused image/volume deletion, prune execution, registry scans, and updater runs.
- refresh `docker.overview` through the existing Job/Worker/Schedule system and preserve a bounded
  last-known-good projection on source failure. The daily updater retains bounded source-derived
  event history in that cache, publishes material update-available/run/failure transitions through
  the existing notification catalog, replays that window through exact-ID upsert after every
  successful projection, and synchronizes only the exact changed app Compose paths by verified Git
  commit and push. Require worker-only Docker Hub/GitHub registry credentials for authenticated
  update lookup and the GitHub pair for an authenticated read plus dry-run-push probe before any
  Compose mutation; never depend on a machine-global Git credential store. Pending or unknown Git settlement stays explicit and is never reported as a
  completed sync. Queue admission remains solely the durable Jobs run plus queued event; do not add
  a second Docker queued-event or notification stream.
- expose `/docker` as the complete operator surface for freshness, summary, live stats, stack and
  container controls, bounded redacted logs, updater policy/status/history, manual scans and runs,
  exact service updates, images, volumes, deletion, and actor-bound prune previews. All mutations
  link to their durable Jobs run and reject duplicate/stale source intent. Interactive console
  work passes only the validated full container ID into the existing authenticated Terminal,
  which sends one fixed `/usr/bin/docker exec --interactive --tty <id> /bin/sh` handoff after
  recent-MFA admission; Docker automation never accepts a caller command, argv, environment,
  executable, or Compose path.
- use Dashboard's worker-owned rotation engine for an exact manifest of reviewed Dashboard,
  OpenClaw, and application/container regular-file logs, including the selected files beneath
  `/opt/docker/data`. Use Ubuntu's system logrotate only through a fixed broker for the exact
  `rsyslog`, `apport`, `dpkg`, and `alternatives` policies. Neither path may recursively discover
  files or rotate journald storage, binary login/audit databases, sockets, devices, or symlink
  escapes.
- treat the configured Terminal workspace root as an initial working-directory catalog only. A
  real interactive shell can change directory and access anything permitted by its OS identity;
  filesystem isolation requires a separate mount, namespace, or container sandbox.
- keep shell `cd`, completion, and termination inside the implemented bounded PTY. Replace consumed
  legacy exec behavior only with purpose-built durable Service Actions; do not restore a generic
  command, shell, or cwd API for the unused synchronous exec route. Stage the replacement for the
  consumed `POST /api/exec/start` behavior as that PTY plus one fixed `system-cleanup` operation
  that preserves package cleanup, bounded journald retention, and age-filtered Docker pruning
  without deleting volumes. The implemented parity row is gated by root-unit manifest verification
  and the live production identity smoke.
- expose the six fixed Service Action intents in contract/UI, but advertise only exact executors
  owned by a fresh worker on the current release. OpenClaw cleanup/update use reviewed worker-only
  Gateway methods, while OpenClaw restart reuses the existing fixed restart executor/provider also
  exposed in Settings. Host cleanup/restart/update use only exact root-owned systemd units through
  the fixed production worker broker. Root provisioning runs web and worker as distinct OS
  principals, excludes web from Docker and broker authority, validates immutable artifacts, and
  preserves explicit rollback; no shared web/worker privilege grant remains.
- keep the implemented `database.overview` and `/database` read-only vertical bounded: compose live
  Dashboard-SQLite lifecycle facts with a worker-owned, bounded last-known-good
  PostgreSQL/PgBouncer projection; preserve the source picker, maintenance assessment, responsive
  tables, freshness, and failure states without exposing SQL, paths, credentials, or mutations.
  Both sources must surface explicit actionable maintenance reasons: SQLite reusable space plus
  backup/schedule/run health, and PostgreSQL conservative bloat, dead-tuple/autovacuum, statement,
  capability, and incomplete-assessment signals. Preserve the legacy thresholds as a reviewed
  baseline while allowing additional bounded evidence; do not silently downgrade assessment when
  broad monitoring roles are removed.
  Provision one dedicated PostgreSQL/PgBouncer observer with zero role memberships plus an isolated
  `NOLOGIN` capability owner whose exact authority is direct `pg_read_all_stats` membership and
  direct per-database `SELECT` on `pg_catalog.pg_statistic`. The observer receives only direct
  `CONNECT`, capability-schema `USAGE`, and `EXECUTE` on the exact no-input, bounded
  `connection_metrics()`, identity-free `statement_metrics()`, `table_health()`, and
  `maintenance_metrics()` functions. Revoke raw `pg_stat_statements` source-view and routine access
  from both `PUBLIC` and the observer; do not expose query text, `queryid`, database identity, or
  user identity. The existing hourly `cache.refresh.database-observability` job must compose a
  separate privileged collection-lease port only when the provider is configured. Between runs the
  observer must be `NOLOGIN`, expired, and have zero PostgreSQL sessions. Each attempt must close
  leftovers; run `open-approved-collection`, which verifies identity and activation approval,
  performs the full bounded idempotent reconcile, and prepares a one-use token while retaining
  `NOLOGIN`; run `enable-approved-collection`, which rechecks identity, approval, policy, and the
  exact catalog digest before atomically consuming the token and setting `LOGIN` plus a short
  `VALID UNTIL`;
  collect once; run shielded mandatory close to restore and prove the exact closed state; and only
  then return the payload to the generic cache executor for commit. The port spawns only the exact
  immutable-release Bun runner; the collector retains only observer authority. Activation alone
  creates or refreshes an approval marker bound to the PostgreSQL `system_identifier` and the exact
  current and previous immutable-release policy digests. A policy version is descriptive and is
  never sufficient authorization. Lease operations may only read that approval. Every approved
  open performs the full bounded, idempotent reconcile before a separate one-use enable; there is no
  persisted fingerprint, verification-age state, or reduced path. Reconciliation removes `PUBLIC`
  database authority, grants direct observer `CONNECT` only to current non-template connectable databases,
  denies template access, and requires explicit privileges for non-owner application roles while
  the observer retains no mutation authority. Do not encode application database names, container
  names, or Compose service names in the general inventory. Newly created or removed databases
  must appear or disappear on the next bounded observation without source, manifest, or manual
  Dashboard configuration changes. A new or drifted database is reconciled before the next
  approved collection can expose its details, and access never widens. Any open,
  collection, or close failure must preserve last-known-good, prevent a fresh cache commit, and
  settle as a retryable redacted failure. PostgreSQL's closed-state proof cannot prove the absence
  of already-authenticated PgBouncer waiting clients; add no exclusive admission, and treat any
  interference as a failed attempt while the closed role prevents a new backend. Add no second
  action, schedule, loop, sidecar, systemd unit, or PostgreSQL login. The sole
  named application exception is the
  optional, count-only `mira_dashboard_observability.torrent_count` projection in Comet and
  Bitmagnet; those probes may use fixed database/view identifiers but must remain independently
  unavailable when absent and must never filter or fail the general inventory. Treat legacy raw
  query text/copy as a reviewed security narrowing while retaining generic ranked aggregate
  performance metrics.
  The dedicated observer password is the only Dashboard configuration input for this provider.
  Discover host and published port from the worker-validated single Docker capability on every
  refresh. Route the capability-owned fixed PgBouncer alias through the existing wildcard to the
  dedicated same-named physical control database, so it never becomes a manually synchronized
  label, environment value, or machine-specific default. Keep dynamic application inventory
  catalog-derived; the code-owned control database is a capability, not an application allowlist.
  Run approval-gated provisioning from the immutable current release with the exact selected Bun
  runtime; pin the local Docker socket and root Compose project, resolve the healthy PostgreSQL
  dependency, and use container-local psql through a scrubbed fixed launcher. Revalidate the
  probed superuser role OID and PostgreSQL system identity before every SQL payload; never depend
  on host psql or ambient host/container `PG*` endpoint variables.
  On initial provisioning, run explicit `activate-current-catalog --approved` after those manual
  prerequisites and before `verify-current-catalog --approved`, because verification requires an
  existing matching approval. On later releases, verification may run first only when the retained
  current or previous policy digest already approves that release; otherwise activation runs first.
  Before production activation, finish the credential cutover rather than inheriting legacy
  defaults: provision a distinct `MIRA_DASHBOARD_DATABASE_OBSERVABILITY_PASSWORD` through
  Doppler, apply it to `mira_dashboard_observer` through a reviewed non-logging activation path,
  and never fall back to `DATABASE_USERNAME`/`DATABASE_PASSWORD`, `postgres/postgres`, or a
  superuser credential. `/opt/docker/apps/pgbouncer/userlist.txt` currently contains a tracked
  SCRAM verifier. A private repository limits distribution but is not secret storage. Replace the
  tracked file with a runtime-generated or equivalently secret-mounted PgBouncer auth file, keep
  it out of Git and out of group/world-readable storage, then rotate the affected credential so
  the verifier retained in Git history is no longer current. Verify the cutover through the
  Doppler Compose wrapper without printing resolved configuration, auth-file contents, or secret
  values. This remediation, the single PgBouncer capability label, its fixed control alias, and the
  existing hourly job's separate privileged collection-lease port remain mandatory production
  cutover work independently of the implemented Docker parity slice.
  Compose only canonical scheduled and activation/cutover SQLite snapshots. Treat one immutable
  activation snapshot as the reviewed secure consolidation of the legacy pre-deploy and
  pre-migration recovery purposes; never synthesize unsupported provenance. Retain at most
  fourteen scheduled snapshots and at most five cutover snapshots/two days of unreferenced
  cutover age, protecting current, previous, and active-journal identities through descriptor-
  anchored atomic-retire cleanup under the trusted same-UID deployment-lease boundary. A future
  root-owned immutable handoff and different-principal garbage collector are required to defend
  against malicious concurrent mutation by that UID.
  The six Kopia/WAL-G status/control rows are implemented in one separate privileged backup
  vertical. It discovers exactly one healthy provider per reviewed capability from the canonical
  root Compose graph, using only `mira.dashboard.backup=kopia-v1` or
  `mira.dashboard.backup=wal-g-v1` as membership authority.
  Container, service, project, image, port, and source-mount names remain data rather than
  allowlists; additions, removals, and renames therefore converge without Dashboard changes.
  Ambiguity, disappearance, or graph drift preserves bounded last-known-good state and never
  becomes a fresh empty inventory. Kopia source roots are derived from validated read-only
  `/source/<safe-id>` mounts. Provider actions reuse durable Jobs, exact source CAS, recent MFA,
  non-retryable unknown-outcome handling, and one shared heavy-I/O lease. The coordinated
  `/opt/docker` capability-label/wrapper change remains a separate reviewed infrastructure PR and
  is not applied implicitly by Dashboard delivery. No operator-facing database, Kopia, or WAL-G
  restore operation is introduced; immutable SQLite activation/rollback recovery and Phase 6
  restore drills remain separate from the backup control surface.

**Exit gate:** capability, step-up, audit, cancellation, resource-limit, and failure-recovery
tests pass for every privileged operation.

### Phase 6: parity, hardening, and cutover

- finish responsive/accessibility/visual parity, generated `/docs`, retention, load/resource
  tests, restore drills, fresh-database cutover rehearsal, and production runbooks;
- audit every remaining `node:*` compatibility import. Where Bun exposes a native API that is at
  least as correct, secure, portable within the supported Bun runtime, and maintainable, use the
  Bun API instead. Keep a `node:*` import only for a concrete capability or cross-runtime need and
  document that exception at the call site or in the relevant architecture boundary;
- perform the fresh-database cutover and monitor the full operational cycle.

**Exit gate:** the definition of done below is satisfied; no compatibility code remains.

Given the current chat, auth, worker, delivery, and host-integration surface, this is roughly
**50–80 focused engineer-days**, not a small transport refactor. Automation can reduce elapsed
time, but it cannot remove the qualification, security, restore, and parity gates.

## Mandatory Spikes and Decisions

All eight Phase 0 spikes have executable evidence on the audited Bun candidate. Their selected
outcomes remain normative unless a later runtime or dependency qualification disproves them:

1. **Passed — Bun full-stack build:** use one compiler-first Bun HTML ahead-of-time production
   build. Tailwind, lazy chunks, CSP, hashes, precompression, source-map policy, and bundle budgets
   pass in the mechanism fixture and actual frontend build; there is no fallback build path.
2. **Passed — tRPC SSE on exact Bun:** credentials, cancellation, tracked resume, typed errors,
   proxy/TLS streaming, rolling reconnect, and bounded slow-consumer behavior pass.
3. **Passed — SQLite outbox latency:** separate web and worker processes deliver a WAL-backed
   durable outbox without gaps or duplicates, classify observed busy/locked outcomes, and recover an
   expired claim after hard worker termination.
4. **Passed — chat batching:** use ordered 150 ms token/thinking batches. One, four, and eight
   concurrent runs meet the selected write/delay policy, while tool/item, terminal, cancel, and
   completion boundaries flush immediately.
5. **Passed — TanStack DB adapter:** the exact-pinned local adapter proves snapshot replacement,
   direct batch writes, query-cache synchronization, optimistic-conflict resolution, forwarded
   cancellation, and subscription teardown without duplicate rows.
6. **Passed — Drizzle on Bun SQLite:** synchronous transactions, prepared-statement lifetime,
   native access, constraints/indexes/query plans, schema validation, migrations, checkpoint,
   backup, restore, and integrity pass on the exact candidate.
7. **Passed — Bun canary shutdown:** two service generations prove readiness withdrawal, SSE and
   Gateway closure, prepared-statement/database disposal, worker-lease recovery, process-group
   cleanup, WAL recovery, and bounded Effect-owned graceful-to-force listener shutdown.
8. **Passed — resource budgets:** capped sequential build, test, SQLite, chat, shutdown, and child
   cancellation runs complete without high/max/OOM events, memory pressure, or leaked resources.

The exact candidate qualification additionally covers raw RFC 6455 continuation and fragmented
UTF-8 reassembly, protocol/application size closes, deterministic cancellation, and explicit
absence of reconnect. The source-derived inventory accounts for 156 HTTP operations plus `/ws`.

The OpenClaw audit is deliberately point-in-time. The Phase 2 one-shot verifier records the
installed `2026.7.2-beta.7 (dabe191)` protocol-v4 behavior, but it does not qualify persistent
transport. Repeat the installed-source/protocol audit before every later OpenClaw integration
slice; do not infer current protocol requirements from legacy Dashboard implementation details.

A failed spike changes the design before implementation. It does not create a permanent dual
path.

## Definition of Done

The rewrite is ready only when all of the following are true:

- every item in the frontend parity table has an automated acceptance test or named manual
  check with evidence;
- every old endpoint is accounted for without preserving the old contract;
- Bun runtime and generated docs agree on the 1.4 channel policy, the lockfile pins a compatible
  `bun-types` snapshot, and each immutable artifact records its exact resolved runtime revision;
- tRPC queries/mutations and SSE subscriptions pass adapter, reconnect, resync, abort, and
  backpressure tests on the production Bun revision;
- Gateway chat passes streaming, ordering, reconciliation, restart, cancellation, and
  attachment tests against recorded fixtures and a live smoke session;
- incident notifications are concurrency-tested to notify once while active and again only
  after a resolved incident reappears;
- database constraints, query plans, migrations, backup, restore, retention, WAL, and paired
  rollback are verified;
- greenfield bootstrap provisions the same canonical `<project-root>/production/state` root for web
  and worker, and activation fails before pointer promotion on ancestor ownership, mode, symlink,
  or identity drift;
- the Drizzle schema, generated fresh baseline, and an introspected freshly initialized database
  agree in CI;
- authentication, step-up, automation scopes, dangerous adapters, file boundaries, secret
  redaction, and audit behavior pass security review;
- generated docs are complete, deterministic, CI-checked, and visible at `/docs` without secret
  disclosure;
- oxfmt, typed Oxlint, TypeScript, Bun tests, coverage gates, build, bundle budgets, and
  release preflight pass;
- every `node:*` compatibility import has been reviewed; an equally capable Bun-native API is used
  wherever available, and each retained exception has an explicit technical reason;
- web, worker, child jobs, streams, caches, logs, and test/build commands have observed resource
  bounds below their cgroup limits;
- production smoke checks cover every major external dependency and one safe worker job;
- the new source contains no REST compatibility API, old browser WebSocket protocol, schema
  compatibility layer, legacy fallback, or old-payload parser; and
- no code, script, migration, or test fixture imports data from the old database.

## Official Documentation Reviewed

The architectural recommendations above were checked against current official documentation,
not package memory alone:

### Bun

- [Bun in Rust](https://bun.com/blog/bun-in-rust)
- [HTTP routing](https://bun.com/docs/runtime/http/routing)
- [WebSockets](https://bun.com/docs/runtime/http/websockets)
- [`bun:sqlite`](https://bun.com/docs/runtime/sqlite)
- [`bun test`](https://bun.com/docs/test)
- [Full-stack development server and HTML imports](https://bun.com/docs/bundler/fullstack)
- [Official canary release asset](https://github.com/oven-sh/bun/releases/tag/canary)
- [Latest audited Bun commit](https://github.com/oven-sh/bun/commit/17d6843606d76620cb55d31424d7fb0aed51c367)

### tRPC and validation

- [tRPC documentation](https://trpc.io/docs)
- [Fetch adapter](https://trpc.io/docs/server/adapters/fetch)
- [Subscriptions and SSE](https://trpc.io/docs/server/subscriptions)
- [TanStack React Query client](https://trpc.io/docs/client/tanstack-react-query)
- [Validators](https://trpc.io/docs/server/validators)
- [Procedure metadata](https://trpc.io/docs/server/metadata)
- [Data transformers](https://trpc.io/docs/server/data-transformers)
- [Valibot JSON Schema](https://valibot.dev/guides/json-schema/)
- [SuperJSON](https://github.com/flightcontrolhq/superjson)

### Effect

- [Effect-oriented coding-agent workflow](https://www.effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive)
- [Effect 4 migration and beta API map](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/MIGRATION.md)
- [Scoped `acquireRelease` resources](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/ai-docs/src/01_effect/05_resources/10_acquire-release.ts)
- [Schema-backed tagged errors and `catchTags`](https://github.com/Effect-TS/effect/blob/effect%404.0.0-beta.106/ai-docs/src/01_effect/04_errors/10_catch-tags.ts)

### React and TanStack

- [React Compiler installation](https://react.dev/learn/react-compiler/installation)
- [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview)
- [TanStack DB overview](https://tanstack.com/db/latest/docs/overview)
- [Query Collection](https://tanstack.com/db/latest/docs/collections/query-collection)
- [TanStack Router](https://tanstack.com/router/latest/docs/framework/react/overview)
- [Router search-parameter validation](https://tanstack.com/router/latest/docs/framework/react/guide/search-params)
- [TanStack Form validation](https://tanstack.com/form/latest/docs/framework/react/guides/validation)
- [TanStack Store React quick start](https://tanstack.com/store/latest/docs/framework/react/quick-start)
- [TanStack Virtual](https://tanstack.com/virtual/latest/docs/introduction)
- [TanStack Pacer](https://tanstack.com/pacer/latest/docs/overview)
- [TanStack Markdown](https://tanstack.com/markdown/latest/docs/overview)
- [TanStack Highlight](https://tanstack.com/highlight/latest/docs/overview)
- [TanStack Charts](https://tanstack.com/charts/latest/docs/overview)
- [Recharts](https://www.npmjs.com/package/recharts)
- [React Resizable Panels](https://www.npmjs.com/package/react-resizable-panels)
- [Motion for React](https://motion.dev/docs/react)
- [SWR](https://swr.vercel.app/)

### Database, security, and tooling

- [SQLite write-ahead logging](https://www.sqlite.org/wal.html)
- [SQLite partial indexes](https://www.sqlite.org/partialindex.html)
- [Drizzle Bun SQLite integration](https://orm.drizzle.team/docs/sqlite/connect-bun-sqlite)
- [Drizzle parameterized SQL operator](https://orm.drizzle.team/docs/sqlite/sql)
- [Drizzle Valibot integration](https://orm.drizzle.team/docs/valibot)
- [Drizzle Kit check](https://orm.drizzle.team/docs/drizzle-kit-check)
- [SimpleWebAuthn server documentation](https://simplewebauthn.dev/docs/packages/server/)
- [Oxc type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware)
- [Oxfmt](https://oxc.rs/docs/guide/usage/formatter)

All direct dependencies were also checked through the package registry at the audit time. When
implementation begins, repeat both the registry audit and the official-documentation review for
every retained or newly introduced architectural dependency.
