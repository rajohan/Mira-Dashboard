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

| Domain               | Tables                                                                                                                                                                                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema/config        | `schema_migrations`, `settings`, `secret_envelopes`, `idempotency_records`                                                                                                                                                                                                                                       |
| Security             | `users`, `auth_sessions`, `auth_pending_logins`, `auth_challenges`, `user_totp_factors`, `user_webauthn_credentials`, `user_recovery_codes`, `auth_rate_limit_buckets`, `automation_principals`, `automation_credentials`, `automation_principal_capabilities`, `audit_events`                                   |
| Tasks/agents         | `tasks`, `task_labels`, `task_automation_profiles`, `task_updates`, `task_events`, `agent_task_runs`                                                                                                                                                                                                             |
| Monitoring           | `reports`, `monitor_runs`, `incidents`, `incident_observations`, `notifications`                                                                                                                                                                                                                                 |
| Realtime             | `realtime_events`                                                                                                                                                                                                                                                                                                |
| Scheduling/work      | `scheduled_jobs`, `job_disable_intents`, `job_runs`, `job_run_events`, `worker_instances`, `resource_leases`, `job_worker_control`                                                                                                                                                                               |
| Chat                 | `chat_runs`, `chat_run_events`, `chat_runtime_snapshots`                                                                                                                                                                                                                                                         |
| Delivery             | No domain-specific tables. Bounded read projections use `cache_entries`; durable operations and release history use `job_runs`/`job_run_events`; security history uses `audit_events`; activation state, snapshots, and cross-release operation receipts remain descriptor-protected production-state artifacts. |
| External projections | `cache_entries`                                                                                                                                                                                                                                                                                                  |

PostgreSQL, PgBouncer, OpenClaw sessions, Gateway history, host logs, files, GitHub, Docker, and
Moltbook remain external systems. Dashboard persists only configuration, bounded projections,
audit/history, job state, or recovery state that it owns. It does not mirror entire external
databases.

Membership in an external topology is always source-derived. PostgreSQL catalogs and Docker
Engine inventory are the membership sources; configured endpoints, trust roots, credentials,
Compose files, labels, and policy limits constrain access or enrich records but are not manual
allowlists. Each refresh is bounded and deterministically reconciles additions, removals, and
renames. A source-wide failure retains last-known-good state, while a safe per-item failure leaves
that discovered item visible with unavailable details. Neither case may be projected as a fresh
empty inventory. The sole named application-data exception is the optional Comet/Bitmagnet
count-only view capability; it cannot filter or fail generic database discovery.

Docker intentionally adds no domain-specific SQLite tables. Its complete bounded Engine/Compose
overview, updater-service projection, and newest updater events occupy the validated
`docker.overview` row in `cache_entries`; refresh failure retains that last-known-good payload under
the shared cache lifecycle. Durable Docker requests and execution history use `job_runs` and
`job_run_events`, their security record uses `audit_events`, and material updater transitions are
published idempotently through the existing `notifications` table. The bounded cached event window
is replayed after every successful projection, making an interrupted or partial notification batch
retryable through exact-ID upsert. Durable Jobs state and its `queued` event are the sole queue
authority; Docker does not duplicate queue admission into updater history or notifications. Compose files, Git history,
Engine state, registry responses, container output, and secrets remain external and are never
mirrored into Docker-specific service or event tables.

Delivery follows the same shared-storage rule. Pull requests, preview state, production checkout,
and release state are four independently refreshed, independently retained `cache_entries` rows;
one upstream failure cannot erase or stale the other three. The newest production operations are
an exact indexed projection of `delivery.production.v1` rows in `job_runs`, while their timelines
and admission/security history remain in `job_run_events` and `audit_events`. GitHub data, Git
checkouts, preview worktrees, immutable releases, activation state, database snapshots, and
cross-release operation receipts stay in their owning external or protected filesystem boundary.
No duplicate deployment queue, event stream, or release-record table is introduced.

Database observability follows that rule. The web process may read Dashboard SQLite only through
the retained runtime's narrow read port; it does not open another native handle or accept SQL from
the browser. External PostgreSQL/PgBouncer collection is worker-owned and uses fixed reviewed
queries under a deadline, row budget, payload budget, and exact resource key. Only a validated
last-known-good projection crosses into Dashboard SQLite. Public rows omit connection strings,
credentials, host/container paths, raw errors, provider output, and query literals; transient
collection failure is represented as stale or unavailable instead of an empty healthy snapshot.
Dashboard SQLite backup inventory is descriptor-anchored and bounded across exactly the scheduled
maintenance and activation/cutover namespaces. It never infers legacy provenance from a filename:
the single immutable activation/cutover snapshot subsumes the former pre-deploy and pre-migration
recovery purposes. Scheduled snapshots receive a separate temporary-copy `quick_check` and
migration verification before publication; cutover snapshots honestly remain manifest-verified
until an equivalent restore-copy verification exists.
Scheduled retention is capped at fourteen. Cutover retention is enforced on every committed,
recovered, and same-candidate activation success: no more than five snapshots and no unreferenced
snapshot older than two days, while current/previous activation and active journal references are
protected. Both namespaces use an atomic parent-descriptor `.retire-*` handoff followed by a
bounded resumable reaper; published immutable directories are never chmoded or unlinked in place.
The reapers reject untrusted shapes and observed path/inode drift, while the exact deployment lease
serializes all authorized mutation by the trusted application UID. Because Linux unlink remains
pathname based and that UID can already rewrite the application-owned namespace, malicious
concurrent same-UID mutation is outside this boundary. The planned root-owned immutable handoff and
different-principal garbage collector are required before treating that principal as hostile.
Snapshot capacity is admitted from SQLite's bounded logical page count, not only the lagging main
file. Scheduled maintenance reserves two logical copies plus the free-space floor before creating
its snapshot; cutover reserves possible WAL-checkpoint growth plus one logical snapshot before the
checkpoint. The restore-copy phase is checked again against the immutable snapshot size. A large
WAL held by a reader therefore cannot make a small main-file stat understate peak disk demand.
Production collection requires a dedicated login monitoring principal rather than an application
or superuser credential. The login has no built-in monitoring membership: broad
`pg_monitor`/`pg_read_all_stats` access would reveal raw activity and statement text even when
source views were revoked. One isolated `NOLOGIN` capability owner has exactly direct
`pg_read_all_stats` membership plus direct `SELECT` on `pg_catalog.pg_statistic` in each
provisioned database. The observer has zero role memberships and receives only direct database
`CONNECT`, `USAGE` on the private capability schema, and `EXECUTE` on four exact, no-input,
bounded, sanitized `SECURITY DEFINER` functions: `connection_metrics()`, identity-free
`statement_metrics()`, `table_health()`, and `maintenance_metrics()`. `PUBLIC` and the observer
receive no raw `pg_stat_statements` source-view or extension-routine access. The statement
capability calls `pg_stat_statements(false)` internally and returns no query text, `queryid`,
database identity, or user identity. Exact source, dependency, shape, owner, ACL, and output-column
verification fails closed on drift. The observer also retains read-only transactions and a fixed
statement timeout;
PgBouncer grants only `stats_users`, never `admin_users`. Direct/inherited observer routine grants
and effective access to user-schema `SECURITY DEFINER` routines are forbidden; ordinary `PUBLIC`
invoker routines remain compatible. The code-owned PgBouncer alias and dedicated physical control
database are both named `mira_dashboard_observability`; the existing wildcard route preserves that
name without a second label, mapping, or stack database environment value. Dynamic application
inventory remains catalog-derived. The existing hourly
`cache.refresh.database-observability` job calls a separate worker-only privileged
collection-lease port only while the provider is configured. The observer is `NOLOGIN`, expired,
and has zero PostgreSQL sessions between attempts. A fixed attempt first closes leftovers. Its
`open-approved-collection` mode verifies the exact approval and identities, performs the full
bounded idempotent ACL-and-capability reconcile, keeps `NOLOGIN`, and prepares a one-use token
bound to the exact catalog digest. `enable-approved-collection` rechecks approval, identity,
policy, and digest before it atomically consumes that token and sets `LOGIN` plus a short
`VALID UNTIL`. The collector
runs once with observer authority, then a shielded mandatory close restores `NOLOGIN`, expires the
role, terminates sessions, and proves zero sessions again. Only after that proof can the lease
return a payload to the generic cache executor for commit. The observer and collector receive no
administrative credential or mutation authority.

Explicit activation is the sole writer of the approval binding to
`pg_control_system().system_identifier` and the exact current and previous immutable-release policy
digests. The version `sanitized-capabilities-v1` is not sufficient authorization; lease operations
may read but never create or update that marker. Every approved open performs and verifies the
complete bounded, idempotent ACL-and-capability reconcile; no persisted catalog fingerprint,
verification-age state, or reduced path authorizes access. Reconciliation removes all
`PUBLIC` database privileges, so database owners retain their implicit authority while every
non-owner application role needs explicit reviewed `CONNECT`/`TEMP` grants. A newly discovered database
is reconciled before the next approved collection can expose its details. If an application
database still drifts, observer `CONNECT` is revoked for that database and only its details are
unavailable; cluster or control drift still fails the attempt. The `comet` and
`bitmagnet` count cards
read one exact row from `mira_dashboard_observability.torrent_count`. Each database uses a
non-login view owner; `PUBLIC` receives no schema, view, or base-table authority, while the
monitoring principal receives only `USAGE` on that schema and `SELECT` on that view. It receives
no direct `SELECT` on the torrent base tables. Until these grants and views are provisioned and
verified, the affected source or count card remains explicitly unavailable.

The privileged port adds no job action, schedule, systemd unit, sidecar, polling loop, PostgreSQL
login, reusable executor credential, or exclusive admission. Any open, collection, or close
failure preserves last-known-good, blocks a fresh cache commit, and settles the hourly attempt as a
retryable failure containing only a generic redacted reason. PostgreSQL's closed-state proof does
not prove that PgBouncer has no already-authenticated waiting client because the two admission
boundaries are not transactional. Such interference fails the attempt; once the role is
`NOLOGIN` and expired and its PostgreSQL sessions are terminated, a waiting client cannot obtain a
new backend. Administrative output, database names, and provider details never cross that
settlement boundary.

Legacy query text and its browser copy action are a reviewed security narrowing. Even
`pg_stat_statements` text can retain identifiers, comments, or utility-statement data that should
not cross the browser, audit, logging, or durable-cache boundaries. The replacement preserves
ranked calls, rows, execution time, and block metrics for performance triage, but exposes no query
literal or stable reversible query identity.
Maintenance parity is not weakened by that boundary. PostgreSQL retains bounded dead/live tuple,
last autovacuum/autoanalyze, physical-size, conservative reclaimability, and slow aggregate
signals. The browser presents explicit reasons when bloat, dead tuples, slow aggregates, missing
capabilities, or incomplete database/table assessment need review. SQLite independently reports
material reusable pages, backup age, maintenance schedule/run health, and unavailable lifecycle
facts. Absolute and relative thresholds avoid noisy warnings on small databases while still
surfacing material issues; standard PostgreSQL `VACUUM` is described as internal reuse, and host
disk reclamation as a separately planned compaction/rebuild operation.
The session-only `database.overview` query grants no backup, restore, compaction, vacuum, or
maintenance authority. The six Kopia/WAL-G status/control inventory rows and later database
backup/restore workflows remain separate capability, worker, audit, and recovery boundaries.

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

| Query shape                    | Index or constraint                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Session lookup                 | unique `auth_sessions(validator_hash)`                                                                                                       |
| Session expiry cleanup         | `auth_sessions(expires_at_ms)`                                                                                                               |
| User credentials               | `user_webauthn_credentials(user_id, created_at, id)` and unique credential ID                                                                |
| WebAuthn challenge             | unique partial binding/purpose indexes plus `(expires_at, id)` cleanup                                                                       |
| Automation principal history   | `automation_principals_created_id_idx` plus `automation_principals_active_created_id_idx`                                                    |
| Automation credential history  | `automation_credentials_principal_created_idx`                                                                                               |
| Active automation credentials  | partial `automation_credentials_active_principal_created_idx` while unrevoked                                                                |
| Staged credential rotation     | full `automation_credentials_replacement_idx` plus a unique partial replacement index                                                        |
| Task board                     | `tasks(status, priority, updated_at_ms DESC)`                                                                                                |
| Task label filter              | `task_labels(label, task_id)`                                                                                                                |
| Task timeline                  | `task_updates(task_id, created_at_ms, id)` and equivalent event index                                                                        |
| Agent task history             | unique active-agent partial index plus `(agent_id, started_at_ms, id)`                                                                       |
| Latest reports                 | `reports(kind, occurred_at_ms DESC, id DESC)`                                                                                                |
| Heartbeat stream               | `reports(source, source_job_id, occurred_at_ms DESC, id DESC)`                                                                               |
| Active incidents               | partial `incidents(monitor_key, last_seen_at_ms DESC) WHERE state = 'active'`                                                                |
| Incident identity              | unique `incidents(monitor_key, fingerprint)`                                                                                                 |
| Unread notifications           | partial `notifications(occurred_at_ms DESC) WHERE read_at_ms IS NULL`                                                                        |
| Incident notification          | unique `(incident_id, incident_generation, channel)` when incident is non-null                                                               |
| Queue claim                    | partial `job_runs(available_at, priority DESC, queued_at, id) WHERE state = 'queued'`                                                        |
| One active scheduled run       | unique partial `job_runs(scheduled_job_id) WHERE state IN ('queued', 'running')`                                                             |
| Active action status           | partial `job_runs_action_active_idx`; exact predicate below                                                                                  |
| Terminal maintenance status    | partial `job_runs_action_payload_terminal_idx`; exact predicate below                                                                        |
| Terminal Service Action status | partial `job_runs_service_action_terminal_idx`; exact predicate below                                                                        |
| Worker expiry                  | `worker_instances(heartbeat_at, id)`                                                                                                         |
| Job timeline                   | `job_run_events(job_run_id, sequence)`                                                                                                       |
| Realtime catch-up              | `realtime_events(topic, id)`                                                                                                                 |
| Chat replay                    | unique `chat_run_events(chat_run_id, sequence)`                                                                                              |
| Delivery production history    | partial `job_runs_delivery_production_history_idx` on `(action_key, updated_at DESC, id DESC)` where `action_key = 'delivery.production.v1'` |
| Cache refresh/expiry           | `cache_entries(last_attempt_status, expires_at_ms, key)`                                                                                     |
| Audit cursor                   | `audit_events(occurred_at_ms DESC, id DESC)` plus request/target indexes                                                                     |

The action-status indexes intentionally mirror the repository's literal predicates:

- `job_runs_action_active_idx` indexes `(action_key, state DESC, queued_at DESC, id DESC)`
  where `state IN ('queued', 'running')`. Maintenance payload equality is filtered after
  this globally single-flight action lookup.
- `job_runs_action_payload_terminal_idx` indexes
  `(action_key, payload_json, queued_at DESC, id DESC)` where
  `action_key = 'maintenance.rotate-logs'`, `length(CAST(payload_json AS BLOB)) <= 128`,
  and `state IN ('cancelled', 'failed', 'succeeded', 'timed-out')`.
- `job_runs_service_action_terminal_idx` indexes
  `(action_key, queued_at DESC, id DESC)` where `action_key` is one of the six fixed
  Service Action keys, `payload_json = '{}'`, and
  `state IN ('cancelled', 'failed', 'succeeded', 'timed-out')`.

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

Post-cutover delivery uses the implemented snapshot/promotion protocol for forward migrations:
quiesce writers, acquire the deployment lease, create and verify a WAL-safe snapshot, apply to a
copy, and atomically promote the matching release/database pair. Web and worker executable roots
may start concurrently, but only activation owns that protocol while the other process waits with
a bounded deadline and validates the final schema. Neither process may contain
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

Docker follows that split without another daemon or systemd unit. The worker owns Engine and
Compose discovery, the exact mutation and updater adapters, and one protected local Unix broker
inside the existing worker lifecycle. The web side of that broker can request only a bounded,
redacted log tail or a source-fenced prune preview; the frame schemas contain no command, shell,
path, environment, free-form Docker/Compose argument, or mutation operation. The broker validates
its canonical `0700` directory and `0600` socket, enforces connection/frame/deadline bounds, and
returns only classified `conflict`, `not-found`, or `unavailable` failures. The production web
unit additionally makes `/run/docker.sock`, `/var/run/docker.sock`, and `/opt/docker` inaccessible;
membership in the host Docker group therefore does not give the web process a parallel direct path.

Every Docker mutation is a recent-MFA, audit-first, actor/idempotency-bound durable job tied to the
current cache source revision. The worker accepts only the fixed operation union: exact container
start/stop/restart, canonical root-stack start/stop/restart, exact unused image/volume deletion,
ticket-bound prune execution, updater scan/run, or one exact updater-service identity. It executes
Docker through fixed `/usr/bin/docker` argv and Compose only through the fixed Doppler wrapper;
there is no Docker-specific generic exec API. Interactive operator work reuses the separately
bounded Terminal lifecycle. The updater may write only a discovered canonical per-app Compose file
beneath `/opt/docker`, replaces only its verified image-scalar byte range, validates the root
project, and gives the Git adapter only the exact changed paths and hashes. Uncertain Compose, Git
commit, or push settlement remains explicit and cannot authorize replay.
Before applying an image change, the updater binds rollback material to the exact running image ID,
not merely the prior mutable tag. Rollback rebinds that tag locally, recreates with pulling disabled,
and verifies both Compose source and runtime identity before reporting recovery; otherwise the
outcome remains unknown.
The Git adapter accepts only the configured `github.com` HTTPS upstream, disables system/global
Git configuration, credential helpers, prompts, SSH, hooks, and ambient home credentials, and
requires an authenticated remote read plus dry-run push before Compose mutation. The worker-only
GitHub credential is injected only as a scoped Git process-environment HTTP header; it is never an
argument, payload, log field, cache value, or browser value.

Delivery has two non-interchangeable worker-only GitHub authorities. The ordinary port verifies
the token actor as `mira-2026` and owns bounded reads plus provider-guarded ordinary merge/update
and exact-main Git operations. The reviewer port verifies `rajohan` and exposes only exact-commit
review approval. Missing reviewer authority disables that one capability; it never falls back to
Mira, `GH_TOKEN`, `GITHUB_TOKEN`, anonymous access, a credential helper, or ambient home
configuration. GitHub's native stack create/merge and pull-request close APIs cannot bind the
complete admitted head scope, so those capabilities are advertised as `head-guard-unavailable`
and never dispatch. Neither token enters a Job payload, cache row, operation receipt, process
argument, log, or browser response.

Trusted PR preview code runs in one bounded global slot beneath a transient systemd/Bubblewrap
boundary with a private network namespace, read-only source/Git administration, isolated writable
state, frozen dependency installation with lifecycle scripts disabled, and a four-hour maximum
lifetime. It receives no Doppler, GitHub, Docker, production-database, project-state, or host
credential authority. A worker-owned `0600` Unix broker exposes only the fixed bounded Gateway
capability, and Tailscale Serve owns only the exact preview route. Stop retains the managed
worktree/state while the PR stays open; descriptor-, mount-, inode-, owner-, and exact-head checks
gate permanent removal after confirmed close or merge.

Production cutover crosses worker generations through a bounded `delivery.production.v1` capsule
and terminal receipt in the protected production state directory. The immutable transient
executor receives only the exact project root, transition identity, readiness endpoint, release,
and runtime tuple through fixed arguments and `env -i`; worker/GitHub/Doppler/Gateway secrets and
ambient home state are inaccessible. The receipt is retained for every still-restorable paired
snapshot so a restored database can rehydrate and settle the exact original Job without replaying
the external effect.

Service Actions are a separate fixed-intent boundary, not a generic exec facade. The contract
contains exactly `openclaw-cleanup`, `openclaw-restart`, `openclaw-update`, `system-cleanup`,
`system-restart`, and `system-update`; a caller can supply only one of those IDs plus an actor-bound
idempotency key.
Reads and requests are session-only under dedicated capabilities, requests require recent MFA, and
audit attempt must commit before the durable enqueue handoff. That handoff rechecks exact-release
worker availability, the current browser session, and recent MFA. Enqueue uncertainty is
reconciled by the same principal/idempotency intent, and post-dispatch uncertainty never authorizes
a replay.

The production worker advertises only actions for which its composition owns an exact executor.
OpenClaw cleanup and update are worker-only, fixed-parameter Gateway operations with bounded,
sanitized results. OpenClaw restart reuses the existing fixed `openclaw.gateway.restart` worker
definition, executor, and provider already used by Settings; its `host.mutation` plus
`openclaw.gateway` resource locks serialize it with both host maintenance and other Gateway
mutations. Host cleanup, restart, and update have one separately provisioned fixed broker
whose only input is the reviewed operation ID and whose only output is an accepted/completed
status. The root-owned units use fixed paths, fixed arguments, bounded output and deadlines, and no
shell or caller-controlled environment. Manifest-bound provisioning validates no-follow file
identity, ownership, modes, and content integrity and retains explicit rollback to the previous
immutable release. The root-installed system topology now keeps the trusted production owner as
the worker principal and runs web under the dedicated `mira-dashboard-web` UID. A root-owned fixed
launcher creates only reviewed id-mapped path mounts inside web's private namespace and then drops
all UID, group, and capability authority. Web cannot see Docker or system-manager IPC. The exact
polkit policy binds the worker identity to the three host units and two Dashboard units; arbitrary
units and verbs remain denied. Production therefore composes the fixed broker.

`system-cleanup` attempts all fixed phases and fails if any phase fails: package autoremove,
package-cache cleanup, journald rotation plus 14-day/1 GiB retention, and Docker system prune for
unused content older than 168 hours. It never prunes volumes. The durable definition is exclusive,
single-attempt, non-cancellable, non-retry-safe, and reserves both `host.mutation` and `host.logs`.
Together with the bounded PTY, this defines the implemented narrow replacement for the consumed
`POST /api/exec/start` behavior without reintroducing a generic shell, command, path, or
shared-user privilege grant. Root-unit manifest verification and the live identity smoke must pass
before activation completes.

The `cache:read` automation heartbeat v5 is a separate sanitized projection, not a shortcut around
session, task, job, or cron detail authorization. It reads process-local validated Gateway
summaries plus bounded payload-free cache status and purpose-built SQLite task/Dashboard-job
projections, and requires neither `tasks:read` nor `jobs:read`. Its only upstream work is a
fixed read-only OpenClaw-cron inventory refresh with an aggregate deadline, atomic snapshot checks,
single-flight ownership, success TTL, and failure backoff.
Task content, assignee and cron identity, schedule metadata, payloads, results, events, actors,
workers, leases, credentials, endpoints, disable reasons, terminal messages, and raw failures do
not cross the boundary. Backup, database-maintenance, Docker health/update, logs, Git, quota, host
capacity, and weather leaves carry only fixed conditions and freshness clocks. Every optional
provider leaf is validated and contained separately; malformed or failed providers cannot erase
unrelated signals. Exact task count/truncation and the canonical row prefix share one short read
transaction that closes before Gateway I/O. Each local projection is structurally and semantically validated inside its own
safe reader boundary, so failure degrades only that projection to `unavailable`. Missing and
last-known-good Gateway states remain explicit so an empty count is never inferred from
unavailable upstream state.

The matching external consumer has no generic Dashboard transport. One immutable, release-bound
wrapper admits only `collect` and `report`: `collect` performs one `cache.getHeartbeat` query and
requires schema v5; `report` accepts one bounded, strict complete monitoring snapshot over stdin
and performs one `monitoring.submitCompleteSnapshot` mutation. It reads the existing credential
through `O_NOFOLLOW`, exact `0600` mode and current-owner checks, permits only loopback HTTP, rejects
redirects, bounds and fatally decodes response bytes, and collapses transport/provider/validation
failure to one fixed secret-free error. The automation principal therefore needs exactly
`cache:read` and `monitoring:write`; the legacy `reports:write` grant is removed at coordinated
cutover. The current live `HEARTBEAT.md` is not modified ahead of that cutover: its schema-v5
replacement is an immutable provisioning artifact installed atomically only after target readiness
and restored from the previous release on rollback.

Queue behavior is explicit:

- a strict singleton `job_worker_control` row persists cross-process claim pause state and
  versioned operator changes; its absence is an integrity failure, never an implicit resume;
- the separate singleton `host_restart_claim_fence` is armed atomically only when its exact
  `host.system.restart` lease is the sole globally running run; every worker refuses new claims
  while that fence is unexpired for the kernel-owned Linux boot identity;
- after dispatch begins, an error or lost response cannot prove that `systemctl --no-block` failed
  before accepting the reboot timer, so both accepted and ambiguous outcomes retain the fence; a
  changed boot identity removes it, and bounded same-boot expiry restores admission if reboot
  never occurs;
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
  restore, Service Actions, Docker mutation, and security administration;
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

- Doppler or systemd credentials remain the source for infrastructure secrets. The production web
  unit never receives a reusable Doppler credential: its manifest-installed root launcher keeps
  the operator's `0700` Doppler directory non-id-mapped, validates its owner and mode, requests only
  the fixed web allowlist, verifies the dropped web principal cannot read or traverse the
  credential, then unmounts it and proves its credential file absent before starting Bun.
  Worker-only GitHub, Docker, database, and provider secrets
  therefore cannot be fetched through a compromised web process.
- PostgreSQL/PgBouncer observability uses a distinct Doppler-provided observer password. Existing
  stack-wide `DATABASE_USERNAME`/`DATABASE_PASSWORD` values are never a runtime fallback, and the
  worker never receives an application role, PgBouncer admin role, or PostgreSQL superuser. A
  PgBouncer SCRAM verifier is credential material even when stored in a private repository: the
  current tracked `/opt/docker/apps/pgbouncer/userlist.txt` must be replaced by a non-versioned,
  runtime-provisioned auth input with least-readable permissions, followed by credential rotation
  and a redaction-safe authentication smoke test before cutover. No auth-file content, resolved
  Compose secret, or credential value may enter Dashboard state, logs, artifacts, or browser data.
- A secret that must be editable through Dashboard is stored in `secret_envelopes` using a
  versioned AES-GCM envelope whose master key never enters SQLite.
- Configuration APIs return presence/status metadata, never recoverable secret values.
- OpenClaw settings never return the raw Gateway configuration document. The session-only read
  contract projects bounded redacted model, reset, heartbeat, tool, channel, canonical agent-level
  override, and skill fields; unknown or secret-bearing provider fields remain server-side. A
  configuration write accepts exactly one typed section or one agent/tool override, requires the
  current root hash and source-derived revision, re-reads authority, and constructs one narrow
  root-hash-CAS `config.patch` on the server. Include-owned sources and unverified or pending
  whole-candidate model normalization lock configuration writes. An enabled-only skill toggle uses
  the same revision preflight but dispatches one exact `skills.update` leaf on the latest
  configuration; this is deliberately last-writer-wins rather than an upstream CAS. Agent access
  never accepts raw policy arrays and configured-only skills never expose paths or install
  authority. Invalid configuration, incomplete affected sets, attempts to submit unprojected
  fields, and post-dispatch uncertainty fail closed. An uncertain skill write receives one bounded
  readback and is never replayed. Attempted audit must commit before the effect; session and
  recent-MFA authority are then revalidated at the actual post-handshake pre-dispatch boundary.
  Terminal audit metadata contains only the operation, a domain-separated target fingerprint, and
  classified settlement. No raw configuration, patch body, policy array, skill description,
  provider error, or host path enters audit or logs. The privileged web-side mutation FIFO retains
  at most sixteen active-plus-waiting operations and removes aborted waiters immediately.
- Generated docs include environment variable names, type, default behavior, and secret flag,
  but never runtime values.
- File and media operations resolve against named allowlisted roots, reject traversal, verify
  containment after symlink resolution, avoid following unsafe links, and enforce size/MIME
  limits before parsing or preview.
- Local-history media does not restore the legacy browser-supplied path boundary. Hash-pinned
  projection recognizes the bounded canonical and reviewed legacy transcript carriers, strips each
  recognized `MEDIA:` directive before browser delivery, and registers only an opaque non-path
  reference bound to the exact session, message, source slot, and normalized server-only locator.
  The stable 48-bit prefix is an unkeyed, non-secret routing hint rather than cryptographic opacity.
  The identifier is not a capability: every `GET` or `HEAD /api/chat/media/:attachmentId` request
  requires an authenticated principal with `chat:read`, reprojects the exact message through
  `chat.message.get`, verifies the same attachment URL, and opens no file until that authorization
  succeeds. A bounded history refresh can reconstruct the same association after process-local
  reference loss, but cannot widen it to another session or message. Refresh work is globally
  token-budgeted, class-cooled, serialized, capped at eight active-plus-waiting requests, and retains
  its work slot after a caller deadline until the provider operation actually settles.
- The local reader is descriptor-rooted beneath the exact
  `<MIRA_DASHBOARD_OPENCLAW_ROOT>/media` directory. It rejects traversal, network locations,
  symlinks, hardlinks, special files, cross-device nodes, unsafe ownership or modes, and file
  identity changes; it never returns a locator in browser data, response headers, errors, audit, or
  logs. Local bodies are capped at 16 MiB, text preview at 1 MiB, and SVG, HTML, unknown, or other
  active content remains download-only. The existing Chat media concurrency and in-flight-byte
  admission applies to both managed and local sources, with private/no-store responses and no
  listing or path-query operation.
- The Files and Terminal surfaces may share the explicit `MIRA_DASHBOARD_WORKSPACE_ROOT`. Files
  keeps descriptor-anchored containment for each operation. Terminal uses the same named root only
  to select the interactive shell's initial working directory: it is not a filesystem sandbox, and
  the shell may leave it wherever the worker's OS identity has access.
- Files' separate web-and-worker `MIRA_DASHBOARD_OPENCLAW_ROOT` is not a general recursive browser.
  Its descriptor adapter synthesizes only the directory prefixes needed to reach the exact reviewed
  `openclaw.json` and `hooks/transforms/agentmail.ts` manifest entries, verifies
  same-owner/same-device regular files, rejects links, world-writable nodes, and traversal, and
  redacts valid configuration JSON before default ticket creation or range selection. The two
  reviewed full-redaction/replacement entries have a 2 MiB write bound, while text preview remains
  capped at 1 MiB. An oversized reviewed source remains listable but read-only and exposes only a
  revision-stable prefix of at most 1 MiB with explicit truncation and source-size metadata; an
  oversized masked configuration prefix stays fail-closed until recent-MFA reveal. Invalid JSON
  publishes only safe listing metadata so the reviewed entry stays selectable; its masked preview
  fails closed without returning bytes. Raw configuration is available only through an explicit
  recent-MFA mutation and a short-lived actor-bound no-store ticket, which lets the operator inspect
  and repair invalid JSON. The browser keeps raw content out of Query caches, and config replacement
  validates that same reveal ticket and exact revision before requesting the raw descriptor view.
  Upload tickets inherit a server-only content policy from the reviewed manifest node. A bounded
  streaming matcher rejects the redaction sentinel even across body chunks for both manifest
  entries, removes any partial spool, and stops before job enqueue; ordinary workspace content is
  not subject to that manifest-only rule. The worker receives the root only as a
  descriptor-anchored replacement manifest for those two exact existing files, with bounded size,
  CAS, ownership/mode checks, fsync, and atomic exchange. Each successful reviewed replacement
  atomically publishes the exchanged old inode as the exact hidden sibling `.bak`, preserving its
  bytes and mode as one rolling backup; descriptor-anchored recovery finishes that publication
  idempotently after interruption. Both targets must exist before cutover: replacement-only
  authority does not repair or create a missing file. It cannot create, delete, rename, or replace
  any unreviewed OpenClaw path through the Files job protocol. Atomic exchange creates a private
  stage file beside the target, so the worker unit deliberately retains its prior writable OpenClaw
  namespace rather than claiming an exact-file systemd exception that Linux VFS cannot enforce; the
  descriptor manifest is the write boundary.
- The exact OpenClaw configuration export is not a database or host backup. A session-only,
  recent-MFA procedure reads only descriptor-anchored `openclaw.json` and returns an opaque
  actor/authenticator-bound ticket, never the secret bytes. Its same-origin raw route is
  private/no-store, permits metadata-only `HEAD`, consumes `GET` once, and applies both stored-byte
  capacity and live transfer concurrency/byte admission. The descriptor adapter zeroes its read
  result after producing a caller-owned source copy; ticket issue synchronously copies that source,
  the service zeroes its copy on every outcome, and consumption transfers the stored copy to the raw
  handler for immediate zeroing after it creates a stream-owned copy. Ticket expiry, transfer
  completion or cancellation, and shutdown zero every retained byte buffer. Raw configuration is excluded from tRPC,
  browser caches, audit, logs, provider errors, and job state.
- Gateway restart is a distinct durable worker action. Fail-closed audit and recent-MFA/session
  authority must both succeed before enqueue; an idempotency-key readback reconciles ambiguous
  repository settlement. The action holds the exclusive resource class, has one attempt, is not
  retry-safe or cancellable, and invokes a fixed argv without a shell or captured output. Unknown
  enqueue or process completion never causes an automatic second restart.
- Dashboard's worker-owned rotation engine uses an exact reviewed per-file manifest for Dashboard,
  OpenClaw, and managed application/container logs rather than treating a directory as a recursive
  wildcard. Ubuntu system logrotate remains responsible only for the exact `rsyslog`, `apport`,
  `dpkg`, and `alternatives` policies through a fixed worker broker. Both paths exclude journald
  storage, binary login/audit databases, sockets, devices, hardlinks, and symlink escapes.
  The web and worker units retain `PrivateTmp=true`; when the optional host `/tmp/openclaw`
  directory exists, it is mounted read-only into web and writable into worker so private temporary
  namespaces cannot silently hide the reviewed OpenClaw source or prevent its worker-owned
  retention policy. A fresh host where that optional source does not yet exist still starts both
  units.
- Markdown and HTML are sanitized at the rendering boundary. A raw HTML feature is not an
  authorization boundary.
- Terminal, Service Actions, Git, Docker, systemd, backup, restore, and OpenClaw adapters each have
  a command/operation allowlist and a structured audit record. No generic exec adapter is retained.
- Logs and audit details pass a central redactor before persistence and again before browser
  output.
- CSP, frame denial, MIME-sniff prevention, referrer policy, permissions policy, and request ID
  headers are set centrally for frontend and API responses.
