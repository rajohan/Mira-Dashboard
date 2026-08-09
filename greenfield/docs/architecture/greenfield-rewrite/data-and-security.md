# Greenfield Rewrite Data and Security

[Back to the blueprint map](../greenfield-rewrite.md)

## Database Design

### Core rules

- Resolve one fixed database filename beneath a canonical current-user-owned `0700` state
  directory. Create a missing file with exclusive no-follow `0600` semantics, then call
  `new Database(path, { create: false, readwrite: true, strict: true })` through `bun:sqlite`.
  Retain that native client and pass the same client into `drizzle({ client })`. Drizzle v1 RC's
  current Bun driver no longer accepts the legacy `schema` option; add its explicit `relations`
  model only for domains that use the relational query API. Pin and revalidate the directory/file
  identities during acquisition, and reject a rollback-journal, shared-memory, or WAL sidecar
  unless it is a single-link current-user-owned `0600` regular file. Reject a parent chain whose
  ownership or write permissions let another principal replace the validated directory entry;
  application startup never chmods, chowns, or otherwise repairs that chain.
- Enable and verify foreign keys and checks, disable `trusted_schema`, select WAL with
  `synchronous=FULL` and a 1,000-page automatic checkpoint, and set `busy_timeout=0`. The zero
  timeout is the measured non-blocking policy: a synchronous SQLite wait must not stall Bun's
  event loop. Effect owns explicit bounded retry/deadline schedules at cross-process admission and
  read boundaries. Every current domain repository receives the same process-owned asynchronous
  write-admission port: it may retry only before `BEGIN IMMEDIATE` admits the transaction and the
  synchronous callback starts. A callback is never replayed. Exhausted admission and post-admission
  contention remain typed failures; only mutation routes that declare temporary write unavailability
  expose the fixed redacted `SERVICE_UNAVAILABLE` response. The worker uses that same explicit
  admission policy before entering any immediate transaction.
- Use Drizzle's typed query builder for ordinary reads/writes and its parameterized `sql`
  tagged template for SQLite-specific queries, CTEs, queue claims, and expressions not
  represented cleanly by the builder.
- Use prepared statements and short Drizzle/native transactions. Never hold a read transaction
  across network or child-process work.
- Use UUIDv7 text IDs for externally referenced domain records and integer sequence IDs for
  high-volume local journals/outboxes.
- Keep `.notNull()` on text primary keys for Drizzle's type model. Drizzle Kit currently emits
  `TEXT PRIMARY KEY` without the explicit `NOT NULL`; SQLite `STRICT` primary-key semantics still
  enforce the runtime invariant for rowid-backed tables, while `WITHOUT ROWID` supplies it for the
  audit ledger. Fresh-database introspection verifies the complete applied set instead of relying
  on spelling alone.
- Create the append-only `audit_events` table `WITHOUT ROWID` so no hidden SQLite identity can
  bypass its replacement guard; its explicit UUIDv7 primary key remains the only row identity.
- Store timestamps as UTC epoch milliseconds in `INTEGER` columns. Serialize them explicitly
  at the contract boundary.
- Use `CHECK` constraints for booleans and closed status sets.
- Keep JSON as validated `TEXT CHECK(json_valid(...))` only at integration or flexible
  metadata boundaries. Normalize fields that are filtered, sorted, joined, or constrained.
- Generate base select/insert/update Valibot schemas through `drizzle-orm/valibot`, refine JSON
  and domain constraints explicitly, and validate raw/aggregate query results before returning
  them from a repository.
- Enable foreign keys with deliberate `ON DELETE` actions; do not leave orphan behavior
  implicit.
- Never add an index without naming the query it serves and verifying it with
  `EXPLAIN QUERY PLAN` plus a representative fixture.

### Drizzle without surrendering SQLite control

Drizzle does **not** take away low-level control in this design:

- its Bun driver wraps the exact `bun:sqlite` client supplied by Dashboard;
- the native client remains available for PRAGMAs, serialization/backup, migration locking,
  integrity checks, and other driver-specific operations;
- Drizzle's parameterized `sql` tagged template can express an entire raw query or only the
  SQLite-specific fragment of a typed query;
- table/column references are escaped and interpolated values become bound parameters;
- `sql<T>` improves TypeScript ergonomics but is correctly treated as a type assertion, not
  runtime validation; Valibot still validates raw or computed results; and
- `sql.raw()` is allowed only for static trusted SQL, never user or external input.

That combination provides useful schema inference, column-safe common queries, parameterized
composition, and Valibot schema generation while keeping every SQLite feature available. Small
domain repositories still own query intent; the application does not expose Drizzle query
objects through service or transport layers.

Drizzle also does not own production migration safety. Drizzle Kit generates SQL from the
reviewed TypeScript schema, and that SQL is reviewed and tracked. Dashboard's current runtime
verifies immutable artifact checksums, serializes empty-database initialization, applies only the
unpublished baseline, validates exact schema/history, and runs integrity checks. A pending
published migration fails closed until the release snapshot-and-promotion slice exists;
`drizzle-kit push` is forbidden in production.

Drizzle ORM/Kit `1.0.0-rc.4` does not model SQLite's table-level `STRICT` option in
`sqliteTable`. Generated `CREATE TABLE` statements are therefore reviewed to add the `STRICT`
keyword and apply `WITHOUT ROWID` plus the custom audit and monitoring-JSON validation triggers.
Drizzle Kit may elide the explicit `NOT NULL` spelling on text primary keys; CI verifies the applied
invariant through SQLite introspection. CI applies the tracked SQL to an empty
database and introspects `sqlite_schema` plus `pragma_table_info`; every Dashboard-owned table must
remain `STRICT`, every text primary-key component must be non-null, and the audit ledger must have
no hidden rowid. These explicit, tested SQLite extensions are preferable to pretending Drizzle
generated invariants it currently cannot represent.

Pull requests run the lockfile-pinned `drizzle-kit check` CLI in the read-only foundation job.
It validates the snapshot DAG without giving contributor-controlled code a pull-request write
token. Branch protection requires the branch to be current with its base so a previously green
result cannot remain stale after a conflicting migration merges. This check detects graph
conflicts; it does not prove Dashboard-specific constraints, data safety, restore behavior, or
runtime schema agreement.

At this audit, npm's stable tags are `drizzle-orm@0.45.2` and `drizzle-kit@0.31.10`, while the
official current Bun guide recommends the v1 release-candidate line and npm's `rc` tag is
`1.0.0-rc.4` for both packages. A greenfield implementation should qualify and exact-pin
`1.0.0-rc.4`, or a stable v1 release if one exists when work begins. It must not float an RC
tag.

### Target table groups

| Domain               | Tables                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Schema/config        | `schema_migrations`, `settings`, `secret_envelopes`, `idempotency_records`                                                                                                                                                                                                     |
| Security             | `users`, `auth_sessions`, `auth_pending_logins`, `auth_challenges`, `user_totp_factors`, `user_webauthn_credentials`, `user_recovery_codes`, `auth_rate_limit_buckets`, `automation_principals`, `automation_credentials`, `automation_principal_capabilities`, `audit_events` |
| Tasks/agents         | `tasks`, `task_labels`, `task_automation_profiles`, `task_updates`, `task_events`, `agent_task_runs`                                                                                                                                                                           |
| Monitoring           | `reports`, `monitor_runs`, `incidents`, `incident_observations`, `notifications`                                                                                                                                                                                               |
| Realtime             | `realtime_events`                                                                                                                                                                                                                                                              |
| Scheduling/work      | `scheduled_jobs`, `job_disable_intents`, `job_runs`, `job_run_events`, `worker_instances`, `resource_leases`, `job_worker_control`                                                                                                                                             |
| Chat                 | `chat_runs`, `chat_run_events`, `chat_runtime_snapshots`                                                                                                                                                                                                                       |
| Delivery             | `deployments`, `deployment_events`, `release_records`                                                                                                                                                                                                                          |
| Docker               | `managed_docker_services`, `docker_update_events`                                                                                                                                                                                                                              |
| External projections | `cache_entries`                                                                                                                                                                                                                                                                |

PostgreSQL, PgBouncer, OpenClaw sessions, Gateway history, host logs, files, GitHub, Docker, and
Moltbook remain external systems. Dashboard persists only configuration, bounded projections,
audit/history, job state, or recovery state that it owns. It does not mirror entire external
databases.

### Task and agent ownership

The reviewed agent directory is application configuration rather than database or Gateway
discovery state. `agent_task_runs` persists only current-task intervals owned by Dashboard:

- one partial unique index permits at most one active interval per configured agent;
- run identity, agent, task, start time, and originating actor are immutable;
- completed intervals are append-only history and cannot be reopened or rewritten;
- user actors use UUIDv7 identities, automation actors use canonical scoped-principal IDs;
- start, activity, and completion timestamps are monotonic and bounded; and
- newest-first global and per-agent indexes support strict `(started_at, id)` keyset pages.

An `agents:write` caller can target only an identity in the reviewed directory. It never creates
an agent. Start, heartbeat, replace, and clear transitions run inside an admitted immediate
transaction. State-changing start, replace, and clear transitions append the matching realtime
event atomically; a same-task heartbeat only advances durable activity. The production
task-tracking credential must receive this capability during the delivery/provisioning slice; no
browser session can invoke the mutation.

### Incident and notification lifecycle

Heartbeat and other monitors can report many simultaneous problems across tasks, jobs, system
health, versions, backups, quotas, weather, Git, Docker, memory, or future checks. The schema
therefore models an incident per problem, not one alert per heartbeat report.

An incident has:

- `monitor_key`: stable producer/scope identity;
- `fingerprint`: stable problem identity built from check kind, normalized entity identity,
  and condition, never a timestamp or rendered message;
- `generation`: starts at 1 and increments when a resolved problem appears again;
- `state`: `active` or `resolved`;
- severity, kind, title, current validated details;
- first seen, last seen, resolved timestamps; and
- occurrence count.

`UNIQUE(monitor_key, fingerprint)` guarantees one lifecycle record. Every monitor submission is
a complete snapshot for that monitor and runs one transaction:

1. Insert or update every observed incident and add an `incident_observations` row.
2. Resolve active incidents from the same monitor that are absent from the complete snapshot.
3. If an observation reopens a resolved incident, increment its generation and clear
   `resolved_at_ms`.
4. Insert one notification for each newly opened generation.
5. Insert a report and transactional realtime events for all changed records.

Notifications linked to incidents have a unique `(incident_id, incident_generation, channel)`
constraint. Repeating the same heartbeat while the issue remains active updates `last_seen` and
the report, but cannot create another notification. Marking a notification read has no effect
on incident state or deduplication. Once the issue is observed resolved, the next recurrence
creates a new generation and exactly one new notification.

This replaces generic `dedupe_key` guesswork and previous-report inference with an explicit,
queryable lifecycle.

### Index plan

| Query shape                   | Index or constraint                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| Session lookup                | unique `auth_sessions(validator_hash)`                                                    |
| Session expiry cleanup        | `auth_sessions(expires_at_ms)`                                                            |
| User credentials              | `user_webauthn_credentials(user_id, created_at, id)` and unique credential ID             |
| WebAuthn challenge            | unique partial binding/purpose indexes plus `(expires_at, id)` cleanup                    |
| Automation principal history  | `automation_principals_created_id_idx` plus `automation_principals_active_created_id_idx` |
| Automation credential history | `automation_credentials_principal_created_idx`                                            |
| Active automation credentials | partial `automation_credentials_active_principal_created_idx` while unrevoked             |
| Staged credential rotation    | full `automation_credentials_replacement_idx` plus a unique partial replacement index     |
| Task board                    | `tasks(status, priority, updated_at_ms DESC)`                                             |
| Task label filter             | `task_labels(label, task_id)`                                                             |
| Task timeline                 | `task_updates(task_id, created_at_ms, id)` and equivalent event index                     |
| Agent task history            | unique active-agent partial index plus `(agent_id, started_at_ms, id)`                    |
| Latest reports                | `reports(kind, occurred_at_ms DESC, id DESC)`                                             |
| Heartbeat stream              | `reports(source, source_job_id, occurred_at_ms DESC, id DESC)`                            |
| Active incidents              | partial `incidents(monitor_key, last_seen_at_ms DESC) WHERE state = 'active'`             |
| Incident identity             | unique `incidents(monitor_key, fingerprint)`                                              |
| Unread notifications          | partial `notifications(occurred_at_ms DESC) WHERE read_at_ms IS NULL`                     |
| Incident notification         | unique `(incident_id, incident_generation, channel)` when incident is non-null            |
| Queue claim                   | partial `job_runs(available_at, priority DESC, queued_at, id) WHERE state = 'queued'`     |
| One active scheduled run      | unique partial `job_runs(scheduled_job_id) WHERE state IN ('queued', 'running')`          |
| Worker expiry                 | `worker_instances(heartbeat_at, id)`                                                      |
| Job timeline                  | `job_run_events(job_run_id, sequence)`                                                    |
| Realtime catch-up             | `realtime_events(topic, id)`                                                              |
| Chat replay                   | unique `chat_run_events(chat_run_id, sequence)`                                           |
| Deployment history            | `deployments(state, updated_at_ms DESC)`                                                  |
| Docker history                | `docker_update_events(managed_service_id, created_at_ms DESC)`                            |
| Cache refresh/expiry          | `cache_entries(last_attempt_status, expires_at_ms, key)`                                  |
| Audit cursor                  | `audit_events(occurred_at_ms DESC, id DESC)` plus request/target indexes                  |

Primary keys and unique constraints already create indexes; the schema does not add redundant
copies. Partial-index predicates must match query predicates exactly enough for SQLite to use
them.

### Migrations, backup, and retention

Drizzle Kit v1 stores the migration graph as timestamped directories containing
`migration.sql` and `snapshot.json`. During the unpublished rewrite, `migrations/` contains exactly
one evolving `*_dashboard-foundation` baseline generated from the complete current Drizzle schema.
The generated SQL includes the security identity objects, SQLite `STRICT` table options, canonical
NUL-free constraints, bounded migration-ledger identity fields, and deliberate
`audit_events WITHOUT ROWID` and `agent_task_runs WITHOUT ROWID` hardening. The custom audit
metadata, append-only audit/migration ledger, immutable completed agent-run history,
monitoring-JSON, and automation replacement-integrity triggers are reviewed additions because
Drizzle does not model them.
There is no compatibility preflight or upgrade path for an intermediate rewrite database: every
test and the final cutover start empty and apply this one baseline. Each schema slice regenerates
the baseline, reviews the complete SQL/snapshot diff, and updates the explicit manifest checksums.
At cutover those bytes become immutable; later production schema changes are generated as new,
forward-only, checksummed nodes.

The snapshot files form Drizzle Kit's conflict-analysis DAG. Before touching database state, the
Linux runtime loader holds the complete release graph through descriptor-rooted `/proc/self/fd`
paths. It verifies exact root/node inventories, stable single-link regular files, valid 14-digit
timestamp prefixes, identifiers capped at 128 bytes, at most 64 ordered unique nodes, SQL and
snapshot checksums, strict UTF-8 SQL, and 1 MiB SQL / 4 MiB snapshot / 32 MiB total byte ceilings.
After the raw bytes are verified, the runner trims only each statement's outer whitespace before
execution so Bun SQLite cannot mask a trigger abort behind a trailing `;\n`; the checksummed source
stays unchanged. `drizzle-kit check` must be green before release; stock Drizzle name-based pending
detection is not accepted as the integrity boundary.

`initialize-empty` may exclusively create the fixed private database and applies the complete
baseline inside one immediate transaction. `validate-only` never creates an absent database. Two
concurrent runtime starts serialize through SQLite admission with an Effect-owned five-second
busy/locked deadline, then the loser validates the winner's exact result. Current databases must
match the reviewed schema, immutable checksum ledger, strictly increasing non-future application
times, connection policy, and integrity checks. Unknown history fails closed. A reviewed pending
prefix raises `DatabaseRuntimeSnapshotRequiredError`; it is not migrated in place.

Post-cutover delivery must add the missing snapshot/promotion protocol before enabling forward
migrations: quiesce writers, acquire the deployment lease, create and verify a WAL-safe snapshot,
apply to a copy, and atomically promote the matching release/database pair. The future web and
worker executable roots may start concurrently, but only one may own that protocol while the other
waits with a bounded deadline and validates the final schema. Neither process may contain
table/column existence fallbacks.

Retention remains explicit per append-only table. The later maintenance job removes bounded
batches, requests passive checkpoints during normal operation, exposes WAL/checkpoint health, and
runs expensive optimization only under a resource-scoped job. Backups include database plus
release/schema identity, resolve only beneath
`<project-root>/production/state/backups`, and remain restore-tested release artifacts.

## Worker and Privileged Operations

The web process may perform bounded reads and lightweight Gateway interaction. It does not run
deploys, builds, Git mutations, Docker mutations, backups, restores, systemd changes, OpenClaw
restarts, or unbounded shell commands. Those operations become durable `job_runs` consumed by
the worker.

The `cache:read` automation heartbeat is a separate sanitized projection, not a shortcut around
session or cron detail authorization. It reads only process-local validated summaries and bounded
payload-free cache status, performs no upstream refresh, and discloses no session/cron identity,
payload, credential, endpoint, or raw failure. Missing and last-known-good projection states remain
explicit so an empty count is never inferred from unavailable upstream state.

Queue behavior is explicit:

- a strict singleton `job_worker_control` row persists cross-process claim pause state and
  versioned operator changes; its absence is an integrity failure, never an implicit resume;
- one immediate transaction considers at most 32 totally ordered candidates, skips candidates
  with occupied resources, and atomically assigns the first eligible run plus every required
  resource lease;
- each run has an idempotency key, resource class, priority, timeout, attempt limit, and
  cancellation policy;
- manual-run idempotency is scoped to the requesting principal and hashes stable request intent,
  while schedule ticks use a deterministic schedule-and-occurrence namespace;
- the worker renews its lease and writes ordered progress events;
- expired leases can be recovered only when the action is declared retry-safe;
- resource leases prevent conflicting deploy, restore, Docker, or OpenClaw operations;
- cancel requests are persisted and propagated to the child process group;
- stdout/stderr are incrementally bounded, redacted, and spilled to a controlled log file when
  necessary only beneath `<project-root>/production/state/job-output`; and
- final structured output is validated before persistence or display.

Run history is bounded to 1,000 events and 1 MiB of encoded payload per run. The first 967 slots
may carry progress/stdout/stderr payloads; 33 structural slots remain reserved so every legal
ten-attempt lifecycle can record claims, retry decisions, cancellation, truncation, and a terminal
event. Schedule cursor advancement is separate from operator configuration versioning. A due
schedule with an active queued or running occurrence keeps its original cursor; after completion
the scheduler creates one coalesced run for that occurrence and advances directly to the first
future occurrence, never replaying an unbounded backlog. Disabled schedules retain that cursor as
an internal cadence anchor but do not become due until re-enabled; the public summary exposes a
next run only while enabled. Manual runs do not move cadence.

`Bun.spawn` receives argument arrays, a deliberate environment allowlist, an explicit working
directory, a timeout, and an abort signal. It never receives interpolated shell text for user
input. High-risk jobs run in dedicated transient systemd units or templates with their own
memory, CPU, task, I/O, runtime, and process-group limits. Killing one job must not kill the web
process or exhaust the VPS.

Scheduled jobs create ordinary job runs. There is no second scheduled-run state machine.
`job_disable_intents` applies uniformly to Dashboard jobs and external OpenClaw cron jobs and
stores the reason, actor, creation time, optional expiry, and external target identity in
columns rather than an opaque JSON convention.

## Authentication and Security

### Authentication model

Retain the current security behavior while simplifying its structure:

- first-user bootstrap verifies the OpenClaw Gateway credential through one native protocol-v4
  handshake before creating the user. The one-shot verifier was checked against the OpenClaw
  version installed on the target host on 2026-08-06, permits only an explicit literal-loopback
  `ws://` root endpoint, sends the candidate only in `connect.params.auth.token`, and stores
  neither the candidate nor Gateway connection state;
- passwords use Bun's password hashing with a reviewed Argon2id policy;
- password-first roaming security keys use pinned SimpleWebAuthn APIs with an explicit RP ID,
  allowlisted origins, ES256-only public keys, required user verification, and no attestation;
- every WebAuthn ceremony uses one short-lived, purpose-, binding-, authentication-version-, and
  RP-configuration-bound challenge that is replaced atomically and consumed on the first
  verification attempt; registration/authenticator parsing and cryptography stay outside SQLite
  write transactions;
- WebAuthn binds each credential to an internal user ID and deterministically derives its stable
  opaque user handle from that binding. Persistence retains only that user binding, the globally
  unique credential ID, public key, fixed backup-eligibility/device type, mutable backup state, and
  compare-and-swap counter state; raw responses, challenges, attestation data, and verification
  errors never enter audit metadata or logs. Credentials from an earlier RP ID remain
  visible and removable but are marked unusable, are excluded from login and step-up, and cannot
  justify removal of the last currently usable possession factor;
- TOTP and single-use recovery codes remain available. A WebAuthn-only account whose credentials
  belong to an earlier RP ID can still enter a recovery-only password-first pending login, consume
  one recovery code, and enroll a credential for the current RP ID;
- password-first MFA login receives only a short-lived pending-login validator;
- durable browser sessions use random opaque validators, store only their hashes, and enforce
  idle and absolute expiry;
- recent high-assurance verification is required for secrets, credentials, deploy, rollback,
  restore, exec, Docker mutation, and security administration;
- the process Effect runtime bounds Gateway, password/Argon2, TOTP AES/HMAC, and WebAuthn
  parsing/signature work with separate concurrency and queue limits; rolling in-memory budgets
  stop parallel requests before expensive work can outrun durable cooldowns, and a failed authentication attempt retains its active-work
  permit until the immediate failure/cooldown transaction has settled so the next queued attempt
  observes it;
- users can inspect and revoke browser sessions; and
- credential, session, password, and MFA changes invalidate the appropriate authentication
  version or validators atomically.

The Gateway handshake requests `operator.admin` only because the installed release exposes
`snapshot.authMode` at that scope; it sends no post-connect RPC and initiates close after the
terminal response. Success requires protocol 4, operator role, negotiated `operator.admin`, and
token auth mode. The protocol adapter accepts only text JSON and exactly one challenge plus its
matching response. The challenge
is capped at 4 KiB; the current installed hello ceiling is 25 MiB. Binary, unknown, duplicate,
out-of-order, wrong-ID, contradictory, auth-disabled, malformed, oversized, incompatible, or
closed flows fail immediately as one redacted upstream-unavailable result. Only structured
`AUTH_TOKEN_MISMATCH` is an invalid credential.

The upgrade includes no Origin, authorization, forwarding, or subprotocol header and no token in
the URL. The verifier never reconnects or retries, including on `startup-sidecars`; the whole HTTP
bootstrap request must be retried under durable cooldown. Every terminal path after socket
construction initiates close, and the Promise plus its Effect permit settles only after native
close is observed. User/session publication remains behind successful verification and the
empty-user invariant is rechecked in the immediate creation transaction. The native WebSocket
adapter remains a narrow Promise port inside the separate Effect gate, deadline, cancellation, and
active-work boundary.

This evidence closes only first-user credential verification. It does not qualify Phase 4's
persistent Gateway lifecycle, events, sessions, chat, or cron behavior. Every later OpenClaw
integration must first audit the then-installed OpenClaw source and protocol. Legacy Dashboard
integrations remain parity input rather than authority. The complete assets, misuse cases,
controls, tests, and residual risks are recorded in the
[Phase 2 threat model](../../security/greenfield-phase-two-threat-model.md).

Session cookies are `Secure`, `HttpOnly`, `SameSite=Strict`, narrowly scoped, and never readable
by JavaScript. Unsafe browser requests require exact allowed Origin and Fetch Metadata before
authentication. Same-origin SSE uses the same session and never accepts a bearer token in a
query string.

### Automation identities

Each automation caller is a named principal with an explicit capability set and one or more
rotatable credentials. Tokens contain at least 256 bits of randomness, are returned to the
operator once, and are represented in the database only by a versioned validator hash and
non-secret prefix. Comparison is constant-time. A TypeScript client cannot call a procedure
outside its principal's capability set even if it knows the procedure name.

The greenfield token is the canonical `32-lowercase-hex-prefix.64-lowercase-hex-validator`
opaque-token form. Its SHA-256 validator hash is domain-separated by token kind, validator
version, and prefix, so material from a browser session or pending login cannot be replayed as an
automation credential. The complete token is returned only by the successful create or staged
rotate response. Credential history exposes the non-secret prefix, but no list exposes the
validator, validator hash, validator version, or a reconstructable token. Audit metadata and
errors omit all token material and operator labels.

The lifecycle enforces these persistent limits and history rules:

- at most 32 principals may be enabled at one time; disabled principal rows remain as history;
- at most four non-revoked, non-expired credentials may be usable for one principal at one time;
- principal and credential history are returned newest-first through stable `(created_at, id)`
  cursors, with bounded pages rather than silent lifetime truncation; and
- credential use does not write `last_used_at`. Request authentication and renewable-lease
  validation stay read-only, avoiding a synchronous SQLite write for every request or lease.

The browser-session-only `automationSecurity` namespace lists principals and credential history
and owns principal creation, credential creation, staged rotation, explicit revocation, exact
capability replacement, and terminal principal disablement. Every mutation requires recent MFA.
After acquiring the SQLite immediate-transaction lock, it revalidates the operator's session,
authentication version, MFA enrollment, and recent-MFA timestamp before changing state. An
automation principal cannot self-administer this surface, regardless of its capability set.

All mutations against an existing principal carry the expected authorization version. A stale
version, disabled target, invalid timestamp, active-cap violation, or conflicting replacement
fails closed. Capability replacement computes an actual set diff, preserves `granted_at` for
unchanged grants, timestamps only new grants, and increments the authorization version exactly
once for a real change. An identical replacement is a no-op with no version bump or audit event.
Authentication and lease renewal reject every grant whose timestamp precedes principal creation,
follows the principal's current `updated_at`, or lies in the future relative to the validation
clock. Administration also scans persisted lifecycle history before applying inventory cursors,
active counts, or new-principal inserts: any principal creation/update/disable timestamp or
credential creation/revocation timestamp ahead of the transaction clock fails closed. Credential
inventory performs the complete scan even for a terminally disabled principal, before a cursor can
page around the future row.

Credential rotation is deliberately staged. `rotateCredential` creates one linked replacement,
returns its token once, and leaves the predecessor usable while the operator installs and verifies
the replacement. Explicit revocation completes cutover. If the create response is lost, the
non-secret replacement remains visible in credential history; the operator can revoke it and retry
without losing the predecessor. A partial unique index permits at most one unrevoked replacement
per predecessor. Custom SQLite triggers additionally reject cross-principal or otherwise invalid
replacement links on insert and update, including an attempt to move a predecessor underneath an
existing replacement.

Credential revocation is idempotent: a repeat reports no change and appends no duplicate audit
event. Principal disablement is terminal in this slice; it sets `disabled_at`, increments the
authorization version, and revokes every then-usable credential in the same transaction. The
disabled principal makes every historical credential invalid whether or not an already expired
row receives a redundant revoke timestamp. A clock rollback does not block this terminal
containment: a credential created ahead of the current clock may remain physically unrevoked, but
the disabled principal prevents it from authenticating when the clock catches up. Repeating
disablement is likewise a no-op. Each real
state transition and its redacted audit event commits together in one synchronous
`BEGIN IMMEDIATE`; no network call, file I/O, or asynchronous work runs inside that callback.

This lifecycle needs no separate Effect service. CSPRNG, SHA-256 derivation, pure policy, and
indexed synchronous SQLite operations are bounded local work. Effect remains the boundary for
operations that materially need cancellation, deadlines, asynchronous concurrency, or scoped
resources rather than a wrapper for every `async` route.

Authentication is never inferred from localhost, a private IP, or a proxy header. Trusted
proxy mode names exact proxies and requires them to overwrite forwarded identity headers.

### Secrets and dangerous boundaries

- Doppler or systemd credentials remain the source for infrastructure secrets.
- A secret that must be editable through Dashboard is stored in `secret_envelopes` using a
  versioned AES-GCM envelope whose master key never enters SQLite.
- Configuration APIs return presence/status metadata, never recoverable secret values.
- Generated docs include environment variable names, type, default behavior, and secret flag,
  but never runtime values.
- File and media operations resolve against named allowlisted roots, reject traversal, verify
  containment after symlink resolution, avoid following unsafe links, and enforce size/MIME
  limits before parsing or preview.
- The Files and Terminal surfaces may share the explicit `MIRA_DASHBOARD_WORKSPACE_ROOT`. Files
  keeps descriptor-anchored containment for each operation. Terminal uses the same named root only
  to select the interactive shell's initial working directory: it is not a filesystem sandbox, and
  the shell may leave it wherever the worker's OS identity has access.
- Files' separate web-only `MIRA_DASHBOARD_OPENCLAW_ROOT` is not a recursive OpenClaw browser. Its
  descriptor adapter synthesizes a tree from the exact reviewed `openclaw.json` and
  `hooks/transforms/agentmail.ts` manifest, verifies same-owner/same-device regular files, rejects
  links, world-writable nodes, traversal, and oversized content, and redacts configuration JSON
  before ticket creation or range selection. The root is read-only and offers no raw-secret reveal;
  the worker does not parse, open, or receive this root.
- Dashboard's worker-owned rotation engine uses an exact reviewed per-file manifest for Dashboard,
  OpenClaw, and managed application/container logs rather than treating a directory as a recursive
  wildcard. Ubuntu system logrotate remains responsible only for the exact `rsyslog`, `apport`,
  `dpkg`, and `alternatives` policies through a fixed worker broker. Both paths exclude journald
  storage, binary login/audit databases, sockets, devices, hardlinks, and symlink escapes.
  The web and worker units retain `PrivateTmp=true`; the exact host `/tmp/openclaw` directory is
  mounted read-only into web and writable into worker so private temporary namespaces cannot
  silently hide the reviewed OpenClaw source or prevent its worker-owned retention policy.
- Markdown and HTML are sanitized at the rendering boundary. A raw HTML feature is not an
  authorization boundary.
- Exec, terminal, Git, Docker, systemd, backup, restore, and OpenClaw adapters each have a
  command/operation allowlist and a structured audit record.
- Logs and audit details pass a central redactor before persistence and again before browser
  output.
- CSP, frame denial, MIME-sniff prevention, referrer policy, permissions policy, and request ID
  headers are set centrally for frontend and API responses.
