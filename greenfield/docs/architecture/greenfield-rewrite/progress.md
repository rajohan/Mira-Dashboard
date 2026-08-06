# Greenfield Rewrite Progress

[Back to the blueprint map](../greenfield-rewrite.md)

## Implementation Progress

This matrix is the living phase status. Update it in the same change that materially advances or
closes a phase; dated entries below provide the evidence, not a second status source.

| Phase                               | Status                               | Current evidence and remaining gate                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Evidence and qualification      | Complete                             | All eight mandatory spikes pass on exact Bun revision `17d6843606d76620cb55d31424d7fb0aed51c367`: build, transport, cross-process SQLite/outbox, Drizzle/Bun SQLite, browser data, chat batching, shutdown, and capped resources. Source-derived parity and the OpenClaw source audit pass as additional evidence.                                                                              |
| 1 — Foundation                      | In progress                          | Server composition, migrations, contracts, raw HTTP/realtime foundations, process-owned database runtime, source-boundary enforcement, staged typed configuration, generated configuration reference, structured logging/request correlation, and procedure error policy exist; executable web/worker roots, browser shell, complete generated references, and release/rollback closure remain. |
| 2 — Trust and transport             | Complete for the stated server scope | Authentication, MFA, WebAuthn, automation credentials, audit, authenticated renewable SSE, one-shot native Gateway bootstrap verification, and the consolidated [threat model](../../security/greenfield-phase-two-threat-model.md) have executable evidence. Browser UI and production cutover remain later gates.                                                                             |
| 3 — Core operator domains           | Started                              | Monitoring transaction/schema foundations exist; task, agent, report, incident, notification, schedule/job, cache/metrics procedures and browser parity are not complete.                                                                                                                                                                                                                       |
| 4 — Gateway and chat                | Not started                          | The Phase 2 verifier is one-shot only. Persistent native Gateway lifecycle, current-protocol re-audit, sessions, chat journal/recovery, attachments, and frontend remain open.                                                                                                                                                                                                                  |
| 5 — Privileged and external domains | Not started                          | Worker-owned file/media, Docker, database, OpenClaw, GitHub, deployment, backup, and other privileged adapters remain open.                                                                                                                                                                                                                                                                     |
| 6 — Parity, hardening, and cutover  | Not started                          | Full UI parity, generated `/docs`, load/resource/restore evidence, cutover rehearsal, fresh production database, and legacy removal remain open.                                                                                                                                                                                                                                                |

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
- The current `Bun.serve` boundary rejects every request body above 64 KiB before the tRPC Fetch
  adapter parses it. The monitoring submission API is not exposed yet; before it is, its serialized
  worst case must fit that ceiling or use a separately qualified bounded raw/streaming route. The
  process-wide allowance is not silently raised to accommodate a hypothetical future payload.
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
  rejected before context creation. Auth request bodies have a 16 KiB pre-parse ceiling, every
  current request has a Bun-level 64 KiB ceiling, and every application-handled tRPC success,
  error, and raw auth rejection uses `Cache-Control: no-store`. A trusted reverse proxy owns the
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

- Phase 0 is complete, but the rewrite is not: Phase 1 remains in progress with browser/worker
  roots, complete generated references, immutable release/rollback, and end-to-end empty-database
  web/worker delivery still open. Final production load, restore, cutover, and legacy-removal
  evidence remains in Phase 6.

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
  the policy; framework routing and input/transport validation remain implicit. Phase 1 is still
  in progress: executable web/worker roots, worker lifecycle, browser shell, and release/rollback
  delivery remain open.

### 2026-08-06 — Process-owned database runtime

- The production `ManagedRuntime` now owns one strict native SQLite connection and the exact
  Drizzle client built from it. Dashboard repositories and the database-backed realtime pump use
  that same handle; request handling cannot create or dispose a database or runtime. The layer
  graph finalizes realtime before a passive checkpoint and strict SQLite close, and the process
  logger flushes only after runtime disposal. Listener drain still completes before this sequence,
  with readiness withdrawn before drain begins.
- Startup verifies the complete release-owned migration graph before database mutation. The Linux
  artifact reader holds descriptor-rooted directories and regular files through `/proc/self/fd`,
  rejects symlinks, hardlinks, special files, inventory drift, path replacement, invalid UTF-8,
  and checksum mismatch, and enforces 1 MiB SQL, 4 MiB snapshot, and 32 MiB graph ceilings. The
  manifest is ordered, unique, and capped at 64 nodes with 128-byte identifiers.
- The database lives at one fixed filename beneath a canonical current-user-owned `0700` state
  directory. Dashboard creates a missing file with exclusive no-follow `0600` semantics, opens it
  through SQLite with `create: false`, pins and revalidates the directory and file device/inode
  identities, and validates every rollback-journal, shared-memory, or WAL sidecar present during
  acquisition as a single-link current-user-owned `0600` regular file.
- Every connection verifies foreign keys and checks enabled, `trusted_schema` disabled, WAL,
  `synchronous=FULL`, a 1,000-page automatic checkpoint, and `busy_timeout=0`. Zero is deliberate:
  SQLite never blocks the Bun thread waiting for another process; bounded Effect schedules own
  startup admission and realtime read retries instead. A five-second startup deadline covers
  busy/locked variants without exposing native errors.
- `initialize-empty` applies the single unpublished baseline atomically; `validate-only` never
  creates an absent database. Already-current state is revalidated against the exact schema and
  immutable ledger. The ledger enforces bounded canonical ids, exact checksums/release identities,
  strictly increasing non-future timestamps, and append-only triggers. A reviewed pending graph
  fails closed with `DatabaseRuntimeSnapshotRequiredError`: verified snapshot/promotion, worker
  startup, backup/restore, and release-pair rollback remain later delivery slices.
