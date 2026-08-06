# Greenfield Rewrite Data and Security

[Back to the blueprint map](../greenfield-rewrite.md)

## Database Design

### Core rules

- Create `new Database(path, { create: true, strict: true })` through `bun:sqlite`, retain that
  native client, and pass the same client into `drizzle({ client })`. Drizzle v1 RC's current
  Bun driver no longer accepts the legacy `schema` option; add its explicit `relations` model
  only for domains that use the relational query API.
- Enable foreign keys, WAL, a measured busy timeout, and explicit synchronous/checkpoint
  policy at process startup.
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
reviewed TypeScript schema, and that SQL is reviewed and tracked. Dashboard's migration runner
still verifies immutable checksums, snapshots the database, serializes web/worker startup,
applies the SQL, and runs integrity checks. `drizzle-kit push` is forbidden in production.

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
| Scheduling/work      | `scheduled_jobs`, `job_disable_intents`, `job_runs`, `job_run_events`, `worker_instances`, `resource_leases`                                                                                                                                                                   |
| Chat                 | `chat_runs`, `chat_run_events`, `chat_runtime_snapshots`                                                                                                                                                                                                                       |
| Delivery             | `deployments`, `deployment_events`, `release_records`                                                                                                                                                                                                                          |
| Docker               | `managed_docker_services`, `docker_update_events`                                                                                                                                                                                                                              |
| External projections | `cache_entries`                                                                                                                                                                                                                                                                |

PostgreSQL, PgBouncer, OpenClaw sessions, Gateway history, host logs, files, GitHub, Docker, and
Moltbook remain external systems. Dashboard persists only configuration, bounded projections,
audit/history, job state, or recovery state that it owns. It does not mirror entire external
databases.

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

| Query shape              | Index or constraint                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------- |
| Session lookup           | unique `auth_sessions(validator_hash)`                                                  |
| Session expiry cleanup   | `auth_sessions(expires_at_ms)`                                                          |
| User credentials         | `user_webauthn_credentials(user_id, created_at, id)` and unique credential ID           |
| WebAuthn challenge       | unique partial binding/purpose indexes plus `(expires_at, id)` cleanup                  |
| Task board               | `tasks(status, priority, updated_at_ms DESC)`                                           |
| Task label filter        | `task_labels(label, task_id)`                                                           |
| Task timeline            | `task_updates(task_id, created_at_ms, id)` and equivalent event index                   |
| Latest reports           | `reports(kind, occurred_at_ms DESC, id DESC)`                                           |
| Heartbeat stream         | `reports(source, source_job_id, occurred_at_ms DESC, id DESC)`                          |
| Active incidents         | partial `incidents(monitor_key, last_seen_at_ms DESC) WHERE state = 'active'`           |
| Incident identity        | unique `incidents(monitor_key, fingerprint)`                                            |
| Unread notifications     | partial `notifications(occurred_at_ms DESC) WHERE read_at_ms IS NULL`                   |
| Incident notification    | unique `(incident_id, incident_generation, channel)` when incident is non-null          |
| Queue claim              | partial `job_runs(available_at_ms, priority DESC, queued_at_ms) WHERE state = 'queued'` |
| One active scheduled run | unique partial `job_runs(scheduled_job_id) WHERE state IN ('queued', 'running')`        |
| Worker expiry            | `worker_instances(heartbeat_at_ms)`                                                     |
| Job timeline             | `job_run_events(job_run_id, sequence)`                                                  |
| Realtime catch-up        | `realtime_events(topic, id)`                                                            |
| Chat replay              | unique `chat_run_events(chat_run_id, sequence)`                                         |
| Deployment history       | `deployments(state, updated_at_ms DESC)`                                                |
| Docker history           | `docker_update_events(managed_service_id, created_at_ms DESC)`                          |
| Cache refresh/expiry     | `cache_entries(status, expires_at_ms)`                                                  |
| Audit cursor             | `audit_events(occurred_at_ms DESC, id DESC)` plus request/target indexes                |

Primary keys and unique constraints already create indexes; the schema does not add redundant
copies. Partial-index predicates must match query predicates exactly enough for SQLite to use
them.

### Migrations, backup, and retention

Drizzle Kit v1 stores the migration graph as timestamped directories containing
`migration.sql` and `snapshot.json`. During the unpublished rewrite, `migrations/` contains exactly
one evolving `*_dashboard-foundation` baseline generated from the complete current Drizzle schema.
The generated SQL includes the security identity objects, SQLite `STRICT` table options, canonical
NUL-free constraints, and deliberate `audit_events WITHOUT ROWID` hardening. The custom audit
metadata and append-only triggers are reviewed additions because Drizzle does not model them.
There is no compatibility preflight or upgrade path for an intermediate rewrite database: every
test and the final cutover start empty and apply this one baseline. Each schema slice regenerates
the baseline, reviews the complete SQL/snapshot diff, and updates the explicit manifest checksums.
At cutover those bytes become immutable; later production schema changes are generated as new,
forward-only, checksummed nodes.

The snapshot files form Drizzle Kit's conflict-analysis DAG. Dashboard's runtime loader applies
the explicit manifest order after verifying valid 14-digit timestamp prefixes, unique full folder
names, lexicographic ordering, SQL checksums, snapshot checksums, and the absence of unreviewed
directories. After the raw bytes are verified, the runner trims only each statement's outer
whitespace before execution so Bun SQLite cannot mask a trigger abort behind a trailing `;\n`;
the checksummed source stays unchanged. `drizzle-kit check` must be green before release; stock
Drizzle name-based pending detection is not accepted as the integrity boundary.
Startup acquires a migration lock, creates and verifies a WAL-safe snapshot before a post-cutover
schema change, and rejects unknown or checksum-mismatched history.

Web and worker may start concurrently, but only one migrates. The other waits with a bounded
deadline and validates the final schema. Neither process contains table/column existence
fallbacks.

Retention is explicit per append-only table. A maintenance job removes bounded batches,
performs passive checkpoints during normal operation, exposes WAL/checkpoint health, and runs
expensive optimization only under a resource-scoped job. Backups include the database and its
release/schema identity and are restore-tested.

## Worker and Privileged Operations

The web process may perform bounded reads and lightweight Gateway interaction. It does not run
deploys, builds, Git mutations, Docker mutations, backups, restores, systemd changes, OpenClaw
restarts, or unbounded shell commands. Those operations become durable `job_runs` consumed by
the worker.

Queue behavior is explicit:

- a transaction claims one eligible run and assigns a lease;
- each run has an idempotency key, resource class, priority, timeout, attempt limit, and
  cancellation policy;
- the worker renews its lease and writes ordered progress events;
- expired leases can be recovered only when the action is declared retry-safe;
- resource leases prevent conflicting deploy, restore, Docker, or OpenClaw operations;
- cancel requests are persisted and propagated to the child process group;
- stdout/stderr are incrementally bounded, redacted, and spilled to a controlled log file when
  necessary; and
- final structured output is validated before persistence or display.

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

- first-user bootstrap verifies the OpenClaw Gateway credential before creating the user;
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

Session cookies are `Secure`, `HttpOnly`, `SameSite=Strict`, narrowly scoped, and never readable
by JavaScript. Unsafe browser requests require exact allowed Origin and Fetch Metadata before
authentication. Same-origin SSE uses the same session and never accepts a bearer token in a
query string.

### Automation identities

Each automation caller is a named principal with an explicit capability set and one or more
rotatable credentials. Tokens contain at least 256 bits of randomness, are shown or written to
the scoped client file once, and are represented in the database only by a versioned validator
hash and non-secret prefix. Comparison is constant-time. A TypeScript client cannot call a
procedure outside its principal's capability set even if it knows the procedure name.

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
- Markdown and HTML are sanitized at the rendering boundary. A raw HTML feature is not an
  authorization boundary.
- Exec, terminal, Git, Docker, systemd, backup, restore, and OpenClaw adapters each have a
  command/operation allowlist and a structured audit record.
- Logs and audit details pass a central redactor before persistence and again before browser
  output.
- CSP, frame denial, MIME-sniff prevention, referrer policy, permissions policy, and request ID
  headers are set centrally for frontend and API responses.
