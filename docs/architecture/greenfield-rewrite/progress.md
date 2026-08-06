# Greenfield Rewrite Progress

[Back to the blueprint map](../greenfield-rewrite.md)

## Implementation Progress

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
  `eventsource` `4.1.0` test ponyfill. `@valibot/to-json-schema` is build-time documentation
  tooling, not part of tRPC validation. Bun 1.4 does not expose a global `EventSource`, so the
  ponyfill is test-only; browsers use their native implementation. Both packages are
  development dependencies and stay out of the production runtime and browser bundle.
- The same install refreshed `oxlint-config-presets` to `0.1.18` and
  `@microlink/react-json-view` to `1.31.26`. The lockfile was regenerated with the qualified
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
  local command and is not part of ordinary hosted CI or the general qualification test command.
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
  retains revocable opaque credential validators rather than JWTs, configuration uses Bun plus
  composition-root Valibot parsing rather than `dotenv`, and HTTP calls use tRPC/native `fetch`
  rather than Axios.

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
  invalidates all historical tokens. Clock rollback does not block terminal containment; a
  future-created row can remain physically unrevoked while principal disablement keeps it invalid
  after the clock catches up.
- This slice adds no Effect service: generation, hashing, policy, and SQLite transactions are
  bounded synchronous work. The deterministic generator now emits all eight procedure rows and 16
  input/output JSON Schemas; 13/13 documentation tests and `docs:check` pass at this checkpoint.
  Full repository CI parity remains a delivery gate rather than a claim of this progress entry.
