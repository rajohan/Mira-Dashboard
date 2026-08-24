# Greenfield Rewrite Progress

[Back to the blueprint map](../greenfield-rewrite.md)

## Implementation Progress

This matrix is the living phase status. Update it in the same change that materially advances or
closes a phase; dated entries below provide the evidence, not a second status source.

| Phase                               | Status                          | Current evidence and remaining gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Evidence and qualification      | Complete                        | All eight mandatory spikes pass on exact Bun revision `17d6843606d76620cb55d31424d7fb0aed51c367`: build, transport, cross-process SQLite/outbox, Drizzle/Bun SQLite, browser data, chat batching, shutdown, and capped resources. Source-derived parity and the OpenClaw source audit pass as additional evidence.                                                                                                                                                                                                                                                   |
| 1 — Foundation                      | Complete                        | The self-contained future root builds immutable browser/web/worker artifacts, protects project-local production state, installs exact Bun and systemd artifacts, migrates a database copy, atomically promotes the release/database pair, serves readiness/browser assets, writes project-local logs, and proves crash-safe rollback and shutdown in a disposable lifecycle.                                                                                                                                                                                         |
| 2 — Trust and transport             | Complete                        | Authentication, browser session/account-security UI, MFA, WebAuthn, automation credentials, audit, authenticated renewable SSE, one-shot native Gateway bootstrap verification, and the consolidated [threat model](../../security/greenfield-phase-two-threat-model.md) have executable evidence. Production activation remains a Phase 6 gate rather than unfinished Phase 2 scope.                                                                                                                                                                                |
| 3 — Core operator domains           | Complete                        | Task, agent, monitoring, report, incident, notification, Dashboard Jobs/schedules, cache, host metrics, and application-observability server/browser parity are implemented. `/jobs` includes the OpenClaw-cron projection, and `/` composes the complete operational overview with independent retained-data and unavailable states. The Phase 3 parity and browser gates pass.                                                                                                                                                                                     |
| 4 — Gateway and chat                | Started                         | The installed OpenClaw source is hash-pinned for sessions, cron, chat, companion, task, and media. Process-owned Gateway lifecycle, durable realtime invalidation, sessions and agent availability, OpenClaw cron/tasks, heartbeat schema v5, chat journal/runtime, bounded history/reconciliation, transcript-authorized local-history media, and `/chat` are implemented. The immutable external heartbeat consumer is staged; live Gateway smoke/restart and the manual credential/config cutover plus authenticated one-collection/one-report proof remain open. |
| 5 — Privileged and external domains | Complete in the greenfield tree | Files, Logs, Moltbook, Terminal, Settings, bounded Service Actions, Database observability, Docker, Delivery, Kopia/WAL-G status/control, quota, Git, and weather are implemented. The consumed generic-exec behavior maps to the bounded PTY and purpose-built durable actions, with the unused synchronous surface removed. Provider/root provisioning is release-owned and fail-closed pending production activation. No operator-facing database restore operation is introduced.                                                                                |
| 6 — Parity, hardening, and cutover  | Started                         | All 16 legacy browser routes, full-page Storybook coverage, ordinary source-development production inventory parity, and 153 of 154 retained endpoint behaviors are implemented; the three reviewed removals stay removed. The external heartbeat consumer cutover and authenticated live smoke, remaining live Gateway/production smokes, restore/cutover rehearsal, fresh production activation, repository-wide simplification audit, legacy deletion, and full-cycle monitoring remain open.                                                                     |

### 2026-08-03 — Phase 0 started

- Dashboard task [#396](/tasks/396) tracks the rewrite foundation.
- The current codebase, deployment/runtime tooling, lint configuration, package graph, and
  approved blueprint were re-audited before implementation changes.
- The repository keeps the existing simple Bun channel model: `.bun-version` selects `canary`,
  and CI installs it through the official SHA-pinned `oven-sh/setup-bun` action. Application code
  targets the Bun `1.4.0` runtime API and accepts newer Canary revisions within that version.
  Each immutable Dashboard release still records and reuses the exact revision that built it.
  When Bun 1.4 is officially released, `.bun-version` changes from `canary` to `1.4.0`; CI and
  deployment otherwise keep the same design.
- The isolated `43783cedd` artifact passes its qualification, server-foundation, database,
  documentation, build, frontend, and backend gates. The host bootstrap runtime was then
  atomically promoted to that same verified artifact; the current production release and both
  production services were not restarted or changed. A fresh full backend-suite run after host
  promotion also passes on the selected artifact.
- Phase 0 qualification runs sequentially with host load, available memory, and swap
  checked around every resource-heavy command. No build, install, or broad test gate runs
  while the VPS is already saturated.
- The rewrite dependency baseline is installed in the worktree: tRPC `11.18.0`, Drizzle
  ORM/Kit `1.0.0-rc.4`, `@valibot/to-json-schema` `1.7.1`, and the Bun-compatible
  `eventsource` `4.1.1` test ponyfill. `@valibot/to-json-schema` is build-time documentation
  tooling, not part of tRPC validation. Bun 1.4 does not expose a global `EventSource`, so the
  ponyfill is test-only; browsers use their native implementation. Both packages are
  development dependencies and stay out of the production runtime and browser bundle.
- The same install refreshed `oxlint-config-presets` to `0.1.18` and
  `@microlink/react-json-view` to `1.31.28`. The lockfile was regenerated with the qualified
  Bun canary. No production service or release was changed.
- The executable qualification suite passes on the exact candidate revision: twelve Bun
  tests across runtime identity, Drizzle/Bun SQLite, and tRPC Fetch/SSE. The database evidence
  covers strict SQLite tables, check/foreign-key/partial-unique/index constraints, synchronous
  transactions and rollback, prepared and parameterized raw SQL, native-client access,
  Valibot schemas generated from Drizzle, and an index-backed query plan. New SQLite setup code
  uses the current `Database.run()` API rather than Bun's deprecated `Database.exec()` alias.
- The tRPC evidence covers validated queries and mutations through `Bun.serve`, tracked SSE
  delivery through the official `httpSubscriptionLink`, a server-forced reconnect, resume from
  the last event ID without duplicate delivery, bounded per-subscriber buffering, and subscriber
  cleanup after client abort or queue overflow, including while a slow generator is paused at a
  yielded event. `eventsource` is injected only into the Bun-side client test. The
  explicit liveness/readiness boundary preserves both `GET` and bodyless `HEAD` probes. Liveness
  remains `200`; readiness now starts unavailable, returns `503`, and can return `200` only after
  the composition root explicitly promotes its injected readiness controller. The generated
  raw-HTTP reference is sourced from separate method-specific response contracts and documents
  both readiness outcomes.
- These focused gates currently pass on the exact candidate: qualification and server
  TypeScript, deterministic documentation generation, Drizzle migration-graph validation, 65/65
  qualification tests, 50/50 server/database tests, 4/4 documentation tests, and 4/4
  database-gate tooling tests.
  Direct event-feed tests also prove gap-free replay to live handoff, a stable replay snapshot
  while retention advances, explicit rejection of a cursor ahead of the feed tail, acceptance at
  the exact tail, and deterministic failure/cleanup when a slow subscriber exceeds its queue
  budget. Repository-wide Oxlint and Oxfmt pass after the consolidated review fixes.
  Production-shaped tests now prove HTTPS reverse-proxy streaming, rolling-release reconnect, and
  bounded slow-consumer behavior inside a verified resource-capped cgroup. Other mandatory
  qualification areas remain open, so these results do not mark all Phase 0 spikes complete.
- The first production-shaped database slice is implemented as seven small Drizzle schema
  modules for migration history, realtime events, reports, monitor runs, incidents, incident
  observations, and notifications. Its reviewed first migration applies to an empty database as
  SQLite `STRICT` tables and passes integrity, foreign-key, lifecycle-constraint, deduplication,
  datatype, and partial-index query-plan tests. An explicit manifest pins both the SQL and
  snapshot SHA-256 values and rejects tampered or unreviewed migration folders before runtime
  application. Review hardening now also enforces object-root JSON plus the shared safe-number
  and nesting-depth boundary in SQLite for report metadata and incident details. Because no
  rewrite database is live, every schema slice regenerates the same unpublished fresh-database
  baseline rather than preserving incremental implementation history. Every fresh-database
  fixture applies only checksum-verified statements through
  Dashboard's native SQLite runner. That runner validates the canonical graph,
  holds an immediate transaction across validation and application, and records the reviewed SQL
  checksum in the owned `schema_migrations` ledger. Before any transaction it requires foreign
  keys and check constraints to be enforced; before success it rejects stored foreign-key,
  CHECK-constraint, or general SQLite integrity failures. Focused tests cover malformed and
  non-object JSON, SQL/snapshot tampering, manifest shape/order, strict tables, enforcement and
  integrity failures, transactional rollback, unknown-schema rejection, mandatory realtime-event
  entity identity, Valibot round-trips, and query plans. The baseline becomes immutable only at
  cutover; genuine post-cutover schema changes then use new checksummed manifest nodes.
- Migration graph validation runs through the read-only `drizzle-kit check` CLI in the foundation
  job. A non-writing `drizzle-kit generate --explain` pass must also report `no_changes`, so a
  TypeScript schema edit cannot drift from the reviewed migration snapshot. A controlled
  schema-only negative probe confirms that the gate prints the planned statement and fails before
  writing a migration. The PR workflow never combines execution of contributor-controlled code
  with a `pull-requests: write` token, so the same gate works for trusted branches and forks. It
  complements rather than replaces Dashboard's checksum, generated-SQL review,
  temporary-database introspection, restore, and query-plan gates. Drizzle-generated Valibot
  select/insert schemas cover all seven tables, with narrow operation schemas only for mutable
  lifecycle rows. Explicit refinements enforce UUIDv7 identifiers, SQL-aligned counters,
  checksums, and valid JSON/object text. Strict storage schemas reject unknown and caller-supplied
  generated fields, and an integration test round-trips a migrated Drizzle row through Valibot.
- The selected Bun revision passes production frontend and backend builds, 705/705 frontend
  tests, and 738/738 backend tests after host promotion. These gates protect current behavior
  while the replacement is still built beside it.

### 2026-08-04 — HTTPS topology and release reconnect qualified

- A Bun TLS reverse proxy now exercises the intended browser-to-proxy-to-loopback topology with a
  short-lived localhost certificate trusted as a private test CA. The probe never disables TLS
  verification. It streams the upstream body, strips hop-by-hop headers, propagates cancellation,
  forwards the test cookie, and overwrites `x-forwarded-proto` with `https`. A dedicated regression
  test aborts the downstream request before upstream response headers arrive and proves that the
  proxy immediately cancels the in-flight upstream request. A deterministic Web Streams regression
  test receives one upstream chunk and then proves that a genuine body failure reaches the
  downstream reader as the same error instead of being misreported as normal end-of-stream. The
  shared request/response sanitizer removes fixed and `Connection`-nominated hop-by-hop fields and
  rejects malformed connection options. TLS integration tests prove both proxy hops, preservation
  of end-to-end fields, proxy-owned forwarding metadata, `400` request rejection, `502` upstream
  rejection, and upstream cancellation. The published proxy URL matches its `127.0.0.1` listener,
  and TLS setup reports a direct prerequisite error if OpenSSL lacks `req` with `-addext` support.
- Release A and release B bind the same loopback port behind one stable HTTPS URL. The test receives
  tracked event `1`, stops release A with an active subscription, writes event `2` while the backend
  is unavailable, observes a proxy `503`, starts release B, resumes from cursor `1`, replays event
  `2`, and then receives live event `3` exactly once. Subscription retry is explicit and bounded;
  queries and mutations are never retried.
- The proxy and backend reject missing credentials and direct attempts that lack trusted proxy
  metadata. GET and HEAD liveness/readiness behavior, the expected release identity, immediate
  subscriber cleanup, deterministic server teardown, and temporary TLS-file cleanup are covered.
- Runtime-facing code and tooling no longer use temporary `greenfield` names. The rewrite server
  factory is `createServer`, scripts use `checkDatabaseSchema.ts` and `generateDocs.ts`, CI uses the
  `server-foundation` job, and the single unpublished migration remains
  `20260804022252_dashboard-foundation`. Security identity and audit objects are regenerated into
  that baseline rather than recorded as a compatibility upgrade. The blueprint keeps its name
  because it documents the rewrite project itself.
- The readiness controller is deliberately dependency-injected and initially unavailable. A later
  composition slice must promote it only after configuration, checksum-verified database startup,
  and other declared critical dependencies complete; this PR does not pretend those dependencies
  are wired already.
- Deterministic queue-overflow tests prove bounded application buffering. The following
  memory-capped spike adds production-shaped proxy/SSE evidence without claiming a universal
  absolute memory bound.

### 2026-08-04 — Bounded SSE memory qualification passed

- This stacked slice adds a capped measurement for four native Bun TLS clients that verify the
  short-lived test CA, read the tRPC connected frame through the HTTPS qualification proxy, and
  immediately pause their socket reads. An initial probe using unread Fetch bodies was rejected:
  Bun continued draining those sockets into internal buffers, so it did not model a stalled TCP
  receiver. The native-client probe remains qualification-only and does not change the production
  or rewrite server composition.
- The load scenario can run only inside a transient user-systemd cgroup that the child verifies
  against the exact generated `app.slice` unit path before opening a listener. The qualification
  cap is 256 MiB `MemoryHigh`, 384 MiB `MemoryMax`, no swap, 32 tasks, 50% of one CPU, and a
  30-second runtime deadline. The uncapped launcher has a 35-second process deadline and 64 KiB
  output cap. Every `systemctl` operation has a two-second deadline and 16 KiB output cap; cleanup
  verifies a graceful stop and escalates to a control-group kill when required.
- The child also reads every controller-bearing ancestor below the unified cgroup root. It rejects
  a parent CPU, memory, swap, or process limit stricter than the declared leaf policy, requires the
  hierarchy and its limits to remain stable, and rejects pressure/OOM counter growth at any parent.
  This prevents a hidden VPS-level controller from silently changing the measured workload.
- `memory.max` and the other cgroup limits are the hard safety boundary; cgroup counters are
  evidence. They are not treated as the complete RSS measurement because shared and file-backed
  runtime pages can be accounted differently. The result therefore records cgroup current,
  kernel peak, and events together with combined qualification-process RSS and
  `Bun.unsafe.memoryFootprint()` at the pre-load baseline, a 20 ms periodic/checkpoint-sampled load
  high-water, and after cleanup. The exact cgroup `memory.peak` is authoritative for cgroup-accounted
  memory and hard-limit enforcement; process RSS remains a separate measurement because it can
  include shared and file-backed pages accounted differently by the cgroup. The process measurement
  conservatively includes the Bun release server, TLS proxy, and synthetic clients. The fixed
  32 MiB post-cleanup growth gate applies to the cgroup's total `memory.current`. Post-cleanup RSS
  and Bun PSS remain diagnostic observations: one cold-baseline transient run cannot distinguish
  allocator/JIT/TLS page retention from a leak, while absolute and sampled-peak process limits
  still apply.
- A repeated capped run exposed why the former shared cleanup-delta gate was invalid: all bounded
  work and cgroup safety checks completed, but post-cleanup RSS was 33,869,824 bytes above its cold
  baseline, only 315,392 bytes over the former 32 MiB process threshold. That run was rejected, not
  retried until lucky. The policy was corrected before the authoritative run so the 32 MiB gate
  applies only to total cgroup `memory.current`; RSS retains its absolute and sampled-peak growth
  gates, Bun PSS retains its sampled-peak growth gate, and both remain exact reported evidence.
- Payload size, per-subscriber event count and queued payload-byte budgets, retained events,
  clients, rounds, maximum generated events, and maximum duration are fixed in code. The reviewed
  workload permits at most 1,024 events of 8 KiB per round for six rounds: 48 MiB of generated
  payload and 192 MiB of live payload fan-out across four clients before framing. Rounds two through
  six deliberately replay the separately capped 128-event retained window to each client, adding at
  most 20 MiB and making the complete pre-framing fan-out bound 212 MiB. Each round must prove that
  transport backpressure reaches tRPC, all four live application queues reach exactly 16 events /
  128 KiB, and the next publish detaches them while the clients remain paused. Because tRPC's SSE
  producer is pull-driven, its HTTP request and the proxy request may legitimately remain pending
  until the stalled downstream pulls again or disconnects. After the paused sockets are
  terminated, both proxy and release must have zero pending requests.
- Each round's three-second deadline starts before the first of its four clients connects and
  covers connection, queue pressure, client termination, and transport cleanup. The enclosing
  cgroup still enforces a 30-second lifetime and the launcher a 35-second outer deadline.
- The live queue byte budget covers events not yet pulled across the application iterator boundary;
  retained replay is bounded separately by the 128-event retention limit. Neither claims to bound
  objects or bytes already accepted by tRPC transforms, Bun HTTP/Fetch, TLS, the proxy, or kernel
  buffers; the cgroup is the hard safety boundary for those layers, and process/cgroup observations
  measure their combined cost. The sustained probe is an explicit
  local command and is not part of ordinary hosted CI or the general integration test command.
  Pure parsers, policy checks, feed limits, evidence rules, launcher construction, and one bounded
  native-socket mechanism test remain deterministic CI tests.
- Review hardening now rejects every signal-terminated launcher instead of treating `exited` as a
  sufficient success signal, reports the exact failing cgroup path, requires the expected leaf path
  and every controller-bearing ancestor, preserves nested CLI failure causes, rejects malformed or
  encoded HTTP framing and CR/LF cookie injection, and publishes a canonical deeply frozen evidence
  object. The final launcher correction replaces Bun's cause-ambiguous native timeout with an owned
  timer and abort signal, so only that exact enforcement can be reported as a deadline; output-cap
  and external signals remain signal failures even when late. Because this changes the enforcement
  mechanism, the complete capped qualification was repeated after deterministic tests.
- The capped run passes on Bun `1.4.0` revision
  `43783cedd5653fa29bb9ac83df34633eae10fe75`. Six rounds and 24 subscriptions completed in
  8,283 ms. Every slow subscriber detached at the exact 16-event / 131,072-byte application queue
  boundary; 3,896 events were published in round counts of 712, 664, 632, 624, 624, and 640, while
  retained events remained capped at 128 and all subscriber and transport counts returned to zero.
- The exact cgroup peak was 80,363,520 bytes (76.6 MiB), warm current memory was 12,214,272 bytes,
  and post-cleanup current memory was 42,340,352 bytes. The sampled combined-process RSS rose from
  48,848,896 bytes to a 99,102,720-byte high-water and ended at 84,070,400 bytes after cleanup;
  `Bun.unsafe.memoryFootprint()` rose from 31,156,224 bytes to 81,036,288 bytes and ended at
  66,049,024 bytes. Kernel `high`, `max`, `oom`, `oom_kill`, and group-kill deltas were all zero at
  both the leaf and every recorded ancestor, no proxy upstream failures occurred, and the verdict
  was `VALIDATED`.
- These measurements qualify this exact runtime, topology, and fixed workload. They do not claim a
  universal maximum for Bun, Fetch, TLS, tRPC, or kernel buffers, and they do not replace the
  broader production resource budget for builds, workers, tests, and privileged jobs.

### 2026-08-04 — Monitoring incident lifecycle implemented

- A transport-independent monitoring domain now accepts one Valibot-validated complete snapshot
  per monitor run. It normalizes stable ASCII monitor/problem identity, derives a versioned
  SHA-256 fingerprint from kind, entity, and condition, sorts problems deterministically, and
  hashes canonical JSON for immutable run idempotency. Bounded JSON objects reject cycles,
  non-JSON values, sparse arrays, excessive depth, and payloads over 64 KiB; report
  bodies and problem counts have separate explicit limits.
- The `Bun.serve` boundary now has a reviewed 640 KiB outer ceiling for maximum task-content
  requests, while the default tRPC profile remains 64 KiB. The monitoring submission API is not
  exposed yet; before it is, its serialized worst case must fit a specifically reviewed
  per-procedure ceiling or use a separately qualified bounded raw/streaming route. The default
  allowance is not silently raised to accommodate a hypothetical future payload.
- The synchronous transaction core and narrow Drizzle repository execute every accepted snapshot
  inside one SQLite `IMMEDIATE` transaction. The transaction inserts the immutable report and monitor run,
  creates or updates incidents, records one immutable observation per run and incident, resolves
  absent active incidents, increments the generation on recurrence, creates exactly one dashboard
  notification per opened generation, marks its unread notification read on resolution, and writes
  compact transactional realtime invalidation events for each changed report, incident, and
  notification.
- A named Effect application service wraps that synchronous core without suspending inside the
  SQLite callback. Validation and immutable-run conflicts use tagged typed failures; unknown
  repository or invariant failures remain defects. The best-effort event-pump wake runs as an Effect
  only after a successful commit and cannot turn committed state into a failed submission.
- Retry behavior is explicit. An identical run ID and canonical submission checksum is a no-op; the
  same run ID with different content is a conflict. Older runs remain queryable as reports but do
  not mutate lifecycle state. Equal completion times use the lowercase UUIDv7 run ID as a stable
  tie-breaker. A completed timestamp more than five minutes ahead of the server clock is rejected
  before repository entry, preventing an accidental epoch-microseconds value from poisoning that
  monitor's ordering watermark.
- The unpublished fresh-database baseline was regenerated in place for this schema slice. Monitor
  runs persist the immutable submission checksum and enforce
  completion ordering; incidents enforce seen/resolution ordering; observations preserve kind,
  severity, and title with one row per run/incident; and realtime events carry an enforced expiry
  with an indexed `(expires_at, id)` retention scan. The migration SQL, Drizzle snapshot, and
  explicit manifest checksums remain aligned.
- Realtime events use a compact `{id}` payload below the qualified 8 KiB event ceiling, share one
  seven-day expiry horizon per transaction, and wake the event pump only after commit. A wakeup
  failure cannot invalidate durable state because adaptive polling is the recovery path. Expired-row
  deletion is intentionally not performed in the request transaction: the approved architecture
  assigns bounded batch deletion and checkpoint work to the later resource-scoped maintenance job.
- Focused normalization, lifecycle, rollback, stale-order, schema-invariant, and query-plan coverage
  passes 25/25 tests. The complete server/database suite passes 54/54, server TypeScript passes,
  Drizzle reports both `check: ok` and schema `no_changes`, and Oxfmt/Oxlint pass on the slice.

### 2026-08-04 — Durable realtime event pump implemented

- The bounded async queue proven by the SSE memory qualification is now a shared production
  primitive rather than a copied implementation. Both the qualification feed and the durable pump
  enforce independent event-count and queued UTF-8 payload-byte ceilings, wake pending readers
  directly, fail deterministic slow consumers, and release pending reads on abort or close.
- A narrow Drizzle realtime store validates every immutable outbox row through the generated
  Valibot select schema and reads only ordered, bounded pages. Every hot-path batch reads its
  cursor bounds and page inside one SQLite read transaction, so concurrent prefix deletion cannot
  move the page beyond a required row without an explicit resync. Its cursor window combines
  retained `MIN(id)` / `MAX(id)` / row count with SQLite's durable `AUTOINCREMENT` high-water mark,
  so a completely pruned journal still distinguishes “no events ever” from “history was removed.”
- Each subscription validates a canonical numeric cursor, captures a stable replay boundary, joins
  the live subscriber set before yielding replay pages, and filters any central-poll event at or
  below that boundary. Events committed during replay therefore enter the bounded live queue once,
  without a replay/live race gap. Cursors ahead of the tail fail explicitly; cursors below the
  retained prefix receive one terminal `resync-required` control delivery. Topic-filtered
  subscribers advance their retention cursor to the predecessor of each sparse replay/live match
  while preserving every unacknowledged matching delivery, and a terminal live failure interrupts
  replay immediately unless request cancellation or pump closure has already won. Topic names are
  trimmed, non-empty, and length-bounded at the store boundary. A process-local cap covers both
  subscriptions still opening and subscriptions already attached, so concurrent replay setup cannot
  bypass capacity control.
- One coalesced pump owns live database reads. Its synchronous core returns an `active`, `idle`, or
  `immediate` poll plan; a scoped Effect fiber owns timing, cancellation, and the capacity-one
  dropping wake queue. Local post-commit `wake()` calls request an immediate page, while commits
  from another SQLite connection are recovered by a 250 ms active poll. The poll backs off to five
  seconds with no subscribers, drains at most 16 rows per page, caps the full
  serialized change delivery at 8 KiB, and disconnects a subscriber that exceeds 16 queued events
  or 128 KiB of serialized deliveries. A malformed over-budget row fails only subscribers whose
  topic filter selects it; irrelevant subscribers advance safely and continue. Subscriber turnover
  raises the central cursor to the lowest cursor already observed by an active subscriber,
  preventing an obsolete global cursor from forcing a safe newer subscriber to resync. Subscriber-
  local cursor failures terminate only that subscriber. Central poll reads and per-subscription
  open/replay reads use the same Effect `Schedule` for bounded `SQLITE_BUSY*` exponential backoff;
  a wake cannot bypass an in-progress retry delay and one successful operation resets the schedule.
  A subscription-local non-retryable failure or exhausted retry budget terminates that subscription
  with a safe typed store error. The corresponding central-poll failure terminates all subscriptions
  attached to that failed polling attempt, while the scoped runner remains available for later
  recovery. An unexpected runner defect stays outside the typed error channel, records only a safe
  structured failure marker, and poisons/closes the scoped service so future streams fail fast; its
  raw `Cause` is not passed to logging until a redacting Effect logger bridge exists.
- Bounded page polls and subscription opens use count-free cursor bounds. The linear retained-row
  count is sampled on a separate 60-second cadence at most, whether the pump is active or idle.
  Metrics expose that count together with its sample timestamp, current retained cursor bounds, the
  oldest cursor still required by an attached subscriber, active subscribers, polls/failures,
  wakeups, subscriber-capacity rejections, scheduled retryable poll and subscription-read retries,
  subscription-read failures,
  catch-up batch size, queue high-water marks, topic-filtered deliveries, slow-consumer drops,
  delivery-preparation failures, and forced resyncs. Delivery-preparation failures count rejected
  preparation attempts across replay and live delivery. `pollFailures` counts every failed poll
  attempt; the retry counters count only failures that scheduled another attempt instead of
  terminating affected subscribers.
- The pump does not delete outbox rows. The later resource-scoped maintenance job remains
  responsible for durable checkpointing and bounded deletion below this published in-process
  cursor boundary. Its expiry scan may identify eligible rows, but deletion must consume only a
  contiguous ID prefix; arbitrary expiry deletion could create interior cursor holes that
  `MIN(id)` / `MAX(id)` cannot detect.
- Focused store, pump, Effect-service, and qualification coverage includes a real two-connection
  SQLite snapshot interleaving, atomic retention revalidation, sparse topic-filtered replay and live
  retention progress, bounded central and replay-read busy retry and exhaustion, subscriber
  turnover, terminal replay
  failure and cancellation precedence, a fully pruned journal, cadence-bound count sampling,
  cross-connection polling without a wake signal, exact queue overflow, full-delivery byte rejection
  and topic isolation, Effect interruption/finalization, abort cleanup, and preservation of the
  original SSE qualification behavior. The pump core remains transport-independent; this slice also
  establishes its scoped Effect service and the global tRPC SuperJSON transformer. At the close of
  that slice, the authenticated `events.stream` procedure, browser subscription, and frontend
  invalidation wiring remained later work.

### 2026-08-05 — Authenticated realtime transport implemented

- The web-server composition boundary now requires one eagerly initialized Effect `ManagedRuntime`
  for the full lifetime of its Bun process. Every request reuses that runtime; each stream iterator
  owns only its subscription-local scope. Shutdown stops the HTTP server before disposing the
  process runtime, bounds graceful draining before forcing long-lived SSE closed, and permits an
  explicit forced call to escalate a pending graceful stop. Lifecycle cleanup remains idempotent.
  The later worker process owns a separate runtime if its workflows need Effect services; neither
  process creates a runtime per request or module.
- `events.stream` is an authenticated tRPC tracked-SSE subscription over the durable event pump.
  Input accepts a canonical resume cursor and a bounded, unique set of registered topics. Topic
  authorization runs before pump access, and each registered topic declares its required
  capability, allowed entity types and operations, and Valibot payload schema.
- The security composition root injects authentication into request-context creation. This slice
  validates and freezes anonymous, invalid, session, and automation results at that boundary;
  persistent session and automation-credential resolution remain owned by the later security slice.
- Valibot validates authentication results, subscription input, durable payloads, and client output.
  Effect Schema remains limited to tagged internal stream failures, which are exhaustively mapped to
  safe tRPC errors. SuperJSON remains only the tRPC transformer; the durable journal stays canonical
  plain JSON.
- Focused unit, procedure, and real Bun/EventSource system coverage proves tracked delivery,
  capability denial before pump access, safe typed-error mapping, unknown-defect redaction,
  process-runtime reuse, abort propagation, and subscription cleanup.
- No transport or utility dependency was added. Browser realtime continues to use tRPC SSE rather
  than Socket.IO; OpenClaw Gateway continues to use Bun's native outbound WebSocket. Authentication
  retains revocable opaque credential validators rather than JWTs, configuration is staged as an
  injected Valibot parser rather than `dotenv`, and HTTP calls use tRPC/native `fetch` rather than
  Axios. Composition-root configuration wiring remains Phase 1 work.

### 2026-08-05 — Security core and fresh database baseline implemented

- Persistent users, browser sessions, automation principals, scoped capabilities, opaque
  credential validators, and an append-only `STRICT, WITHOUT ROWID` audit ledger now have one
  Drizzle schema, storage constraints, Valibot read/write boundaries, and repository-backed
  request authentication. Browser-origin enforcement rejects unsafe cross-site requests before
  tRPC dispatch.
- Long-lived subscriptions receive a required renewable authorization lease. Renewal fails closed
  when the authenticator, principal identity, authorization version, capability set, or persisted
  validator version changes, and the stream scope is finalized on cancellation or renewal failure.
- Every fixed or bounded security text field rejects embedded NUL at both Valibot and SQLite
  boundaries. Audit metadata has bounded depth and safe-integer rules, and append-only triggers
  reject replacement, update, and deletion.
- The unpublished foundation and security migrations were consolidated into one generated
  fresh-database baseline. Compatibility preflights and hypothetical rewrite-database upgrade tests
  were removed. Until cutover, schema work regenerates this one baseline and updates its reviewed
  checksums; after cutover, the baseline is immutable and later production changes append real
  forward migrations.

### 2026-08-05 — First-user and password session lifecycle implemented

- The public `auth.status`, `auth.bootstrap`, `auth.login`, and `auth.logout` procedures and the
  browser-session-only session list, touch, revoke, and password-change procedures now have one
  generated Valibot/tRPC contract surface. Automation principals cannot cross the browser-session
  boundary.
- Bootstrap verifies the submitted Gateway credential through a required injected verifier and
  never persists that credential. Passwords use the exact canonical Bun Argon2id PHC form
  `v=19,m=65536,t=3,p=1` with fixed 32-byte salt and digest fields; persisted hashes are validated
  before Bun can consume their work parameters. Durable sessions store only the SHA-256 validator
  hash and deliver the one-time validator through an always-`Secure`, `HttpOnly`,
  `SameSite=Strict` cookie.
- Password login and bootstrap combine a hashed direct-client-source cooldown with a higher global
  circuit, so rotating attacker-controlled usernames or client sources cannot bypass all durable
  throttling. Source buckets untouched for 24 hours are pruned opportunistically on a later failure
  of that kind and capped at 256 rows per source-scoped kind; successful bootstrap clears every
  bootstrap bucket because the endpoint closes. Trusted forwarding identity is accepted only from
  exact configured proxy peers; raw addresses never leave the HTTP boundary.
- Expensive Argon2 work uses one active operation, a bounded three-item queue, and a rolling
  process-wide budget of 30 verification/hash units per minute, including successful work. Gateway
  checks have a separate two-active/four-queued gate, an enforced five-second deadline, and request
  abort propagation. Underlying verifier promises remain counted until they settle even if they
  ignore cancellation, preventing timed-out work from accumulating without bound. Failure
  timestamps are captured after expensive work so every committed cooldown receives its complete
  duration.
- Password change increments the authentication version, rotates the current session, and revokes
  every older session in one immediate transaction. Status, listing, and activity-touch boundaries
  independently reject stale authentication versions. Session listing and revocation revalidate
  the caller inside their read/write transaction; repeat revocation of a missing target does not
  grow the immutable audit ledger. Login and bootstrap transactionally prune inactive sessions and
  cap each user at 16 active browser sessions.
- Authentication batching is fail-closed: only the read-only `auth.status` and `auth.sessions`
  procedures are allowlisted, and every tRPC request is capped at eight procedures, preventing
  future state-changing auth procedures from inheriting a shared stale request context or public
  status reads from becoming one-request database amplification. Exact Origin and Fetch Metadata checks still run before
  authentication or lifecycle work. Any simultaneous bearer and Dashboard-cookie credentials are
  rejected before context creation. Auth request bodies have a 16 KiB pre-parse ceiling, WebAuthn
  receives 32 KiB, and ordinary procedures retain 64 KiB beneath the 640 KiB Bun listener ceiling
  required by reviewed task-content profiles. Every application-handled tRPC success, error, and
  raw auth rejection uses `Cache-Control: no-store`. A trusted reverse proxy owns the
  total body-read deadline because Bun buffers request bodies before invoking the Fetch handler;
  the production composition is hard-bound to `127.0.0.1` so remote access cannot bypass that
  ingress. The listener uses a 10-second general idle timeout; after its body is fully bounded, an
  authentication handler receives 120 seconds so the maximum reviewed Gateway queue/deadline can
  return normally, while `events.stream` explicitly disables the socket timeout. tRPC `HEAD` is
  rejected at the raw boundary with `no-store`. Cutover qualification must verify the proxy's
  absolute deadline rather than infer it from Bun's inactivity timeout.
- The one unpublished fresh-database baseline now includes the `STRICT`
  `auth_rate_limit_buckets` table. Drizzle reports `no_changes`; checksum, schema, repository,
  lifecycle, procedure, cookie, batching, and real Fetch-adapter tests cover the slice. At that
  checkpoint, native Gateway transport plus MFA, WebAuthn, recovery, and recent-auth remained later
  Phase 2 slices; the next milestone records the completed TOTP/recovery/recent-auth work.

### 2026-08-05 — TOTP, recovery, recent-auth, and structural cohesion implemented

- Password-first MFA now issues only a five-minute pending-login validator. TOTP and one-time
  recovery completion revalidate the user and pending state, consume the proof exactly once,
  rotate the browser session, clear rate-limit state, and append the audit event in one immediate
  transaction. Both completion procedures validate output before writing either hardened cookie
  and declare every reachable safe transport error.
- Account security exposes nine Valibot/tRPC procedures for summary, password reauthentication,
  TOTP enrollment/confirmation/removal, TOTP or recovery step-up, recovery rotation, and MFA
  disablement. The lifecycle enforces recent-auth policy, a maximum of four aggregate confirmed
  possession factors, final-factor protection, ten sequentially hashed recovery codes, and atomic
  session rotation or cleanup for every security-state transition.
- TOTP secrets use versioned AES-GCM envelopes bound to their user/factor storage context.
  Recovery selectors and validators each retain 128 bits of randomness, only Argon2id hashes are
  persisted, TOTP steps and recovery codes are compare-and-swap consumed, and malformed or
  unavailable factors cannot bypass the shared durable attempt, audit, work-gate, or rolling work
  budget limits.
- The stack-wide structure pass replaces oversized mixed-responsibility modules with narrow
  facades and cohesive files: authentication lifecycle policy, state transitions, persistence,
  and behavior suites; MFA login/account orchestration and persistence; raw credential parsing
  versus identity resolution; Bun server lifetime versus tRPC HTTP policy/handling; systemd
  qualification control; SSE evidence policy/schema; paused TLS handshake parsing; and the
  architecture chronicle. Cohesive realtime and monitoring state machines remain intact.
- The web process still owns exactly one eagerly initialized Effect `ManagedRuntime`, now merging
  the durable realtime pump with a process-scoped authentication-work service. Effect owns the
  Gateway two-active/four-queued deadline boundary, password one-active/three-queued admission,
  TOTP two-active/four-queued admission, tagged capacity/timeout/upstream failures, caller
  interruption, queued-slot release, non-cooperative work retention, and scoped cleanup. Password
  work retains its rolling 30-unit/minute budget; TOTP decrypt/verify consumes from a shared
  60-factor-check/minute budget before crypto starts. Authentication-failure settlement retains the
  active permit through its synchronous immediate failure/cooldown transaction, so a queued attempt
  must observe the durable transition before it can begin expensive work. Pure policy,
  cryptographic primitives, and synchronous SQLite units of work remain ordinary TypeScript behind
  Promise-facing runtime ports; no request-local or module-local runtime was introduced.
- One validated recent-auth window is propagated through production composition to password change,
  account-security operations, and browser-session revocation. Session revocation revalidates the
  required recent password or MFA proof in the same immediate transaction as deletion. Session and
  automation authentication also fail closed when persisted creation, activity, MFA, or
  authorization timestamps are ahead of the process clock after a wall-clock rollback.
- The former single architecture chronicle is now an index plus responsibility-focused
  application, data/security, runtime/delivery, progress, and implementation-plan chapters. All
  original decisions remain represented, and the progress chapter records each implemented
  slice without turning generated contract facts into handwritten duplicates.

### 2026-08-06 — WebAuthn credential lifecycle implemented

- Password-first WebAuthn now covers pending-login assertion, account enrollment, account step-up,
  and credential removal through seven strict Valibot/tRPC procedures. The relying-party ID,
  allowlisted origins, ES256 algorithm, roaming-key attachment, required user verification,
  discouraged resident keys, and `none` attestation policy come only from typed composition; no
  request host or forwarding header can influence them.
- The unpublished fresh-database baseline now contains purpose- and binding-constrained
  `auth_challenges` plus globally unique `user_webauthn_credentials`. Challenges are short-lived,
  configuration-fingerprinted, atomically replaced, and consumed exactly once. Credentials retain
  only the public key, fixed device type, mutable backup state, canonical transports, CAS counter,
  label, RP ID, and timestamps. Current-RP usability is exposed in account summaries; drifted
  credentials remain removable but cannot justify removal of the final usable factor.
- TOTP-only, WebAuthn-only, and mixed accounts share one aggregate four-factor cap and the same
  recovery, recent-auth, session-rotation, audit, and disablement invariants. The first possession
  factor enables MFA and creates the recovery set; additional factors do not rotate it. MFA
  disablement deletes TOTP, WebAuthn credentials, recovery codes, outstanding challenges, pending
  logins, and obsolete sessions in the same immediate state transition.
- Registration generation and assertion-option generation stay outside write transactions.
  Attestation parsing and signature verification run through the process-owned Effect WebAuthn
  gate with separate two-active/four-queued admission, cancellation/deadline handling, and a shared
  60-unit-per-minute account/login budget. An admitted ceremony consumes its challenge on success,
  invalid proof, timeout, upstream failure, active cancellation, expiry, or credential-CAS loss;
  capacity rejection, rolling-budget rejection, and queued cancellation leave it untouched.
- Deterministic real ES256 fixtures cover registration, monotonic counters, and valid zero-counter
  multi-device assertions on the pinned Bun/SimpleWebAuthn versions. Focused repository, lifecycle,
  adapter, route, migration, and real HTTP coverage proves replay resistance, unknown-credential
  uniformity, recovery-only login after RP drift, global credential collisions, same-millisecond
  CAS, strict body limits, no-store responses, cookie rotation, and complete mixed-account
  login/step-up/removal.

### 2026-08-06 — Automation principal and credential lifecycle implemented

- The browser-session-only `automationSecurity` namespace now exposes eight strict Valibot/tRPC
  procedures for stable principal and credential-history listing, principal creation, credential
  creation, staged rotation, explicit revocation, exact capability replacement, and terminal
  principal disablement. Automation credentials cannot administer this namespace.
- Every mutation revalidates the operator session, authentication version, MFA enrollment, and
  recent-MFA timestamp after entering the same immediate transaction that owns the state change
  and redacted audit event. Existing-principal mutations use authorization-version CAS; repeated
  revoke, identical capability replacement, and repeated disable are no-ops without duplicate
  audit growth.
- The lifecycle limits enabled principals to 32 and currently usable credentials to four per
  principal while preserving disabled and revoked history through bounded newest-first composite
  cursor pages. Lists expose only non-secret prefixes. Create and rotate return the complete
  domain-bound opaque token once; persisted state contains only its prefix, validator version, and
  validator hash, and no `last_used_at` write path was introduced.
- Rotation is lost-response-safe: one linked replacement remains alongside its predecessor until
  explicit revocation. A partial unique index and custom insert/update integrity triggers prevent
  multiple active or cross-principal replacement relationships. Losing the response therefore
  leaves an identifiable replacement that can be revoked and retried without disabling the old
  credential.
- Capability grants are exact and fail closed when their timestamp precedes principal creation,
  follows the principal's current update timestamp, or lies in the future. Real capability changes
  preserve unchanged grant times and increment the authorization version once; terminal disable
  increments it and revokes every then-usable credential atomically, while the disabled principal
  invalidates all historical tokens. Principal inventory/creation, every credential inventory, and
  enabled-principal credential mutations reject future principal creation/update/disable history
  and future credential creation/revocation history before cursors or active counts can hide it.
  This inventory scan also applies after terminal disablement. Clock rollback does not block
  terminal containment; a future-created row can remain physically unrevoked while principal
  disablement keeps it invalid after the clock catches up.
- This slice adds no Effect service: generation, hashing, policy, and SQLite transactions are
  bounded synchronous work. The deterministic generator now emits all eight procedure rows and 16
  input/output JSON Schemas; 13/13 documentation tests and `docs:check` pass at this checkpoint.
  Full repository CI parity remains a delivery gate rather than a claim of this progress entry.

### 2026-08-06 — Phase 2 trust-and-transport evidence closed

- The first-user production composition now owns a one-shot Bun-native Gateway credential
  verifier. Its handshake was checked against the OpenClaw version installed on the target host,
  `2026.7.2-beta.7 (dabe191)`, using the installed v4 protocol document and compiled
  client/server protocol exports. Legacy Dashboard Gateway, chat, session, agent, and cron code is
  parity input, not protocol authority.
- Composition accepts only literal IPv4/IPv6 direct-loopback `ws://` root endpoints. The verifier
  accepts exactly one text challenge capped at 4 KiB, sends one device-less local-backend v4
  `connect`, and accepts exactly one matching text response up to the installed current 25 MiB
  hello limit. Binary, unknown, duplicate, out-of-order, wrong-ID, contradictory, auth-disabled,
  malformed, oversized, incompatible, closed, timeout, and transport flows fail immediately as one
  redacted unavailable result. Only structured `AUTH_TOKEN_MISMATCH` is an invalid credential.
  `operator.admin`, requested only for this handshake, exposes the required operator role,
  negotiated scope, and token auth mode; no post-connect RPC is sent.
- The native upgrade carries no Origin, authorization, forwarding, or subprotocol header and no
  token-bearing URL. There is no internal reconnect or retry, including for `startup-sidecars`;
  the operator/client retries the entire HTTP bootstrap request under durable cooldown. Candidate
  credentials are neither persisted nor logged, and no user or session is published before
  successful verification.
- Effect remains selective. The existing process `ManagedRuntime` owns the separate Gateway
  admission/active permits, deadline, cancellation, typed failure mapping, and settlement
  lifetime. Success, failure, setup error, transport error, and abort initiate native close; once a
  socket exists, the Promise and permit settle only after close is observed. The adapter stays
  Promise-facing, while Valibot parsing, pure policy, hashing, and synchronous SQLite transactions
  remain ordinary TypeScript. Bun allocates an inbound WebSocket wire frame before the 4 KiB/25 MiB
  application check, so loopback, Gateway-side limits, and bounded concurrency remain part of the
  allocation defense.
- Twenty-three focused protocol/parser, real loopback WebSocket, and real-server tests cover valid and
  invalid credentials, text-only enforcement, both size caps, unknown/duplicate/out-of-order/
  wrong-ID/contradictory frames, exact mismatch classification, header and URL secrecy,
  deterministic absence of retry after `startup-sidecars`, native connection refusal,
  close-confirmed terminal races, redaction, timeout, and real HTTP-to-Effect-to-socket
  cancellation with zero user/session/audit/rate-limit publication. Phase 0 now separately
  qualifies raw continuation frames and fragmented-message behavior. The consolidated
  [Phase 2 threat model](../../security/greenfield-phase-two-threat-model.md) maps the complete
  authentication, MFA, WebAuthn, automation, SSE, migration, and Gateway evidence to misuse cases
  and residual risks.
- This closes Phase 2 only for its documented server-side scope. It does not claim full native
  persistent Gateway qualification. Phase 4 must re-audit the then-installed OpenClaw source and
  protocol before implementing persistent connection, event recovery, sessions, chat, or cron.

### 2026-08-06 — Phase 0 evidence and qualification closed

- Bun `1.4.0-canary.1+17d684360`, full revision
  `17d6843606d76620cb55d31424d7fb0aed51c367`, passed the then-current dedicated qualification
  typecheck and suite: 151 tests, 758 assertions, zero failures, and 31 files. This is a historical
  result for the exact audited candidate, not a repository-wide source-revision pin or a current
  directory layout. Retained mechanisms have since moved into the normal integration, parity, and
  audit structure.
- The selected frontend path is one compiler-first Bun HTML AOT build. Executable fixture and
  actual-build evidence cover Tailwind, lazy chunks, fail-closed inline event/style/base and
  URL-bearing attribute CSP policy, hashes, precompression, absent production source maps, and
  bundle budgets. The exact-pinned TanStack DB adapter result remains historical candidate
  evidence; its provisional adapter and dependencies were not retained. The browser data-layer
  slice must qualify snapshot replacement, batch writes, cache synchronization, optimistic
  conflicts, cancellation, and route teardown against the real implementation.
- File-backed WAL evidence uses separate web and worker processes and covers reader/writer and
  writer/writer behavior, observed busy/locked classification, no-gap/no-duplicate outbox delivery,
  hard-kill claim recovery, savepoints, prepared-statement disposal, checkpoint, backup, restore,
  and integrity. The 150 ms ordered chat-delta batching result is also historical candidate
  evidence rather than retained executable coverage. The chat slice must re-qualify batching and
  immediate tool/item, terminal, cancel, and completion flushes against its production path.
  Source inputs are read through held no-follow descriptors with deterministic shrink, growth,
  overwrite, and requested-path replacement rejection.
- Raw RFC 6455 tests cover continuation reassembly, a UTF-8 code point split across three frames,
  orphan/interleaved-fragment `1002` closes, invalid-length and 64 KiB application-bound `1009`
  closes, deterministic cancellation/close, partial writes, native refusal, and exactly one
  connection attempt without reconnect.
- The two-generation shutdown test withdraws readiness before cleanup, closes SSE and the local
  Gateway connection, disposes the statement and WAL database, recovers the worker lease, reaps its
  owned child with bounded SIGTERM-to-SIGKILL escalation, and restarts on the same database without
  a leak. The candidate's
  intentional keep-alive behavior requires a scoped Effect graceful-stop fiber followed by a
  separately bounded force escalation; the candidate records `listener-force-stopped` and closes
  every owned resource. Stream cancellation is separately bounded so a non-cooperative Fetch body
  cannot block older scope finalizers. The production listener now uses the same process
  `ManagedRuntime` for its tagged graceful/deadline/force orchestration, including explicit force
  requests, original-fiber settlement, and best-effort containment after graceful rejection; a
  stop failure preserves runtime services until terminal supervisor containment.
- Source-derived parity now accounts for all 156 current HTTP operations plus `/ws`. The OpenClaw
  audit pins 23 redacted source/protocol/UI artifacts for installed `2026.7.2-beta.7 (dabe191)`,
  including the generic-event, ephemeral plan/checklist projection, compute-starting companion ask,
  and background-task list/detail/cancel semantics. These are Phase 4 adapter requirements, not an
  invitation to scrape the Control UI.
  The route-tree source parser accepts only the reviewed recursive `addChildren` grammar and
  accounts for every child identifier regardless of naming suffix.
- The exact-candidate capped resource matrix passes without `high`, `max`, `oom`, or `oom_kill`
  memory events, memory pressure, or leaked process, unit, or temporary state:

    | Scenario              | Peak memory (bytes) | Elapsed (ms) | Peak tasks |
    | --------------------- | ------------------: | -----------: | ---------: |
    | Frontend build        |         650,104,832 |       14,793 |         19 |
    | Representative tests  |         248,758,272 |        2,222 |         18 |
    | SQLite outbox/restore |         101,896,192 |        1,218 |         20 |
    | Chat batching         |          42,676,224 |           97 |         12 |
    | Complete shutdown     |         128,774,144 |        3,133 |         25 |
    | Child-process cancel  |         117,194,752 |        1,531 |         24 |

- Phase 0 closed with Phase 1 delivery work still open at that checkpoint. The later Phase 1 entry
  below records its closure. Final production load, restore, cutover, and legacy-removal evidence
  remains in Phase 6.

### 2026-08-06 — Source-boundary enforcement foundation

- A Babel-AST gate now accounts for static imports, type imports, re-exports, literal and
  nonliteral dynamic imports, and `require` calls. It discovers JavaScript/JSX, ESM/CJS, and
  TypeScript extension variants across `src`, repository scripts, and the reviewed Drizzle and
  Tailwind root configurations. It permits `.tsx` only in the strict browser graph and otherwise
  fails closed unless source is `.ts`; unknown root executables and top-level source directories
  also fail. Relative specifiers require an explicit reviewed extension and an exact contained
  target. Production source additionally fails on unclassified process roots, repository aliases,
  unreviewed URL schemes, repository escapes, source-tree symlinks, test imports, forbidden
  cross-process directions, and binding-aware environment, module-loader, code-evaluation, or
  process-execution authority outside its explicit role. This is source-policy enforcement rather
  than a runtime sandbox. The isolated future root now rejects imports outside itself; no import
  allowance into the old backend or frontend exists.
- TypeScript now uses exactly three configuration files and two child compiler graphs.
  `tsconfig.json` owns the strict shared rules, has `files: []`, and references the browser and Bun
  configs; both children extend it. The Bun child checks server, worker, scripts, and non-browser
  tests with Bun/Node types and no DOM. The browser child adds DOM/JSX and explicit browser
  source/test membership. There is no server config or per-role configuration proliferation.
  Supported Oxlint restricted-import/global rules provide a fast guard, while the AST checker and
  the TypeScript solution are authoritative.
- `greenfield/` is a self-contained future repository root. Cutover promotes its contents to the
  repository root and deletes the old implementation rather than merging the source trees or
  preserving compatibility code.

### 2026-08-06 — Typed configuration, errors, and observability boundary

- One immutable registry now owns the 13 accepted web/worker environment names, value policy,
  process roles, defaults, secret/browser exposure, restart semantics, and generated reference
  text. The app-owned environment source projects only registered keys for the selected role;
  server modules cannot import it or read runtime environment aliases directly. The injected
  Valibot parser produces a deeply frozen web configuration with exact origin, trusted-proxy,
  loopback Gateway, WebAuthn, duration, path, log-level, and redacted TOTP-keyring policy. A real
  executable process root and realpath validation remain Phase 1 delivery work.
- `docs/generated/configuration.md` is derived from the same registry and fails closed on missing
  metadata, duplicate fields, or a secret marked value-visible. Rejected values and Valibot issues
  never enter configuration errors, inspection, JSON, logs, or documentation.
- The existing process `ManagedRuntime` now requires and installs exactly one structured logger,
  and the HTTP/tRPC boundaries reuse that exact instance. Runtime-allowlisted event/component/
  field/outcome/correlation data produces bounded NDJSON; unknown messages and fields are dropped
  or normalized, failures retain only coarse tags plus a bounded fingerprint, and sink faults emit
  one constant stderr fallback. Sink writes and flushes must settle synchronously, and runtime
  disposal precedes the idempotent flush.
- The Bun request boundary creates correlation before application routing. Application responses
  receive `x-request-id`, and each dispatch emits exactly one terminal HTTP response-created,
  sanitized-defect, or client-cancellation event. A tRPC defect may additionally emit one
  correlated diagnostic before its sanitized `500` response-created outcome; it is not a second
  terminal HTTP outcome. Cancellation carries no defect fingerprint. SSE termination
  observability remains assigned to the later realtime/browser lifecycle rather than being
  overstated here. Bun's outer pre-dispatch body ceiling remains the documented exception.
- The actual 36-procedure router, public contract metadata, and a server-owned
  `ContractErrorCode` allowlist now match mechanically. Immediate and deferred subscription errors
  outside a route's declared set are internalized, as is any implemented procedure missing from
  the policy; framework routing and input/transport validation remain implicit. At this checkpoint,
  executable web/worker roots, worker lifecycle, browser shell, and release/rollback delivery were
  still open; the Phase 1 closure below records their completion.

### 2026-08-06 — Process-owned database runtime

- The production Dashboard runtime now coordinates a dedicated database `ManagedRuntime` with a
  separate application `ManagedRuntime`. The retained database scope owns one strict native SQLite
  connection and the exact Drizzle client built from it; Dashboard repositories and the
  database-backed realtime pump use that same handle through narrow ports. Request handling cannot
  create or dispose a database or runtime. Listener drain completes first, then the application
  scope finalizes realtime and authentication work before the database scope passively checkpoints
  and strictly closes SQLite; the process logger flushes only after both scopes are disposed.
- Startup verifies the complete release-owned migration graph before database mutation. The Linux
  artifact reader holds descriptor-rooted directories and regular files through `/proc/self/fd`,
  rejects symlinks, hardlinks, special files, inventory drift, path replacement, invalid UTF-8,
  and checksum mismatch, and enforces 1 MiB SQL, 4 MiB snapshot, and 32 MiB graph ceilings. The
  manifest is ordered, unique, and capped at 64 nodes with 128-byte identifiers.
- The database lives at one fixed filename beneath a canonical current-user-owned `0700` state
  directory. Dashboard creates a missing file with exclusive no-follow `0600` semantics, opens it
  through SQLite with `create: false`, pins and revalidates the directory and file device/inode
  identities, and validates every rollback-journal, shared-memory, or WAL sidecar present during
  acquisition as a single-link current-user-owned `0600` regular file. It also rejects a writable
  or untrusted ancestor chain and never mutates host permissions. Persistent state remains at
  `<project-root>/production/state` inside the existing project layout. At this checkpoint, safe
  ancestor preparation and disposable activation were still Phase 1 blockers; the delivery entry
  below records their implementation and verification.
- Every connection verifies foreign keys and checks enabled, `trusted_schema` disabled, WAL,
  `synchronous=FULL`, a 1,000-page automatic checkpoint, and `busy_timeout=0`. Zero is deliberate:
  SQLite never blocks the Bun thread waiting for another process; bounded Effect schedules own
  startup admission and realtime read retries instead. A five-second startup deadline covers
  busy/locked variants without exposing native errors.
- `initialize-empty` applies the single unpublished baseline atomically; `validate-only` never
  creates an absent database. Already-current state is revalidated against the exact schema and
  immutable ledger. The ledger enforces bounded canonical ids, exact checksums/release identities,
  strictly increasing non-future timestamps, and append-only triggers. A reviewed pending graph
  fails closed with `DatabaseRuntimeSnapshotRequiredError`: the later delivery slice below adds
  verified snapshot, copied candidate migration, promotion, worker startup, and release-pair
  rollback without weakening normal web/worker startup modes.

### 2026-08-06 — Phase 1 delivery foundation closed

- Real browser, web, worker, and database-maintenance entrypoints now build deterministically from
  the future root. The browser owns singleton router/query providers, an accessible shell, React
  error containment, immutable manifest-indexed assets, controlled SPA fallback, strict security
  headers, representation-specific validators, precompression, and enforced bundle budgets.
- Releases are clean-commit addressed and record the exact Bun revision, lockfile/direct package
  identity, migration graph, generated documentation, browser/process/systemd artifact hashes,
  build commands, and process roles. Publication verifies and freezes the complete tree; runtime
  startup accepts only the matching immutable release and installed Bun identity.
- Production state remains exclusively beneath `<project-root>/production`. Descriptor-rooted
  preparation narrows unsafe current-user ancestors without broadening permissions and rejects
  symlink, owner, device, inode, or path replacement drift. Web/worker structured logs, stdout,
  stderr, backups, transition workspaces, and child output all remain project-local.
- Deployment holds one lease across snapshot, copied candidate migration, database promotion,
  release/runtime pointer changes, readiness, activation-record compare-and-swap, and cleanup. A
  durable journal recovers interruption at the promotion boundary. Any pre-commit failure stops a
  partially started candidate and restores the previous database/release pair; a post-commit
  cleanup failure retains the committed candidate.
- The two replacement user-systemd units are part of the immutable manifest. Installation accepts
  only those exact files, atomically replaces protected user-unit entries, reloads user systemd,
  and never implicitly starts, stops, enables, or disables a service. Activation installs the
  verified stop-owner units before the first stop (using the candidate on an empty host), starts
  worker before web, and stops web before worker; rollback reinstalls the previous release's units
  first.
- This Phase 1 user-unit installer was subsequently superseded by the root-systemd authority
  completed on 2026-08-13 and is no longer present in the candidate. The first production cutover
  is a manual replacement: the operator removes the legacy user units, provisions the exact
  manifest-bound root units, and invokes Greenfield activation only after root-unit verification.
  It does not attempt to roll the candidate through the earlier user-systemd executor.
- A disposable project lifecycle performs the real browser/process build, documentation and
  migration gates, exact runtime publication, empty-database initialization, web/worker startup,
  readiness, browser serving, project-local logging, and complete shutdown. Focused adversarial
  tests additionally cover path swaps, immutable artifact tampering, failed readiness, partial
  start, crash recovery, stale activation state, and post-commit cleanup interruption.

This completes Phase 1 only. Phase 3–6 domains, persistent Gateway/chat, privileged adapters,
full-browser parity, production rehearsal, cutover, and legacy deletion remain open.

### 2026-08-07 — Phase 3 task domain and browser slice

- A normalized task aggregate now owns tasks, canonical labels, optional automation profiles,
  progress updates, and an append-only task-event history. Immediate admitted transactions keep
  every aggregate mutation, audit record, and realtime outbox event atomic; version checks reject
  stale edits and status movement without replaying a started callback.
- Eleven typed task procedures cover list/detail, create/update/delete, assign/move, and progress
  add/update/delete/list. Effect services preserve typed domain failures, Valibot validates every
  boundary and persisted record, capability policy separates task reads from writes, and task
  mutations publish bounded realtime invalidations.
- Exact procedure metadata assigns 640 KiB only to task create/content update and 128 KiB only to
  progress add/update; all other task procedures retain the 64 KiB default. Canonical first-party
  serialization of every maximum contract value fits its profile, while unknown and malformed task
  procedure names cannot inherit either larger allowance.
- Mira-relevant task events also create one redacted `task_notification_outbox` intent in the same
  transaction. The queue preserves legacy create/update/assignment/movement/progress/deletion
  semantics, suppresses `openclaw-task-tracking` self-notifications, hides task titles from other
  automations, labels retained task fields as untrusted data, and uses the task-event ID as the
  stable Gateway idempotency key. The Effect worker claims one delivery per lease, aborts a stalled
  send before its lease can expire, clamps settlement timestamps to the row's creation and claim
  times across clock regressions, and only acknowledges or releases work while it still owns a
  live lease. No greenfield process is activated in production before final cutover, and that
  cutover remains gated on composing the Phase 4 persistent authenticated Gateway client rather
  than reusing the one-shot bootstrap verifier. Task intents therefore cannot accumulate in
  production without their consumer.
- `/tasks` provides the reviewed four-column operator layout, server-side search and
  assignee/recurring filters, accessible create/edit/detail/progress dialogs, and status movement
  through `@dnd-kit/react`. Shared Headless UI controls, TanStack Form, TanStack Query, and the
  existing reusable Dashboard presentation components own browser behavior rather than local
  control implementations. Labels use one lossless line per value so commas round-trip, and hidden
  automation drafts are validated only while their relationship is enabled.
- The reviewed parity inventory now marks the 11 task operations and `/tasks` route implemented.
  This closes only the task portion of Phase 3. Agent, report, incident, notification, job,
  monitoring API, overview, cache/metrics, and real worker execution remain explicit gates.

### 2026-08-07 — Phase 3 agent status and task-history slice

- A reviewed, code-owned directory defines the five Dashboard automation agents independently of
  Gateway connection state. Typed `agents:read` and `agents:write` capabilities expose exact
  configuration, one/all current statuses, keyset-paginated task history, and scoped metadata
  updates without treating mutable Gateway discovery as application authorization.
- `agent_task_runs` retains one active interval per configured agent and immutable completed
  history in a strict `WITHOUT ROWID` table. Every transition revalidates persisted rows, records
  the user or automation actor, and runs behind immediate-write admission. State changes append a
  durable `agents.status` realtime invalidation in the same transaction and wake delivery only
  after commit; same-task heartbeats update activity without unbounded realtime-event growth.
- `/agents` uses the shared Dashboard shell and presentation primitives, query-backed TanStack DB
  collections for normalized definitions and live statuses, TanStack Query for keyset-paginated
  history, TanStack Table, and the shared virtualizer. Durable realtime events invalidate the
  relevant collection/query roots; a 30-second fallback begins only after the terminal event
  stream closes. Current-task mutation remains an authenticated automation boundary rather than a
  browser editing control.
- The parity inventory now marks the five agent operations and `/agents` route implemented.
  Persistent OpenClaw/Gateway availability and session state remain Phase 4 work; reports,
  incidents, notifications, schedules/jobs, overview, cache/metrics, and the real worker remain
  open Phase 3 gates.

### 2026-08-07 — Phase 3 monitoring ingestion and catalog slice

- One automation-only `monitoring.submitCompleteSnapshot` boundary now exposes the complete-run
  state machine through `monitoring:write`. It shares the production database repository,
  immediate-write admission, domain clock, and post-commit realtime wake path with the report,
  incident, and notification catalogs.
- Twelve catalog procedures provide keyset-paginated incident, notification, and report reads;
  immutable report upserts for scoped browser sessions or automation callers; automation-only
  notification producer upserts; session-owned notification read/delete actions; and bounded
  report deletion. Exact `reports:*` and `notifications:*` capabilities and principal-kind
  middleware keep browser-session actions separate from automation-only ingestion.
- Complete snapshots and report upserts have a qualified 640 KiB transport profile plus a stricter
  512 KiB semantic aggregate budget. Each embedded JSON object retains its separate 64 KiB budget.
  Exact registered procedure matching prevents unknown, malformed, or batched names from inheriting
  the larger allowance, while authentication and WebAuthn retain their stricter profiles.
- Typed validation, replay, catalog conflict, not-found, precondition, and database-admission
  failures map to the declared tRPC error policy. Mutations clamp durable timestamps across clock
  regressions, cap report-linked deletion work, and keep catalog writes, audit state, and compact
  realtime invalidations atomic.
- Generated procedure and realtime documentation now comes from the same Valibot contracts. The
  reviewed parity inventory marks all six notification and four report legacy operations
  implemented; incident reads and complete monitoring ingestion are net-new. Incident-generation
  notifications retain a forward deep link to the immediately stacked authenticated `/incidents`
  reader rather than choosing one arbitrary observation report; greenfield stays inactive until
  the complete cutover stack lands. Browser workflows, schedules/jobs, overview, cache/metrics,
  and real worker execution remain open Phase 3 gates.

### 2026-08-07 — Phase 3 report and incident browser readers

- `/reports` now lists only bounded report summaries and loads the potentially large Markdown body
  through an exact query after explicit selection or a validated UUIDv7 deep link. Status, free-form
  kind, and source filters apply atomically; overlapping keyset pages are identity-deduplicated;
  transient refresh failures preserve usable cached rows; and raw HTML remains disabled in the
  existing shared Markdown renderer.
- Report deletion has an explicit confirmation boundary, removes the durable success from every
  cached filtered page before refetch, and presents fixed `NOT_FOUND` and bounded
  `PRECONDITION_FAILED` outcomes without exposing server text. Exact detail loading remains
  independent of list availability, so a valid deep link can still render during a catalog-list
  failure.
- Net-new `/incidents` is intentionally absent from the main navigation but linked from Reports.
  It provides kind, monitor, lifecycle-state, and severity filters; a selectable TanStack Table
  with the shared virtualizer; and exact detail deep links outside the currently loaded page.
- `monitoring.reports` and `monitoring.incidents` use the shared coalescing invalidation hook,
  terminal-resync handling, and 30-second fallback refresh. Both routes retain the authenticated
  boundary, validated lazy tRPC contract loading, cancellation signals, and separate query roots.
- Frontend parity now marks legacy `/reports` implemented. `/incidents` has no legacy route and is
  tracked as a net-new reader. The notification center, schedules/jobs, overview, cache/metrics,
  and the real worker remain open Phase 3 gates.

### 2026-08-07 — Phase 3 notification browser state

- The authenticated global shell now owns an accessible shared popover notification center. Its
  bell uses the server-owned global unread count independently of the currently materialized rows;
  cached rows and counts remain usable through transient refresh failures.
- A query-backed TanStack DB collection materializes the named newest 100-row window while the
  complete query result retains global read/unread counts and the exact history cursor. Older
  filtered history loads lazily one keyset page at a time with stable newer/older controls; the
  selected page is identity-deduplicated against the newest window without changing newest-first
  order or hiding older catalog rows.
- Read-state and severity filters, safe same-origin report/incident links, single mark-read and
  delete actions, and confirmed clear-read behavior use the shared Dashboard presentation and
  fixed-error boundaries. Titles and messages remain ordinary React text rather than Markdown or
  raw HTML.
- Bounded mark-all-read and clear-read operations run sequentially with identical filters until
  the server reports completion, with a defensive 32-batch browser ceiling. Invalid continuation
  fails closed, partial completion is disclosed, all actions are disabled during the loop, and
  notification queries are invalidated even after a later batch fails.
- `monitoring.notifications` uses the shared coalescing invalidation hook, terminal-resync
  handling, and 30-second fallback refresh. Logout/session loss serially cleans the notification
  collection with the other authenticated collections. A root identity-transition boundary also
  clears mutation state and gates private UI until a fresh registry exists, so reauthentication
  performs a new transport request instead of reviving an empty ready instance.
- Notification server and browser parity are now complete. Schedules/jobs, overview,
  cache/metrics, and real worker execution remain open Phase 3 gates.

### 2026-08-07 — Phase 3 durable schedules, jobs, and worker foundation

- Seven strict scheduling tables now persist the reviewed schedule directory, explicit disable
  intents, one durable run state machine, bounded ordered events, worker instances, fenced
  resource leases, and the singleton cross-process claim-pause control. SQL checks and triggers
  protect immutable execution snapshots, legal lifecycle transitions, append-only history,
  canonical resource sets, caller-scoped idempotency, event/byte reservations, and optimistic
  versions even when writes bypass the service layer.
- Nine `jobs:read`/`jobs:write` procedures expose stable keyset-paginated run and schedule reads,
  session-only cancel/pause/update operations, and a caller-scoped idempotent manual-run boundary.
  Automation can invoke only registry actions explicitly marked for `jobs:write`; this slice
  exposes only the harmless `system.worker-smoke` action. Durable audit rows and compact
  `jobs.runs` / `schedules.records` invalidations commit with each externally visible mutation.
- Schedule cadence is distinct from operator configuration versioning. A due schedule with active
  work retains its cursor and later coalesces exactly one occurrence; manual runs never move it.
  Disabled schedules retain a dormant internal cursor, so expiry or re-enable resumes interval
  cadence without drift. Expired intents close under a system actor and re-enable the schedule in
  one admitted transaction, while disabling cancels only queued schedule-triggered work.
- The separate Bun worker now owns an Effect-coordinated single-capacity execution loop with
  registration/heartbeat, bounded recovery and candidate scans, atomic resource claims, lease
  renewal, persisted cooperative cancellation, retry-safe backoff, timeout, bounded progress and
  output, fenced settlement, and ordered drain/stop. Unexpected heartbeat, scheduler, claim, or
  coordinator completion fails the process rather than leaving a zombie worker.
- A migrated-database system test enqueues the code-owned smoke action through the shared
  repository, lets the worker claim it, and observes a durable successful result without shell,
  Gateway, or host-mutation authority. The parity inventory marks the nine Dashboard jobs and
  schedules operations implemented. The five `openClawCron.*` operations and `/jobs` browser
  remain planned, along with overview and cache/metrics.

### 2026-08-08 — Phase 3 Dashboard-local jobs browser

- Authenticated `/jobs` now exposes the global queue summary, live worker inventory, versioned
  claim pause/resume, filtered keyset-paginated run history, exact run detail, bounded event
  history, and confirmed cancellation. Independent validated `runId` and `scheduleId` search
  parameters preserve direct links outside the currently loaded pages and drop malformed values
  without issuing detail requests.
- The code-owned schedule directory provides enabled-state filtering, exact detail, keyset run
  history, a TanStack Form cadence editor for interval, daily, and five-field cron variants,
  explicit disable-intent creation/replacement, re-enable, and caller-scoped idempotent manual
  execution. A failed refresh cannot erase a validated mutation result or already cached detail.
- TanStack Query owns remote state and mutation repair; TanStack Table plus the shared virtualizer
  bound maximum-sized run and schedule pages. A separate one-row queue snapshot refreshes live
  worker freshness every 10 seconds without reloading accumulated history pages or emitting
  heartbeat realtime spam. `jobs.runs` refreshes both queue/run and embedded schedule projections,
  while `schedules.records` refreshes the schedule root. Both topics retain shared coalescing,
  terminal resync, and 30-second fallback behavior.
- Route-level tests cover auth gating, navigation, independent deep links, malformed search,
  list/detail isolation, overlapping-page deduplication, realtime refresh, pause, cancellation,
  versioned schedule updates, and lost-response-safe manual execution. Legacy `/jobs` frontend
  parity remains `planned` because the required OpenClaw cron half belongs to Phase 4; overview and
  cache/metrics also remain open.

### 2026-08-08 — Phase 3 cache contract, persistence, and first provider

- Three typed procedures now expose one exact cache entry, a bounded payload-free status snapshot,
  and caller-scoped idempotent manual refresh. `cache.getStatus` returns at most 128 canonical rows
  with one clamped read clock, the full `totalCount`, and an explicit `truncated` flag. The reviewed
  parity inventory marks `cache.getEntry`, `cache.getStatus`, and `cache.refreshEntry` implemented;
  the composite heartbeat projection remains planned until its OpenClaw cron dependencies exist.
- Durable `cache_entries` keep last-known-good payload, metadata, source, schema, success, and expiry
  separate from the latest attempt result. Freshness is derived at read time, so a failed refresh
  can remain fresh until expiry and then become stale; a failure without prior data remains missing.
  SQL and Valibot invariants reject partial projection groups and inconsistent attempt state.
- The pure job registry now separates browser-safe action definitions from worker-only executors.
  The first provider, `system.host`, collects bounded `node:os` and `statfs("/")` values without a
  shell, rejects unsafe integers and control characters, and persists only fixed redacted failure
  details. Its code-owned daily schedule is due immediately on first registration while later
  reconciliation preserves cadence.
- Cache success or failure and its `cache.entries` realtime invalidation commit atomically only
  while the worker still owns the exact running attempt, worker ID, lease token, and unexpired
  claim. A retry claim fences the prior attempt; failures preserve last-known-good data. Manual
  replay is resolved before mutable provider, action, or schedule lookup, and the public
  `manualRunAvailable` flag is derived from the current exact action definition rather than stored
  database state.
- `cache:read` and `cache:write` are enforced at the contract, tRPC, automation-capability, and SQL
  boundaries. The web and worker processes open independent repositories and write-admission
  scopes over the same database file and claim-fencing protocol. API enqueue wakes the web event
  pump locally; worker-originated cache outbox rows are discovered through its bounded adaptive
  cross-process polling. Cache browser consumption, metrics, overview, persistent OpenClaw cron,
  and the remaining Phase 3 exit gates stay open.

### 2026-08-08 — Phase 3 cache browser and overview foundation

- The authenticated root route now consumes the bounded cache status projection and loads exact
  entry detail only after selection. Its inventory preserves `totalCount` and `truncated`, keeps
  freshness separate from the last attempt result, virtualizes larger snapshots, and renders only
  the reviewed `system.host` payload rather than exposing generic cache payloads or metadata.
- TanStack Query owns the remote state. Status polling advances derived freshness every 30 seconds,
  while `cache.entries` events coalesce precise status and selected-entry invalidation through the
  shared realtime fallback and terminal-resync behavior. Transient refresh failures retain the
  last validated snapshot and expose only fixed, non-sensitive warnings.
- Manual refresh is available only for providers that advertise it. Lost-response retries retain
  one caller/auth-generation-scoped idempotency key per cache key, and confirmed enqueue results
  repair job projections before best-effort cache, job, and schedule invalidation. The UI presents
  the validated run state and links to the exact run; exact cache state remains authoritative for
  clearing accepted-run feedback.
- Route and component coverage locks auth gating, lazy exact reads, truncation disclosure,
  accessibility, safe payload validation, separate freshness/attempt presentation, realtime
  invalidation, and retry-safe refresh. No contract, server, database, or migration surface changes
  in this slice. Root-route parity remains `planned`: metrics and the remaining Phase 3 overview
  composition are still open. Parity bookkeeping assigns OpenClaw cron and `cache.getHeartbeat` to
  Phase 4 with their persistent authenticated Gateway dependency.

### 2026-08-09 — Phase 3 system metrics and overview gauges

- Browser sessions now have one `system.metrics` query with no automation capability. Its strict
  response exposes only CPU load, memory and root-disk capacity, aggregate network throughput,
  uptime, sample time, and freshness. Hostname, CPU model, interface identity, raw collector
  failures, control authority, shell execution, and a new realtime topic remain outside the
  contract.
- The process runtime owns one demand-driven sampler. Concurrent reads share a single in-flight
  collection, successful reads retain one last-known-good snapshot, and a failed collection may
  return that snapshot as explicitly stale for at most 30 seconds before the procedure fails with
  fixed `SERVICE_UNAVAILABLE` text. Linux network rates warm from two monotonic aggregate counter
  samples; counter resets and clock regressions return to the disclosed warming state.
- The root route polls the ordinary TanStack Query every five seconds and renders accessible CPU,
  memory, disk, uptime, download, and upload cards above the cache browser. Query failures retain
  validated data, server fallback is visibly marked stale, the first network sample says
  `Sampling…`, and no chart dependency or duplicate client state owner is introduced.
- Contract, collector, single-flight, authorization, safe-error, polling, formatting, component,
  Storybook, and route tests cover the slice. `system.metrics` is implemented and registered, while
  legacy `GET /api/metrics` parity remains `planned` because its application-observability, HTTP,
  polling-snapshot, and token projections are not part of this bounded host-gauge procedure. Full
  `/` parity also remains `planned`: the remaining Phase 3 overview composition and later-phase
  weather, quota, Git, Docker, database, backup, and privileged operational cards are not claimed
  by this metrics slice.

### 2026-08-09 — Phase 3 reports overview composition

- The authenticated root overview now reuses the existing keyset-paginated `reports.list` query
  for one bounded newest-50 summary window. It counts only that disclosed window, renders the
  already canonical newest summary and status, links to the full reports route, and never requests
  report Markdown bodies or metadata.
- The card uses a dedicated first-page query under the reports cache namespace, so previously
  loaded catalog pages cannot widen root refresh work. It shares the existing durable report
  realtime invalidation with its 30-second fallback refresh. Initial loading and safe-error states
  are explicit, while a failed background refresh retains validated summaries and displays only
  fixed browser failure text.
- This is progressive root composition only. `/` remains `planned`; jobs still require the Phase 4
  OpenClaw-cron half, legacy `GET /api/metrics` still lacks its wider observability projections,
  and later-phase weather, quota, Git, Docker, database, backup, and privileged operational cards
  are not claimed here.

### 2026-08-09 — Phase 3 core operations overview composition

- The authenticated root now composes every implemented Phase 3 operator domain, with new read-only
  cards for newest unfinished tasks, the Dashboard-owned agent-task projection, exact
  global notification read counts, persisted active incident generations, the Dashboard-local job
  queue, immutable reports, bounded host metrics, and the existing cache browser. The new cards
  link to the exact `/tasks`, `/agents`, `/incidents`, `/jobs`, and `/reports` readers
  without adding mutation controls, contracts, capabilities, dependencies, or server work; the
  pre-existing cache browser retains its reviewed queue-refresh action.
- Tasks use an independent newest-100 query below the task-list cache root with fixed `todo`,
  `in-progress`, and `blocked` filters. Window counts and continuation disclosure never claim a
  global total. Active incidents similarly use an isolated newest-12 query below the incident-list
  root with the exact `active` lifecycle filter; the card calls this persisted lifecycle state and
  does not reinterpret it as current monitor health.
- Agent definitions and statuses stay in their existing normalized query-backed collections. The
  card labels `working` and `idle` as Dashboard-owned current-task state, discloses any temporary
  cross-response mismatch as `Missing projection`, and explicitly excludes Gateway presence and
  sessions. Collection error handling now distinguishes an initial query failure from retained
  validated data, so an unavailable first projection cannot render a misleading zero-agent card
  while background failures keep the last complete projection visible.
- Notification read/unread counts remain exact global values from the shared newest-100 result.
  The root observes the same exact cache entry already owned by the shell notification center and
  deliberately does not mount a second realtime subscription. Shared destination and severity
  presentation moved into a component-independent module for the row and overview consumers.
- The job card reuses bounded `jobs.listRuns({ limit: 1 })` and selects its global queue summary
  under a dedicated query key. It separates persistent run-state totals from claiming control,
  labels the fresh-worker window `32+` at its contract maximum, uses the global running count, and
  presents the oldest queued timestamp without calling failures recent health or claiming paused
  state a paused queue. Ten-second polling and existing job/schedule realtime invalidation keep the
  projection current while excluding OpenClaw cron.
- Dedicated loading, safe initial-error/retry, background-retention, realtime refresh, cache-key,
  route-integration, accessibility, and Storybook coverage lock these boundaries. Root composition
  for implemented Phase 3 domains is complete, but `/` and `/jobs` parity remain `planned`:
  wider metrics plus weather, quota, Git, Docker, database, backup, logs, and privileged operational
  controls remain later-phase gates, while the Phase 4A OpenClaw-cron vertical deliberately omits
  privileged command/script editor parity.

### 2026-08-09 — Phase 4 compact Gateway heartbeat projection

- `cache.getHeartbeat` now returns schema version 1 with the existing bounded payload-free cache
  status plus sanitized process-owned Gateway connection phase/freshness. The response contains no
  endpoint, credential, session key/name, cron identity/name/payload, or raw failure detail.
- Current-session and OpenClaw-cron services expose synchronous summary readers over their existing
  process-local validated projections. Heartbeat reads never trigger an extra Gateway RPC. A missing
  projection is `unavailable`; failures, controls, and disconnects preserve prior counts only as
  `last-known-good`, with session truncation and observation/staleness times kept explicit.
- Cron reports the exact global count from the latest unfiltered inventory. Pending synchronization
  is `present` for known unsettled state, `none` only when a complete projection proves absence, and
  otherwise `unknown`; truncated inventory is therefore never presented as a clean global state.
- Contract, service, route, production-composition, authorization, safe-failure, cache-retention,
  disconnect-demotion, truncation, and pending-sync tests cover the slice. Legacy
  `GET /api/cache/heartbeat` remains `planned`: schema-v3 task rows, Dashboard-job rows, and
  payload-bearing cache envelopes are intentionally not claimed by this compact Phase 4 procedure.

### 2026-08-09 — Phase 4A persistent Gateway, sessions, agent availability, and OpenClaw cron

- The installed OpenClaw `2026.7.2-beta.7 (dabe191)` distribution is re-audited through
  hash-pinned source artifacts for the exact persistent protocol, method scopes, session rows and
  controls, cron inventory/runs/delivery patch semantics, native events, and worker notification
  acknowledgement states used by this slice. Legacy Dashboard code remains parity evidence only.
- The web and worker processes each own at most one direct-loopback persistent native Gateway
  transport. Credentials remain process-only `Redacted` values and never enter URLs, browser data,
  SQLite, cache state, or logs. Separate long-lived read/write and fresh single-use admin lanes
  enforce reviewed method allowlists, exact negotiated scopes, request deadlines and cancellation,
  bounded pending work and socket buffering, protocol-v4 frame limits, sequence-gap detection,
  jittered reconnect, terminal-auth handling, and ordered shutdown.
- Native connection, session, and cron changes feed the existing durable realtime outbox through a
  process-owned bridge. Bursts coalesce into snapshot-required markers; disconnect transitions,
  reconnects, and sequence gaps force authoritative refresh; and the existing one-per-tab SSE
  stream remains the browser's only application transport. Last-known-good rows stay visible with
  explicit freshness instead of becoming misleading empty state during disconnects.
- All Gateway profiles advertise the audited `session-scoped-events` capability. Because installed
  `sessions.subscribe({})` still has no changes-only mode and can target unrelated session events,
  the transport retains only bounded payload-free envelopes and forwards only `sessions.changed`
  and `cron` metadata. No raw upstream event payload reaches listeners, SQLite, SSE, browser state,
  cache, or logs. The installed 25 MiB frame and 50 MiB upstream buffer policies bound the residual
  native parse cost; 10-second foreground sessions, agent-status, and cron polling repairs dropped
  targeted markers while a stream remains healthy. Upstream slow-client socket closure triggers
  disconnect and reconnect snapshot-required markers rather than an empty projection.
- `/sessions` now exposes one bounded current projection with main-first ordering, legacy type
  filters, same-snapshot token/kind/model/activity statistics, explicit stale-token display,
  responsive sortable rows, and recently authenticated compact/reset/transcript-delete controls.
  Delete is generation-fenced and protected from pre-mutation refresh races; initial failures,
  background failures, stale state, action conflicts, confirmation focus, and safe retry are kept
  distinct. Long source-valid display metadata is explicitly truncated or omitted with completeness
  markers instead of dropping the snapshot. Dispatched controls with a lost or malformed ACK use
  the shared allowlisted unknown-outcome reason, append a partial audit settlement, stale the last
  known good projection without inventing a deletion, and require refresh before retry. After
  explicit hook, cron, and subagent classification, only the remaining `agent:main:*` family is
  presented as legacy main; other `agent:*` identities remain subagents.
  Gateway session discovery separately enriches only reviewed Dashboard agent IDs with
  `active`, `idle`, `stale`, `disconnected`, or `unknown` availability and never changes the
  Dashboard-owned `working|idle` task state or grants identity/authority.
- The reviewed `/sessions` browser route plus legacy list/statistics, compact/reset, and
  transcript-delete mappings are marked `implemented`. Their greenfield replacement is the single
  validated same-snapshot query and the three explicit generation-/recent-auth-fenced controls;
  this does not claim chat history or the Phase 4 chat runtime.
- `/jobs` now combines the existing Dashboard jobs with a separate OpenClaw cron inventory,
  bounded run history, detail, reviewed `at`/`every`/`cron` schedule and agent/system payload
  editing, write-only delivery destinations, run-now, enable/disable intent, and delete.
  Privileged command/script bodies stay redacted and cannot be round-tripped through the browser.
  Mutations use process-instance and configuration fencing plus authoritative readback. Append-only
  local disable intents record actor, reason, and optional expiry; partial upstream/local outcomes
  remain visible for reconciliation, and a process-owned expiry loop closes intents as `expired`
  only after the external state is reconciled.
- The reviewed `/jobs` browser route and legacy OpenClaw-cron mappings remain `planned`. The
  replacement deliberately narrows edits to source-audited safe definitions and never exposes
  privileged command/script content or readable delivery targets merely to imitate the legacy JSON
  editor; full route parity therefore remains a later explicit gate.
- The worker owns a durable task-notification delivery loop over the same persistent transport.
  `chat.send` is isolated behind a purpose-specific port, uses the durable idempotency key as the
  provider run ID, treats all source-audited already-accepted acknowledgement states as success,
  and releases claimed rows durably before Gateway, coordinator, and database shutdown.
- This starts Phase 4 but does not close it. Chat runs/events/snapshots, bounded history and final
  reconciliation, streaming recovery, attachments/media policy, the virtualized chat frontend,
  plan/companion/background-task controls, and live Gateway smoke evidence remain the next large
  slice. The compact heartbeat also remains intentionally short of legacy schema-v3 parity.

### 2026-08-09 — Phase 4B durable chat, media, companion, and background tasks

- `chat_runs`, append-only `chat_run_events`, compact `chat_runtime_snapshots`, and the durable
  per-session `chat_transcript_generations` pointer now implement
  durable admission before dispatch, cross-actor idempotency conflict detection, strict positive
  provider sequencing, restart watermarks, explicit cancellation races, bounded reconciliation,
  and a 24-hour `unresolved` settlement when an externally dispatched outcome cannot be proven.
  Database triggers reject admission-identity mutation, state-version/counter regression, settled
  provider-identity mutation, snapshot replacement, and projection-watermark regression while
  preserving bounded whole-run cascade retention.
  Terminal retention is bounded and writes its `chat.runtime` snapshot marker in the same
  transaction as pruning.
- Compact, reset, and transcript delete persist a pending generation fence before Gateway
  dispatch. Definite failure and unchanged compact reopen it; changed or ambiguous outcomes remain
  blocked until an exact lifecycle event or strictly newer fresh snapshot advances the generation.
  Process start, reconnect, replacement, and gaps reconcile active work against bounded canonical
  provider truth before preserving it. Prior-generation reads, events, aliases, recovery rows,
  companion asks, and browser cursors are retired rather than projected into the replacement
  transcript.
- Canonical history reads at most two provider pages and 512 KiB; one-message hydration is capped
  at 1 MiB. Runtime catch-up retains every active identity, explicitly marks compacted/truncated
  projections, and never fabricates a local run for provider-origin activity. Local and external
  assistant/thinking bursts share the audited 150 ms invalidation window, while tool, item, plan,
  gap, terminal, and shutdown boundaries flush deterministically. Payload-free `chat.runtime` and
  `chat.history` markers force authoritative snapshots without persisting provider content in the
  realtime outbox. Projection overflow beyond 256 KiB accumulated text, 512 parts, or a 512 KiB
  encoded snapshot degrades detail without rolling back the authoritative journal or blocking
  terminal reconciliation. Canonical history retires only exact provider-origin identities;
  unmatched interrupted rows expire after 15 minutes.
- Send owns the full admit/reserve/dispatch/ACK/settle sequence. Attachment tickets are one-shot,
  actor/session/idempotency bound, limited to ten files and 16 MiB aggregate raw content, and
  converted to base64 only on the private 24 MiB Gateway chat lane. Raw upload and media reads are
  same-origin, capability checked, UUID-addressed, MIME-sniffed, transcript-revalidated, and
  rendered only through the exact preview/download policy; binary content never enters tRPC,
  SQLite, logs, or browser query caches. Serialized send admission is capped at 128 KiB UTF-8,
  each journal event at 256 KiB, and each run journal at 1 MiB. Once dispatch may have happened,
  an unknown outcome consumes the ticket immediately and reconciliation never redispatches it;
  all post-dispatch settlement ignores caller cancellation.
- Companion state remains source-audited session-scoped process memory, while each ask result is
  returned only by its requester RPC. Server admission enforces one ask per session, six per
  process, and four attempts per actor per rolling minute; duplicate resets are single-flight and
  a confirmed reset immediately supersedes an active ask. Provider busy and local capacity become
  a fixed 429, and ambiguous compute acknowledgements use only the allowlisted
  `operation_outcome_unknown` reason.
- OpenClaw background tasks expose bounded prompt-free lists, source-bounded detail, idempotent
  absent cancellation, distinct terminal states, optional source timestamps with chronology checks,
  and payload-free `openclaw.tasks` snapshot markers. Subscription failures are supervised and
  restarted; confirmed or unknown cancellation invalidates the snapshot without leaking task
  payloads through realtime delivery.
- `/chat` consumes the bounded history/runtime/task procedures through an authenticated,
  cross-route browser store, reducer, and one-tab realtime stream. It covers concurrent sends, streaming/thinking/tool
  projections, cancellation and unknown outcomes, hydration placeholders, attachments, model and
  session controls, companion/task panels, reconnect/reset, session switching, unread/follow, and
  responsive desktop/mobile behavior. Live Gateway smoke evidence, restart during a real stream,
  and the aggregate Phase 4 release gate remain open.
- The legacy ElevenLabs STT/TTS paths are replaced in Phase 4 by three registered same-origin raw
  routes: caller-scoped availability plus `chat:write` transcription and synthesis. The optional
  redacted server credential never reaches the browser. Chrome/Firefox Opus WebM/Ogg and Safari
  AAC MP4 (including fragmented `moof` media) are MIME/codec-sniffed and duration-checked before
  transcription; Ogg/WebM timestamps are reconciled against cumulative intrinsic Opus packet
  duration. Ordinary and fragmented AAC MP4 are independently bounded from the AAC-LC access-unit
  count and sample rate, with sample-table/run byte totals reconciled to `mdat`; forged movie,
  media, decode-time, timescale, or per-sample duration metadata therefore cannot bypass the 8
  MiB/120-second cap. Synthesis is capped at 4000
  characters/16 KiB input and 8 MiB MPEG output. Both lanes are abortable, concurrency/deadline
  bounded, no-store, sanitized, and deliberately have no audio/text persistence or logging port.
  Separate identity-bounded rolling per-principal request/work budgets cap paid STT and TTS compute.

### 2026-08-09 — Phase 5 Files, Logs, and interactive Terminal verticals

- Files exposes the writable named `workspace` root selected by
  `MIRA_DASHBOARD_WORKSPACE_ROOT` plus a separate fixed-manifest `openclaw-config` root selected by
  the web-and-worker `MIRA_DASHBOARD_OPENCLAW_ROOT`; host paths never cross the browser contract, and
  production Dashboard state cannot be selected as either root. The OpenClaw root enumerates only
  `openclaw.json` and `hooks/transforms/agentmail.ts` plus their directory prefixes. Sessions,
  credentials, tokens, and every unreviewed sibling remain invisible. `openclaw.json` is parsed and
  redacted inside the descriptor adapter before default ticket metadata or bytes leave it. An
  explicit recent-MFA mutation issues a short-lived actor-bound no-store reveal ticket, keeps raw
  content outside Query caches, and binds any subsequent CAS replacement to that exact revealed
  revision. Invalid JSON remains unavailable through the default redacted read but can still be
  explicitly revealed and repaired. `agentmail.ts` is editable without a secret reveal. Both files
  allow replacement only; the OpenClaw root offers no create, delete, rename, or recursive browse.
  Descriptor-anchored reads
  reject traversal, links, devices, ownership/mode drift, oversized content, and revision drift. Short-lived
  actor-bound tickets carry raw `GET`/`HEAD` previews and downloads plus bounded streamed `PUT`
  uploads. Upload bytes spool beneath protected Dashboard state, while only the worker performs
  descriptor-anchored create/replace, mandatory CAS, fsync, and atomic rename. The worker's separate
  replacement manifest admits only those two OpenClaw paths and enforces per-file size and owner/mode
  checks. Because atomic exchange needs to create a stage file in the target directory, systemd
  cannot express an exact-file writable exception; the descriptor manifest is the enforced write
  boundary for this root. The `/files`
  browser route provides bounded paginated browsing, previews, download, upload, replacement, and
  reconciliation without treating an uncertain response as permission to redispatch.
- Logs exposes a path-free catalog for exact Dashboard files, exact host text logs, and bounded
  dated OpenClaw files. Descriptor reads enforce owner, mode, link, type, size, and partial-read
  checks before centralized secret redaction; stable line identities derive only from redacted
  text. Tail and search remain bounded and browser-session-only. The `/logs` route hides cached
  snapshots after source-availability or read-refresh failures rather than rendering or exporting
  stale lines, and queues only fixed reviewed maintenance policy IDs after recent MFA, durable
  audit, and job admission. The worker periodically probes its managed rotation engine
  and only `LoadState` for the four fixed host units, then atomically publishes a private,
  contract-ordered policy-ID projection under project-local log-maintenance state. The web process
  has no process or rotation-state authority: it reads only that bounded `0600` projection and
  accepts it while its worker timestamp is fresh. For `docker-managed`, the worker validates the
  protected maintenance-state root and any existing bounded state file; an absent state file is
  accepted as first-run state. Invalid managed state, stale or corrupt projections, missing or
  unloaded host units, aborted checks, and unconfigured policies fail closed as unavailable.
  Orderly worker shutdown first publishes an empty projection. The resulting Jobs run is
  authoritative for execution outcome.
- Log maintenance deliberately has two owners. Dashboard's worker implements size/cadence,
  copy-truncate or reviewed rename, compression, retention, archive-only cleanup, atomic state,
  locking, status, and dry-run mechanics for the exact reviewed Dashboard, OpenClaw, and
  application/container manifest. Ubuntu's system logrotate remains responsible only for the
  exact `rsyslog`, `apport`, `dpkg`, and `alternatives` policies through a separately provisioned
  fixed broker. The provisioning artifacts are immutable release inventory, but no host policy is
  installed or activated by this implementation change.
- Terminal is a real xterm-compatible interactive PTY rather than persisted command-job emulation.
  A worker-private Unix broker owns `Bun.Terminal` and a resource-bounded transient systemd
  service; the web process owns only recent-MFA/session/capability admission and the same-origin
  WebSocket relay. Input/output are raw bounded bytes with FIFO backpressure, resize/signals,
  bounded reconnect replay, auth-lease renewal, and deterministic detach/terminate/shutdown.
  Terminal content and keystrokes are never logged or persisted. Its named `workspace` root is
  only the shell's initial working location: an interactive shell may leave it wherever its OS
  identity has access, so it is explicitly not a filesystem sandbox.
- At this checkpoint `/opt/docker` remained the separate Docker-stack project and source of truth,
  while the reviewed inventory/update/action adapters had not yet landed. Dashboard did not absorb
  compose files, application data, or stack deployment ownership. Files, Logs, and Terminal contracts,
  schemas, raw routes, browser routes, and reviewed legacy mappings are now represented in the
  deterministic generated documentation/parity artifacts. `/terminal` records the explicitly
  reviewed PTY replacement as implemented; `/files`, `/logs`, and legacy rotation-status parity
  remain planned until their outstanding full-parity behavior and real runtime status exist. The
  other Phase 5 domains and the aggregate privileged-operation exit gate remain open.

### 2026-08-10 — Phase 5 Logs parity closed

- Maintenance status now reads the five exact real-run payloads plus managed dry-run activity
  through one bounded repository snapshot. Each policy exposes a running-preferred active run
  separately from its latest terminal real run, while successful managed results project only
  bounded path-free aggregate counts. Dry-run jobs remain independently observable and do not
  replace the policy's real-run history.
- `docker-managed` dry runs use the same durable recent-MFA, audit, admission, worker execution,
  and settlement path as real maintenance. Host dry runs fail closed before invoking the fixed
  system broker. Unknown worker result content never crosses the contract boundary.
- The `/logs` browser keeps maintenance controls available even with no configured read sources,
  locks all policies while the shared `host.logs` resource is active, follows the requested run
  through realtime invalidation with a bounded polling fallback, and renders only the validated
  terminal summary. Failed detail reads recover without leaving the controls permanently locked.
- Credential redaction consumes complete scalar, structured, malformed, authorization, and cookie
  values before search matching. Search inspects at most 4,000 newest physical lines per request,
  and line identities use framed, redacted generation tuples. Managed copy-truncate publishes a
  source-specific `rotating` marker before truncation and commits the pending epoch only after file
  sync; a fresh worker instance safely completes interrupted pre-truncate, empty, and below-threshold
  regrowth cases while web reads remain fail-closed. Queued maintenance audit rows retain only the
  public policy target, request identity, and classified settlement metadata.
- The reviewed `/logs` route plus legacy maintenance status, managed dry-run, and real-run
  operations were recorded as implemented. Docker control, database, Moltbook, settings, GitHub,
  delivery, backup, and the aggregate Phase 5 exit gate remained open at this checkpoint.

### 2026-08-10 — Phase 5 Files boundary reviewed

- The existing reviewed Files surface covers both the named workspace and the fixed-manifest
  OpenClaw configuration root. `files.listRoots` discovers those reviewed named roots, and
  `files.list` lists the selected opaque root or directory for both legacy list inventories. The
  actor-bound content and upload tickets carry both workspace and configuration reads and writes
  through the registered `GET /api/files/content/:ticketId` and
  `PUT /api/files/uploads/:ticketId` raw routes.
- The reviewed `/files` browser route, both legacy workspace rows, and both legacy write rows are
  recorded as implemented. The two legacy configuration GET rows remain planned because legacy
  lists files of any size and returns a bounded prefix for oversized files, while the reviewed
  greenfield manifest rejects source content above 2 MiB before list/read admission. Browser
  evidence walks the synthetic
  `hooks/transforms/agentmail.ts` manifest directories and keeps an invalid masked
  `openclaw.json` selectable when its default preview fails closed; an enrolled, recent-MFA reveal
  can inspect and repair that exact revision because the actor-bound reveal is validated before the
  raw descriptor view used by write preparation. The reviewed full-redaction/replacement allowance
  is 2 MiB, while text preview remains 1 MiB and larger admitted text stays download-only. Successful
  replacements retain the immediate predecessor as one exact hidden `.bak`; worker recovery
  completes target and backup publication idempotently without exposing the backup through Files.
  Replacement-only OpenClaw targets must already exist at cutover, because neither the web nor
  worker Files boundary may create a missing manifest file. The separate OpenClaw media inventory at
  `GET /api/media` remains planned, as do the remaining Phase 5 domains and aggregate exit gate.

### 2026-08-11 — Phase 5 Moltbook parity closed

- The worker is the only process that receives the redacted `MOLTBOOK_API_KEY`. It performs four
  concurrent requests against the fixed `https://www.moltbook.com/api/v1` origin with redirects
  forbidden, bounded streamed JSON bodies, a caller-composed timeout, and strict normalization
  that discards provider fields not rendered by the Dashboard.
- One immediate 30-minute durable job commits the home, hot/new feeds, profile, posts, and comments
  as one claim-fenced `moltbook.dashboard` snapshot. Failed attempts preserve the prior aggregate
  and persist only a fixed operator-safe failure; readers expose stale last-known-good state
  explicitly without exposing credentials, response bodies, or raw provider failures.
- The session-only `moltbook.home`, `moltbook.feed`, `moltbook.profile`, and
  `moltbook.listMyPosts` procedures require `cache:read`. The `/moltbook` browser retains the
  reviewed Feed/Posts/Comments and Hot/New workflows, loading/error/retry and empty states, and
  uses only encoded fixed-origin external links. The four legacy endpoint rows and reviewed route
  are now recorded as implemented. The aggregate Phase 5 exit remains open.
- The production route and its validation contracts remain lazy. Against the parent Files slice,
  Moltbook adds 2,202 gzip bytes to the initial graph and 8,485 gzip bytes across all JavaScript;
  the enforced limits advance by only 3 KiB and 10 KiB respectively, while the largest-chunk and
  stylesheet limits remain unchanged.

### 2026-08-11 — Jobs and OpenClaw cron parity closed

- The reviewed `/jobs` route and all fourteen legacy Jobs/Cron mappings are now recorded as
  implemented. The existing typed `jobs.*`, `schedules.*`, and `openClawCron.*` procedures are the
  parity replacement for Dashboard schedules, durable execution state, and OpenClaw cron inventory
  and controls; this evidence-only closure adds no runtime behavior.
- The replacement intentionally does not restore the legacy arbitrary JSON round-trip. Privileged
  command and script bodies remain redacted and non-editable, delivery destinations remain
  write-only, and OpenClaw cron updates accept only the reviewed typed fields. This secure narrowing
  is the accepted parity behavior rather than an open route gap.

### 2026-08-11 — Realtime transport parity closed

- The legacy browser live-update row `WebSocket /ws` is now recorded as implemented by the existing
  `events.stream` procedure. This evidence-only closure adds no runtime, browser, configuration, or
  generated-contract behavior.
- Behavioral parity intentionally narrows the transport: live updates use one-way typed tracked SSE,
  while queries and actions use typed tRPC procedures. Arbitrary browser-to-Gateway WebSocket method
  forwarding is not restored.
- The existing stream enforces topic authorization, renewable and revocable authorization leases,
  bounded buffering, durable replay, and schema validation.

### 2026-08-11 — Heartbeat operational summary advanced to schema v4

- `cache.getHeartbeat` schema v4 retains bounded payload-free cache, Gateway, task, and
  Dashboard-job projections and adds an owned fresh-only OpenClaw-cron inventory refresh. The
  refresh is process-single-flighted, has an eight-second aggregate deadline, 60-second success
  TTL, ten-second failure retry gate, one bounded revision-race retry, and a 1000-row inspection
  ceiling. Pages are read sequentially under a 32 MiB cumulative authenticated response-frame
  admission budget and reduced immediately to heartbeat-only fields. Exact encoded bytes are
  captured before provider projection can strip unknown fields; one bounded overflow page may
  arrive, then the walk stops without retry. Public browser list reads no longer mutate heartbeat
  state.
- All cron pages must have one snapshot revision and total, exact offsets, complete page lengths,
  and globally unique IDs before anything commits. A failed, raced, duplicate, incomplete, or
  timed-out candidate preserves the whole previous projection as last-known-good. Mutations
  invalidate the success TTL immediately; ordered server shutdown aborts and awaits any owned
  refresh.
- Identity-free aggregate health now distinguishes enabled/disabled, intentional/unexpected
  disablement, running/potentially stuck, last-run failures, synchronization conflicts versus
  pending reconciliation, and truncation. Automation-linked tasks receive `present`, `missing`, or
  `unavailable` cron health;
  `missing` requires fresh complete authority. The internal task-to-cron ID map never serializes,
  and the task SQLite transaction closes before Gateway I/O.
- Contract consistency accepts future `nextRunAtMs`, clamps only historical observations, and
  forbids stale/truncated global state from asserting an unjustified missing linked cron. Focused
  coverage locks cold refresh, TTL/backoff, single-flight/disposal, mutation invalidation,
  0/100/101/1000/>1000 rows, sequential pagination, cumulative byte overflow, pagination defects,
  whole-snapshot LKG, task correlation, and no-identity serialization.
- This work does **not** claim that the legacy `GET /api/cache/heartbeat` schema-v3 contract is
  replaced. Legacy still carries payload-bearing cache diagnostics and identifiable task,
  Dashboard-job, and per-cron rows. Its parity entry is returned to `planned` until those
  diagnostic capabilities and the repo-external consumer migration are preserved without loss.

### 2026-08-11 — Authenticated health diagnostics parity closed

- `system.healthDiagnostics` now returns one strict session-only, identity-free snapshot of live
  application readiness, database access, immutable frontend/release verification, an online
  worker from the exact serving release, sanitized Gateway state, cached session-count freshness,
  and bounded queue aggregates. Anonymous callers are unauthorized and automation principals are
  forbidden before any dependency read.
- One dedicated deferred-transaction repository read counts only queued/running jobs and computes
  constant-size aggregates across every fresh worker. It therefore neither groups retained
  terminal history nor inherits the Jobs UI's 32-worker response cap. Database, Gateway, session,
  and queue failures remain explicit unavailable data without leaking identities or raw errors.
- Database, frontend, verified release, application state, and exact-release worker gate the
  diagnostic status. Gateway degradation, stale session data, and claim pause remain visible but
  do not alter the public readiness probe. The authenticated header now uses this single query
  instead of separate readiness, Gateway, and Jobs requests; background failures retain the last
  validated rows with an explicit stale marker instead of leaving an old green state current.
- The legacy `GET /api/health/diagnostics` row is recorded as implemented by this secure
  replacement. The legacy route's wider application counters remain part of the separately planned
  `GET /api/metrics` capability and are not claimed by this slice.

### 2026-08-11 — OpenClaw settings and skills parity advanced

- The authenticated `/settings` route now combines the existing Dashboard account-security
  surface with an OpenClaw tab whose URL-owned `view=dashboard|openclaw` search state is normalized
  deterministically. Configuration and skill queries fail independently, retain explicit
  unavailable/invalid states, and never place raw configuration or recoverable secrets in the
  browser or Query cache.
- `openClawSettings.getConfiguration` returns a bounded, redacted projection plus separate provider
  root-hash and source-revision identities. Include presence and whole-candidate model-normalization
  state are projected as locks without exposing source paths, raw configuration, or environment
  values.
  Updates are strict section-specific operations for models, session reset, heartbeat, tools, and
  configured channels, plus one exact agent/tool override intent against canonical
  `agents.entries`. The server reconstructs a narrow patch after a revision preflight, preserves
  masked and unknown values server-side, fences `config.patch` atomically with the observed root
  hash, and does not retry an unknown outcome. Include-owned sources or a pending/unknown
  normalization state keep configuration reads available but lock writes. Agent access exposes only
  a fixed pinned core-tool subset and marks omitted or noncanonical rows explicitly incomplete.
  Skill inventory is path-free and bounded, retains safe configured-only entries, and toggles
  accept only one validated skill identity and desired enabled state against the reviewed snapshot.
- Reads require an authenticated browser session and the dedicated
  `openclaw-settings:read` capability. Configuration and skill writes require
  `openclaw-settings:write`, a recent MFA assertion revalidated immediately before dispatch, an
  admitted fail-closed audit record, and a sanitized terminal settlement. Automation principals
  cannot use these browser-only procedures even if a capability row is provisioned. A bounded
  sixteen-operation active-plus-waiting FIFO serializes privileged Settings mutations and removes
  aborted waiters immediately.
- The Gateway adapter exposes source-audited `config.get` and `skills.status` on its read set and
  only `config.patch` plus `skills.update` on its fresh one-shot admin write set. Configuration
  patches use the upstream root-hash CAS after an exact revision preflight. Skill toggles use one
  exact `skills.update` leaf on the latest configuration and are explicitly last-writer-wins rather
  than hash-fenced; uncertain outcomes receive one readback and are never replayed. The adapter does
  not broaden the generic persistent request API or permit arbitrary method forwarding. Reads use
  bounded authenticated frames; writes reauthorize after the handshake immediately before
  dispatch and make post-dispatch uncertainty explicit.
- Four legacy configuration/skill rows and the `/settings` route are recorded as implemented. The
  unused legacy Dashboard preference pair is recorded as a reviewed removal instead of restoring
  host-home JSON persistence with no current consumer. The secret-bearing configuration export and
  Gateway restart rows remain planned for separate raw-ticket and durable worker-job slices. The
  reviewed inventory now records 103 implemented, 52 planned, and two removed legacy endpoints;
  12 browser routes are implemented and four remain planned. Phase 5 remains open.
- The lazy settings route and its bounded forms measured 900,607 aggregate JavaScript gzip bytes
  identically across three frozen-tree production browser builds. The reviewed aggregate
  completion ceiling moved from 865 KiB to 1,280 KiB because, at this checkpoint, 52 endpoint
  replacements and the `/`, `/database`, `/delivery`, and `/docker` browser routes remained. This left
  410,113 bytes for those reviewed slices without deleting parity behavior. The tighter
  initial-JavaScript, largest-chunk, and stylesheet ceilings remain unchanged so startup and
  per-route regressions still fail independently.

### 2026-08-12 — OpenClaw configuration-file and operations parity closed

- The fixed OpenClaw Files manifest now lists reviewed sources above the 2 MiB replacement ceiling
  without granting write authority. It exposes only a revision-stable prefix of at most 1 MiB,
  marks the result explicitly truncated and read-only, and keeps oversized masked configuration
  fail-closed until a recent-MFA reveal. Exact replacement remains capped at 2 MiB.
- `openClawSettings.createConfigurationBackup` issues a short-lived, capacity-bounded ticket for
  the exact descriptor-anchored `openclaw.json` bytes. The session- and authenticator-bound raw
  `GET`/`HEAD` route is same-origin, recent-MFA protected, private/no-store, single-use on `GET`,
  and bounded by stored-secret and in-flight-download admission. Expiry, consumption, cancellation,
  and process shutdown erase retained byte buffers. Ownership is explicit at each copy boundary:
  the descriptor result, service source, consumed store buffer, and stream buffer are independently
  zeroed on all success, failure, abort, and disposal paths. Raw configuration never enters tRPC results,
  Query cache, audit, logs, provider errors, or durable job records.
- `openClawSettings.restartGateway` admits one caller-idempotent, exclusive durable
  `openclaw.gateway.restart` run after fail-closed audit and a dispatch-time authorization check.
  The worker executes one fixed no-shell command with ignored output, one attempt, no cancellation,
  and no automatic retry. Enqueue uncertainty is reconciled through the caller's idempotency key;
  terminal uncertainty is never treated as permission for a second restart.
- Production-composition tests cover the reviewed root through ticket issuance and one-shot raw
  delivery, plus tRPC enqueue through a real SQLite run, worker settlement, persisted result, and
  idempotent replay. The two legacy configuration-file reads and the configuration-export/restart
  rows are now implemented. At this checkpoint the inventory was **107 implemented, 48 planned, and two
  reviewed removals** out of 157 legacy endpoints; browser routes remain 12 implemented and four
  planned. `GET /api/media` still remained planned at this checkpoint; this operations slice does
  not claim database backup/restore parity.

### 2026-08-12 — OpenClaw local-history media parity closed

- Hash-pinned OpenClaw source evidence now covers the canonical `__openclaw.media` carrier and the
  reviewed legacy path, URL, type, and `MEDIA:` compatibility forms. History projection accepts
  only bounded local-file candidates beneath the explicit OpenClaw media root, strips recognized
  `MEDIA:` directives even when a candidate is rejected, and emits only ordinary attachment parts
  containing opaque non-path identifiers.
- The existing `GET`/`HEAD /api/chat/media/:attachmentId` boundary now serves both managed outgoing
  media and local-history media. A local reference is bound to its exact session, message, source
  slot, and normalized server-only locator. Each request authenticates `chat:read`, reprojects the
  exact transcript message and attachment URL, and only then opens the descriptor-rooted source;
  knowledge of either a host path or an attachment identifier is never sufficient for access.
- Local traversal is fixed beneath `<MIRA_DASHBOARD_OPENCLAW_ROOT>/media` and rejects traversal,
  links, hardlinks, special files, cross-device nodes, unsafe ownership or modes, and unstable file
  identity. Reads remain capped at 16 MiB, bounded text previews at 1 MiB, and active or unknown
  content stays download-only. No media inventory, host path, path-query API, or additional browser
  route is introduced.
- The secure narrowing implements the legacy `GET /api/media` behavior through the existing Chat
  raw route. At this checkpoint the inventory was **108 implemented, 47 planned, and two reviewed
  removals** out of 157; browser routes remained **12 implemented and four planned**. Phase 4 live
  Gateway smoke/restart evidence and the remaining Phase 5 domains still kept their aggregate exit
  gates open.

### 2026-08-12 — Purpose-built Service Actions narrow consumed exec authority

- The Overview now exposes exactly six fixed Service Actions through session-only
  `serviceActions.getStatus` and recent-MFA `serviceActions.request`: OpenClaw cleanup, OpenClaw
  restart, OpenClaw update, system cleanup, host restart, and host update. Requests carry a caller-owned idempotency
  key, commit a fail-closed attempted audit record, recheck fresh exact-release worker availability,
  and revalidate session and recent MFA at durable enqueue. The browser receives only a durable run
  ID and follows progress through `/jobs`; no stdout, command, environment, or provider response
  crosses the contract.
- `/jobs` always renders the complete fixed six-action inventory, including actions with no prior
  run, alongside Dashboard and OpenClaw cron jobs. Each observed run ID links to that exact run
  detail instead of implying that only Overview owns the history.
- OpenClaw cleanup and update are implemented as exact worker-only, hash-pinned
  `sessions.cleanup` and `update.run` calls. Cleanup uses OpenClaw's own bounded maintenance policy
  instead of reintroducing legacy recursive deletion, and update preserves the managed handoff.
  Both actions are single-attempt, non-retry-safe, non-cancellable, resource-locked jobs with
  sanitized results and explicit unknown-outcome handling.
- OpenClaw restart reuses the fixed `openclaw.gateway.restart` definition, executor, and provider
  already used by Settings; its shared `host.mutation` and `openclaw.gateway` resource locks
  serialize it with host maintenance and Gateway operations. Service Actions add no second
  lifecycle command and preserve the Settings restart surface.
- System cleanup is defined as an exclusive, single-attempt fixed host operation. It attempts package
  autoremove/cache cleanup, journald rotation with 14-day/1 GiB retention, and unused Docker content
  pruning only after 168 hours, never volumes. Host cleanup, restart, and update use an exact
  `/usr/bin/systemctl` broker and root-owned fixed units with bounded deadlines and output. The
  release ships manifest-verified provisioning and rollback artifacts, but production reports the
  host rows `unavailable`. Because web and worker currently share one Unix identity, activation
  first requires a distinct worker OS principal; only then may separately approved root
  provisioning bind that principal, exclude the web process, reload the reviewed units and policy,
  and compose the broker.
- Host restart additionally has a durable database-global admission fence. The exact restart
  claim may arm it only when no other run is globally running; every worker then blocks new claims.
  Acceptance and every ambiguous broker rejection, abort, timeout, or lost response retain it
  because `systemctl --no-block` may already have accepted the reboot timer. A changed Linux boot
  identity reconciles it, and bounded same-boot expiry recovers when no reboot occurs. This does
  not reuse operator pause.
- The interactive PTY already owns shell `cd`, completion, and bounded termination. Legacy
  long-running exec consumers map to either that PTY or the purpose-built durable Service Actions
  queue. The unused synchronous `POST /api/exec` route is a reviewed removal with no current
  browser or scoped automation consumer; no generic shell/command replacement was added.
  The bounded PTY plus fixed `system-cleanup` foundation preserve the narrow replacement for all
  three consumed cleanup effects without restoring their unsafe shared shell boundary. Because
  the host executor remains unavailable in production, `POST /api/exec/start` stays planned until
  the distinct-worker topology and separately approved root provisioning are complete.
- At this checkpoint the living inventory was **113 implemented, 41 planned, and three reviewed
  removals** out of 157 legacy endpoints. Browser routes were **13 implemented and three planned**.
  This advanced Phase 5 without claiming complete exec, host-operation, Docker/delivery or database
  backup/restore parity, or the
  aggregate Phase 5 exit gate.

### 2026-08-12 — Database observability vertical implemented; production credential cutover open

- Legacy evidence identifies one read-only `GET /api/database/overview` consumer and the stable
  session route `/database`. The reviewed replacement is `database.overview`: live bounded
  Dashboard-SQLite lifecycle facts composed with a worker-owned last-known-good
  PostgreSQL/PgBouncer projection. The page retains the source picker, responsive summaries and
  tables, maintenance assessment, freshness, stale-data warning, and explicit unavailable state.
- This review does not grant arbitrary SQL, Docker/exec, backup, restore, vacuum, or maintenance
  authority. Credentials, connection strings, host/container paths, provider output, raw errors,
  and query literals do not cross the contract. The six Kopia/WAL-G status/control rows and later
  database backup/restore remain separate planned privileged work.
- The slice established the permanent dynamic-topology invariant now shared by database and Docker
  observability. Database names are discovered from the live bounded PostgreSQL catalog; Docker
  containers and Compose identity are discovered from bounded Docker Engine inventory and inspect
  metadata. Endpoint credentials and approved roots constrain authority but never become
  operator-maintained topology lists. Additions, removals, and renames reconcile without a
  Dashboard release or manual source/configuration/manifest edits.
- The implemented Docker updater reuses the deployed `mira.updater.*` Compose labels. Inventory
  does not depend on those labels; they are an explicit mutation-policy capability, and only valid
  opt-in makes a dynamically discovered service mutable.
- Docker delivery ownership is fixed: `/opt/docker/compose.yaml` is the
  canonical root/include graph and `/opt/docker/bin/docker-compose-doppler` is the sole Compose
  mutation executor. Root and app-local `.env` files stay opaque; no secret-bearing environment or
  resolved Compose output may enter Dashboard state, logs, audit records, or browser payloads.
- Per-container update labels and image ownership remain in each included app Compose file. The
  updater derives that exact file/field through the root include graph, compare-and-swap replaces
  only the image-scalar byte range while preserving every other byte, validates the whole root
  project, and fails closed on concurrent or ambiguous ownership rather than maintaining or
  guessing a filename map.
- Delivery provisions a dedicated PostgreSQL/PgBouncer observer with zero role memberships and an
  isolated `NOLOGIN` capability owner with exactly direct `pg_read_all_stats` membership plus
  direct per-database `SELECT` on `pg_catalog.pg_statistic`. The observer receives only direct
  `CONNECT`, capability-schema `USAGE`, and `EXECUTE` on exact no-input, bounded
  `connection_metrics()`, identity-free `statement_metrics()`, `table_health()`, and
  `maintenance_metrics()` functions. Raw `pg_stat_statements` source views and extension routines
  are revoked from `PUBLIC` and the observer; statement output contains no query text, `queryid`,
  database identity, or user identity. Full convergence is part of a separate privileged
  collection-lease port invoked only by the existing hourly
  `cache.refresh.database-observability` job and only when the provider is configured. The
  observer is `NOLOGIN`, expired, and has zero PostgreSQL sessions between attempts. Each attempt
  closes leftovers; prepares a one-use token only after exact approval/identity verification and
  full reconcile; rechecks the exact catalog digest and atomically consumes that token while
  enabling `LOGIN` with a short `VALID UNTIL`; collects once; and runs
  a shielded mandatory close that restores and proves the exact closed state. Only after that proof
  can the port return a payload to the generic cache executor for commit. The observer and
  collector never receive mutation authority. Explicit activation alone creates or refreshes an
  approval marker bound to the PostgreSQL `system_identifier` and the exact current and previous
  immutable-release policy digests; the policy version alone is not authorization, and lease
  operations cannot mutate the approval. Every approved open performs and verifies the complete
  bounded, idempotent ACL-and-capability reconcile before one-use enable; no persisted
  fingerprint, verification-age state, or reduced path is used. A newly created database is
  reconciled before the next approved collection. Any open, collection, or close failure retains last-known-good, prevents a fresh
  cache commit, and settles as a retryable redacted failure. PostgreSQL close cannot prove the
  absence of already-authenticated PgBouncer waiting clients; no exclusive admission is added,
  interference fails the attempt, and the closed role prevents a new backend. No second action,
  schedule, polling loop, sidecar, systemd unit, or PostgreSQL login is added. Generic
  verification also rejects unrelated direct/inherited observer routine grants and effective
  user-schema `SECURITY DEFINER` execution without rejecting ordinary `PUBLIC` invoker routines.
  The optional, count-only Comet/Bitmagnet torrent views and cards are the sole named
  application exception; they never define the general database set, and their absence makes only
  the matching card unavailable. Legacy raw query text/copy is a reviewed security narrowing;
  ranked aggregate statement metrics remain available without literals or reversible query
  identity.
- Production enablement remains intentionally open until the Docker source of truth carries the
  single `mira.dashboard.database-observability=pgbouncer-v1` capability label, its code-owned
  `mira_dashboard_observability` control alias, the existing hourly job's privileged
  collection-lease port, and the migrated credential
  boundary. Approved provisioning creates a dedicated same-named physical database from
  `template0`, and PgBouncer's existing wildcard route reaches it without an explicit mapping,
  stack database environment lookup, database-name label, or Dashboard setting. The fixed control
  database remains code-owned while application inventory remains catalog-derived. The worker
  must receive a distinct
  `MIRA_DASHBOARD_DATABASE_OBSERVABILITY_PASSWORD` from Doppler, never the existing
  `DATABASE_USERNAME`/`DATABASE_PASSWORD` pair or legacy `postgres/postgres` fallback. The current
  private Docker repository still tracks `apps/pgbouncer/userlist.txt`; its SCRAM verifier is not
  cleartext but remains credential material. Before the rewrite is declared complete, replace it
  with a runtime-generated or equivalently secret-mounted, non-versioned auth input, restrict its
  readability, rotate the affected credential so Git history is obsolete, and pass rollback-safe
  PgBouncer/Dashboard smoke checks without printing resolved Compose or secret values. No current
  production credential is changed by this implementation slice.
- The approval-gated provisioning runner is release-self-contained. It pins the local Docker
  socket and root Compose project, resolves the one healthy PostgreSQL dependency, and uses
  container-local psql through a fixed `env -i` launcher over the local Unix socket. Each bounded
  stdin pass verifies the probed superuser role OID and PostgreSQL system identity. The documented
  entrypoint selects exact current-release and production-Bun pointers; host psql and ambient
  `PG*` endpoint configuration are outside the authority boundary.
- Bookkeeping is now **113 implemented, 41 planned, and three reviewed removals**; browser routes
  are **13 implemented and three planned**. `database.overview` and `/database` are implemented
  because the contract, worker provider, database-runtime read port, production composition,
  browser route, and acceptance evidence land together.
- SQLite lifecycle evidence now composes the bounded scheduled-maintenance namespace with the
  immutable activation/cutover namespace. Only `scheduled` and `cutover` are canonical kinds.
  The activation snapshot securely consolidates the recovery purpose of legacy pre-deploy and
  pre-migration copies; no old artifact kind is claimed or imported. Scheduled publication now
  requires a separate temporary restore copy to pass `quick_check` and verified migrations, and
  the exclusive job reconciles bounded crash-left stage/verification/retire directories before
  work. Scheduled retention is capped at fourteen. Every committed/recovered/same-candidate
  activation enforces cutover retention at five snapshots and two days of unreferenced age while
  preserving current, previous, and active-journal transition IDs. Both namespaces atomically
  rename selected artifacts to `.retire-*`, fsync the parent, and resume descriptor-anchored
  reaping with final inode revalidation after interruption; published immutable snapshots are
  never mutated in place.
- Production activation now applies the same bounded-lifecycle invariant to the code and runtime
  roots. It preserves only the authoritative current/rollback release-runtime pairs and the
  candidate during admission, verifies the complete bounded inventory before mutation, and then
  atomically retires and reaps every unreferenced manifest-verified release and revision-probed Bun
  runtime. Crash-left stage/retire trees reconcile on the next pass; unknown entries, pointer drift,
  invalid trees, or path replacement fail closed before authoritative artifacts are removed.
  Admission now recovers any active journal and completes that verified pruning before measuring
  conservatively rounded destination allocation blocks, directory metadata, and inode demand while
  preserving a 64 MiB byte reserve and 64 free inodes. Copied files and directories are fsynced
  bottom-up, and the parent of each immutable stage rename is fsynced before publication returns.
  Failed install/publication attempts repeat the pass under the same lease, while a later attempt
  reaps crash-left candidates before admitting another copy.
  Linux has no inode-conditional unlink, so physical reclamation relies on the exact deployment
  lease serializing every authorized mutation by the trusted application UID. The race checks cover
  accidental/stale drift, not a malicious concurrent same-UID process that can already rewrite the
  application-owned namespace; the planned root-owned immutable handoff and different-principal GC
  are required to change that threat boundary.

### 2026-08-13 — Docker parity vertical implemented

- All eighteen reviewed legacy Docker rows are settled: fifteen behaviors map to the strict
  `docker.overview`, `docker.getContainerLogs`, `docker.preparePrune`, and
  `docker.requestOperation` procedures. The three actively consumed Docker-console
  start/status/stop routes use an exact-container handoff into the existing bounded Terminal
  lifecycle instead of a second generic exec surface. `/docker` is implemented. The handoff accepts
  only a validated full container ID and sends one fixed interactive `/bin/sh` command after
  recent-MFA Terminal admission; no caller can supply a command, shell, working directory,
  environment, Compose path, executable, or arbitrary argument through the Docker API.
- Every scheduled one-minute or operator-requested overview refresh re-enumerates the bounded Docker Engine inventory and projected
  inspect data, then joins observed Compose project/service/config identity against the canonical
  recursive include graph rooted at `/opt/docker/compose.yaml`. Container, service, project, image,
  and volume additions/removals/renames therefore reconcile without a Dashboard name list. The
  fixed `/opt/docker` trust root is an authority boundary, not inventory membership, and a
  source-wide failure retains the validated snapshot as explicit last-known-good for at most 24
  hours instead of publishing a fresh empty stack.
- The deployed `mira.updater.enabled`, `mira.updater.autoUpdate`, `mira.updater.track`,
  `mira.updater.tagPattern`, and `mira.updater.tagPatternIsRegex` labels are policy only. Supported
  list/map forms normalize into one policy; missing, disabled, invalid, or ambiguous policy leaves
  the discovered service inventory-only. The worker re-resolves the one canonical included app
  Compose file that owns the service and labels before every edit.
- Image mutation uses source/hash compare-and-swap and replaces only the exact admitted image-scalar
  byte range. Indentation, spacing, comments, quoting, line endings, and every unrelated byte remain
  unchanged. The complete root project is validated before the sole admitted Compose executor,
  `/opt/docker/bin/docker-compose-doppler`, applies the resolved service from `/opt/docker`; root and
  app-local `.env` files and resolved secret-bearing Compose output remain opaque. Rollback retains
  the exact pre-update running image ID, rebinds a mutable old tag to that ID, recreates without a
  pull, and verifies both restored source and runtime identity before it can report success.
- The existing worker process owns fixed container and whole-stack lifecycle operations, exact
  unused image/volume deletion, preview-bound prune execution, registry scans, automatic/manual
  updates, and exact-service updates as durable recent-MFA, audit-first, source-revision-fenced Jobs.
  It also owns the protected `0600` Unix broker inside the existing `0700` state directory for only
  bounded redacted log tails and prune previews. No new daemon, systemd unit, timer, schedule, or
  generic exec authority is added.
- The daily 04:10 Europe/Oslo updater and manual updater jobs retain the bounded newest service/event
  projection in `docker.overview`, publish material update-available, succeeded, failed,
  discovery/source-sync, and unknown-outcome transitions into global notifications, and expose each
  durable run through Jobs. Every successful projection retries the bounded event window through
  idempotent notification upsert, while the Jobs run and queued run event remain the sole durable
  queue status rather than a duplicate Docker `update-queued` event. Exact-path Git sync stages only the changed per-app Compose files,
  verifies repository HEAD and before/after blobs, creates the fixed automation commit, pushes the
  configured `github.com` upstream, and preserves committed-push-pending or unknown settlement rather than
  replaying or reporting false success.
  Authenticated registry reads use the optional worker-only Docker Hub and GitHub pairs; the GitHub
  pair also performs an authenticated remote read and dry-run push before Compose changes. Git
  ignores ambient global/system configuration and host credential stores.
- Docker adds no domain-specific service or event tables. Snapshot and updater history use
  `cache_entries`; execution uses `job_runs`/`job_run_events`; security history uses `audit_events`;
  and user-visible transitions use `notifications`. The `/docker` browser now covers
  freshness/LKG, summaries and live stats, stack/container controls, bounded logs, updater
  policy/status/history and checks, exact updates, images, volumes, exact deletion, actor-bound
  prune previews, stale-source rejection, durable run links, and the existing bounded Terminal as
  the interactive operator-console replacement.
- The living parity inventory is now **131 implemented, 23 planned, and three reviewed removals** out
  of 157 legacy endpoints. Browser routes are **14 implemented and two planned**. Docker parity is
  closed in the greenfield implementation; production activation and live `/opt/docker` changes
  remain separate, explicit operator actions.

### 2026-08-13 — Delivery parity vertical implemented

- All fourteen reviewed Delivery rows are implemented as five bounded reads and nine recent-MFA,
  durable mutations. `/delivery` presents ordinary, inferred, native-stacked, and read-only PR
  groups; authoritative CI/review/blocking state; one global preview slot; sanitized production
  checkout; immutable current/previous releases; deploy/paired rollback; and the ten newest exact
  Delivery Job runs. Every accepted mutation returns its durable `/jobs` run rather than claiming
  that the external operation already succeeded.
- Pull requests, preview, checkout, and release state use four independent cache rows with separate
  refresh, freshness, last-known-good, and source-revision fences. A GitHub, preview-host, checkout,
  or activation failure therefore cannot publish a fresh empty sibling projection or hide the
  other three panels. Production history is an indexed projection of
  `delivery.production.v1` rows in `job_runs`; timelines remain in `job_run_events` and security
  admission in `audit_events`. No `deployments`, `deployment_events`, `release_records`, second
  queue, or parallel history store is added.
- GitHub authority is worker-only and split by identity. The verified `mira-2026` credential owns
  every bounded read, provider-guarded ordinary merge/update, exact-main Git synchronization,
  preview, and production workflow. The separately verified `rajohan` credential owns review
  approval only.
  Missing Raymond authority disables only approval and never falls back to Mira, anonymous access,
  `gh`, ambient GitHub variables, global Git configuration, or a host credential store. Job
  payloads, cache rows, logs, receipts, and browser responses contain neither token.
- Normal, inferred, and native stack inventory, grouping, preview, and review bind and revalidate
  the complete ordered number/head scope. Ordinary merge/update/review use provider-enforced head
  guards. Native stack create/merge and pull-request close remain explicit fail-closed procedures
  with `head-guard-unavailable` because GitHub exposes no atomic full-prefix/membership or close-head
  CAS; no provider request is dispatched. Stale membership, author, CI, review, checkout, preview,
  release, snapshot, or activation state fails closed. Confirmed partial effects and uncertain
  provider settlement remain truthful partial/unknown outcomes and are never blindly replayed.
- The exact admitted PR/stack heads run in one four-hour managed preview slot under a transient
  systemd/Bubblewrap boundary with private networking, read-only source/Git administration,
  isolated writable state, frozen lifecycle-script-free installation, one fixed `0600` Unix
  Gateway capability, and no production, Docker, Doppler, or GitHub authority. Tailscale Serve owns
  only the validated preview route. Stop retains managed state while the PR stays open; permanent
  removal requires confirmed close/merge and descriptor-, mount-, inode-, owner-, and exact-head
  checks.
- Deploy and paired rollback use the existing deployment lease, immutable releases, activation
  journal, snapshots, capacity/retention gates, and current/previous tuples. Before stopping its
  own worker, the workflow fsyncs one bounded `delivery.production.v1` capsule and launches the
  manifest-bound immutable executor as a transient user-systemd unit in a separate cgroup with
  `env -i` and no application credentials. Target validation and authenticated smoke precede the
  authoritative activation commit. A terminal receipt lets the restarted worker reconcile before
  ordinary claiming and rehydrate the exact original Job after an older paired database snapshot
  without repeating the external effect.
- The living parity inventory is now **145 implemented, nine planned, and three reviewed removals**
  out of 157 legacy endpoints. Browser routes are **15 implemented and one planned**; only root
  `/` remains open. Delivery parity is closed in the greenfield tree; preview launch and production
  cutover remain explicit operator-triggered runtime actions rather than build-time side effects.
- The final whole-rewrite simplification gate now explicitly includes a repository-wide
  `node:*` compatibility audit. Bun-native APIs are mandatory whenever they are at least as capable
  for the supported Bun-only runtime; retained compatibility imports require a concrete documented
  cross-runtime or capability reason. Delivery hashing is being normalized immediately, while the
  full historical audit remains a pre-cutover gate rather than unrelated churn inside this slice.

### 2026-08-13 — Heartbeat schema v5 and application observability implemented

- `cache.getHeartbeat` schema v5 keeps the existing cache, Gateway, task, Dashboard-job, and
  OpenClaw-cron semantics and adds independent payload-free signals for Kopia, WAL-G, PostgreSQL
  and SQLite maintenance, Docker health and updates, logs, Git, quota, host capacity, and weather
  availability. Every leaf is separately `fresh`, `last-known-good`, or `unavailable`; a failed or
  malformed provider cannot erase healthy sibling evidence or publish raw provider payloads,
  paths, identities, or failure text.
- `system.metrics` retains its bounded host sample and adds independently contained web-runtime,
  Jobs, bounded durable-operation and durable-chat aggregates, SQLite, Gateway, realtime-pump,
  registered payload-free cache snapshots, and fixed-procedure HTTP observations. The operation,
  chat, and cache projections are sanitized replacements for legacy generic child-process,
  chat-runtime, and polling-snapshot diagnostics; no argv, identity, chat content, cache payload,
  path, or raw error crosses the contract. HTTP traffic is counted and rendered per reviewed
  procedure plus one overflow bucket, so arbitrary procedure names are never retained. An
  optional-reader failure cannot suppress the host sample or another valid application component.
- Heartbeat remains an API-only declassification surface for the repo-external OpenClaw consumer:
  the consumer contract is still one scoped collection followed by one report. The root overview
  now renders all independent application-metrics readers, per-procedure HTTP buckets, and bounded
  registered cache-snapshot rows alongside the
  host gauges. Component tests and full-page Storybook states cover fully observed, partially
  degraded, and wholly unavailable application observations; heartbeat adds no parallel browser
  route or component.

### 2026-08-13 — Generic exec replacement and production authority closed

- The root manifest installer now installs the two Dashboard system units and one exact sysusers
  declaration alongside the fixed host helper, units, and polkit policy. After revalidating the
  immutable source it may only create the dedicated web principal, reload root systemd, and enable
  the two application units; it never starts a service. Reinstalling the previous root-owned
  immutable release is the explicit rollback.
- Production retains `ubuntu` as the protected state/worker identity and moves web to
  `mira-dashboard-web`. A root-owned fixed launcher creates only reviewed id-mapped project,
  OpenClaw, and state mounts inside web's private namespace. It keeps the operator's Doppler
  credential non-id-mapped, validates its private ownership/mode, projects only the fixed web
  allowlist, proves the dropped web identity cannot read or traverse the credential, unmounts it,
  verifies the credential file absent, and then drops every group and capability. Startup also
  proves Docker and system-manager IPC paths absent.
- Polkit admits only the worker identity, `start` for the three exact host-operation units, and
  `start|stop|restart` for the two Dashboard units. The worker production composition now owns the
  existing fixed-ID broker; arbitrary units, argv, shell, cwd, environment, and raw output remain
  impossible. Cleanup retains the apt/journal/Docker age bounds and never prunes volumes.
- Activation verifies both root-owned unit files against the exact candidate release before pointer
  mutation. The authenticated target smoke additionally proves distinct live principals, exact
  root fragment paths, no web supplementary groups, and the worker Docker group.
- The legacy `POST /api/exec/start` parity row is implemented by the bounded PTY plus purpose-built
  durable Service Actions. The unused synchronous generic exec endpoint remains a reviewed removal.

### 2026-08-14 — Heartbeat v5 authority corrected for manual cutover

- Immutable releases now include one fixed two-command `openClawHeartbeat.js` automation wrapper.
  `collect` performs exactly one schema-v5 `cache.getHeartbeat` query. `report` accepts one strict,
  bounded complete monitoring snapshot over stdin and performs exactly one
  `monitoring.submitCompleteSnapshot` mutation. There is no caller-selected procedure, method,
  path, host, batching, retry, or fallback surface.
- The wrapper requires a canonical Greenfield opaque credential through descriptor-pinned
  `O_NOFOLLOW`, `0600`, ownership and token-schema checks. The legacy
  `openclaw-heartbeat.<64-hex>` value is incompatible and is not reused. Both input and response
  bodies are bounded, UTF-8/JSON/tRPC envelopes are strict, and upstream bodies, validation
  details, paths, and credentials collapse to one fixed safe failure.
- The retained `HEARTBEAT.md` filename identifies an immutable Markdown prompt source, not a live
  workspace target. OpenClaw authority is `agents.entries.ops.heartbeat.prompt`. After Greenfield
  is active and ready, an operator manually creates the new `openclaw-heartbeat` credential with
  exactly `cache:read,monitoring:write`, atomically installs its token, and CAS patches the candidate
  prompt. This hot-restarts only the heartbeat scheduler. Dashboard owns no automatic config or
  credential mutation; legacy is not a rollback target, and later Greenfield release rollbacks keep
  the same schema-v5 authority. The parity row correctly remains planned until an authenticated
  production smoke proves exactly one collection followed by one report.

### 2026-08-13 — Root, backups, Storybook, and source-development parity closed

- `/` now composes the bounded host and application metrics with weather, every provider quota
  window/reset, managed-Git status, complete Docker image/volume summaries, SQLite and
  PostgreSQL/PgBouncer summaries, log-source and maintenance-policy state, Kopia/WAL-G status and
  controls, and the existing task/agent/notification/incident/Jobs/Service Action/report/cache
  surfaces. Independent query and last-known-good boundaries keep one failed domain visible
  without erasing healthy siblings.
- The six Kopia/WAL-G rows are implemented as two bounded independent status queries and four
  recent-MFA durable operations. Root-Compose/Engine capability discovery, fixed provider
  wrappers, exact source fencing, daily schedules, one shared heavy-I/O lease, attention
  clearance, and non-retryable unknown-outcome settlement are covered. This adds backup creation
  and status/control only; no operator-facing database, Kopia, or WAL-G restore operation exists.
- All 18 production pages have full-page Storybook coverage, including root application-metrics
  degradation and log-maintenance attention. The machine page-coverage gate verifies the route
  registry and material route states rather than relying on a manual story count.
- Ordinary source development now advertises the exact production inventory of **28 executable
  actions and 15 schedules**. Contract-valid PostgreSQL/SQLite, Docker, Delivery, backup, Git,
  quota, and weather data plus deterministic conflict/unknown-outcome simulators exercise normal
  Jobs/cache/UI paths while writing only marked development receipts. Managed PR previews retain
  only `system.worker-smoke` and receive none of that simulated authority.
- The living inventory is **153 implemented, one planned, and three reviewed removals** across 157
  legacy endpoints; all **16 legacy browser routes** are implemented. The only planned endpoint is
  `GET /api/cache/heartbeat`, pending the manual external credential/config cutover and
  authenticated one-collection/one-report production proof. Production activation,
  restore/cutover rehearsal,
  the remaining live smokes, and the repository-wide simplification audit remain open Phase 6
  gates.

### 2026-08-13 — Codex app-server quota boundary qualified

- OpenAI quota uses the installed Codex CLI's line-delimited app-server JSON-RPC protocol:
  `initialize`, `initialized`, then one `account/rateLimits/read`. It never scrapes terminal,
  tmux, browser, or status-screen output. One uniquely resolved executable, an operator-owned
  `CODEX_HOME`, a minimal environment, strict response projection, a 512 KiB response cap, and a
  ten-second deadline keep this worker-only read fail-closed.
- App-server remains experimental, so the supported boundary is pinned to qualified
  `codex-cli 0.147.0` and its observed response schema. The required read-only current-host smoke
  returned `available` with one 10,080-minute window without printing credentials or raw provider
  data. Any CLI/protocol change requires a fresh exact-host qualification before activation;
  otherwise only OpenAI quota becomes unavailable.
- Successful collection teardown is bounded as well as request execution: stdin closes, `SIGTERM`
  gets 250 ms, then `SIGKILL` gets one final bounded wait. A child that retains stdio after a valid
  response therefore cannot hang the worker or its cache schedule.
