# Database observability provisioning

These files define the approval-gated least-privilege boundary for PostgreSQL and
PgBouncer. Source builds, release builds, tests, and application startup inventory them but
never execute them. Production execution requires explicit approval, a reviewed clean release,
an approved database-admin session, a current backup, and a tested rollback window.

## Dynamic authority boundary

- PostgreSQL's live catalog is the database membership source. The runner discovers every
  `datistemplate=false` and `datallowconn=true` database, sorts it by name, and fails closed
  above 64 databases. There is no database-name allowlist or per-name command sequence in
  source or the manifest. A newly created database is therefore discovered without a Dashboard
  source/config change. PostgreSQL's default `PUBLIC` ACL is unsafe and the sanitized functions
  are initially absent, so the database does not enter a fresh observation until the existing
  hourly `cache.refresh.database-observability` job opens its configured privileged collection
  lease and completes its mandatory full reconcile.
- `mira_dashboard_observability` is both the code-owned PgBouncer control alias and a dedicated
  same-named physical PostgreSQL database created from `template0` by the approved provisioning
  artifact. PgBouncer's existing wildcard database route preserves the client database name, so
  the alias reaches that physical database without an explicit mapping, environment interpolation,
  or second Docker label. The control database is included in the same catalog-derived inventory,
  but it is a code-owned capability rather than an application-database allowlist entry.
- `mira_dashboard_observer` is the statistics login. It has zero role memberships, read-only
  transactions, a five-second statement timeout, and a topology-independent PostgreSQL connection
  ceiling of 64. Its PostgreSQL authority is direct `CONNECT` to the current bounded inventory,
  `USAGE` on the exact private capability schema, and `EXECUTE` on the exact sanitized functions.
  The optional Comet/Bitmagnet count views are the only separate `SELECT` exception. Database-
  scoped role settings, inbound memberships, unsafe membership options, unrelated object grants,
  effective user-schema `SECURITY DEFINER` execution, and future default-ACL authority all fail
  verification. Ordinary `PUBLIC` invoker routines are not rejected.
- `mira_dashboard_observability_capability_owner` is an isolated `NOLOGIN` role. Its sole direct
  role membership is `pg_read_all_stats`, and its sole additional statistics relation authority in
  each provisioned database is direct `SELECT` on `pg_catalog.pg_statistic`. Those broad sources
  never become observer authority. They are reachable only while the four exact no-input,
  bounded, fixed-search-path `SECURITY DEFINER` functions execute: `connection_metrics()` and
  identity-free `statement_metrics()` in the control database, plus `table_health()` and
  `maintenance_metrics()` in every observed database. The observer receives only schema `USAGE`
  and function `EXECUTE`.
- A full privileged reconcile runs through the exact immutable-release Bun runner and its pinned,
  scrubbed, container-local administrative psql boundary. It quotes every live catalog identifier,
  rejects more than 64 observed or 80 total catalog entries before mutation, removes every
  database privilege from `PUBLIC`, and grants the observer direct `CONNECT` only to live
  non-template connectable databases. Database owners retain implicit
  `CONNECT`/`CREATE`/`TEMP`; every non-owner application login must have reviewed explicit
  privileges before this change is applied. No dedicated reconciler login or function-executor
  credential exists.
- The control apply resolves the upstream `pg_stat_statements` extension objects from PostgreSQL
  catalogs, revokes the raw source views and extension routines from `PUBLIC` and the observer, and
  grants the capability owner only the exact raw routine execution needed internally. Its
  `statement_metrics()` function calls `pg_stat_statements(false)` and exposes at most 20 rows with
  calls, execution time, rows, and block metrics. It returns no database/user identity, query text,
  `queryid`, or other reversible statement identity. Exact routine shape, source body, dependency,
  owner, source ACL, schema ACL, and output columns all fail closed on drift. Review compatibility
  before applying because principals that relied on stock `PUBLIC` access lose that raw access.
- `bitmagnet` and `comet` are the sole named application exceptions. Their optional owner-rights
  `torrent_count` views live in those application databases and remain independent of the fixed
  control database. No other application, database, container, service, project, or port name is
  built into this provisioning set.
- PgBouncer must list `mira_dashboard_observer` in `stats_users`, exclude it from
  `admin_users`, and apply exactly `pool_size=1`, `reserve_pool_size=0`,
  `max_user_connections=64`, and `max_user_client_connections=2`. Its existing wildcard route
  exposes the same-named physical
  `mira_dashboard_observability` database, and the container carries only
  `mira.dashboard.database-observability=pgbouncer-psql-v1` for endpoint discovery. The capability
  contract requires `/bin/sh` and `psql` in that container. PostgreSQL's
  matching 64-backend role limit is the final cap.

The existing hourly `cache.refresh.database-observability` job owns one bounded collection lease.
If and only if the database-observability provider is configured, that same action composes a
separate worker-only privileged collection-lease port around the observer collector. The port
spawns the exact Bun runtime and fixed `open-approved-collection`,
`enable-approved-collection`, and `close-approved-collection` modes from the immutable current
release; it accepts no
caller-selected command, argument, path, database, SQL, or credential. There is no additional job
action, schedule, systemd unit, polling loop, sidecar, PostgreSQL login, or exclusive-admission
mechanism.

Between attempts, `mira_dashboard_observer` must be `NOLOGIN`, its `VALID UNTIL` must already be
expired, and PostgreSQL must report zero observer sessions. One configured hourly attempt has this
fixed order:

1. the privileged boundary closes leftovers by setting `NOLOGIN`, expiring `VALID UNTIL`,
   invalidating any prepared collection token, terminating observer sessions, and rechecking that
   exact closed state;
2. `open-approved-collection` verifies the approval and identities, performs the full bounded,
   idempotent ACL-and-capability reconcile, keeps the observer `NOLOGIN`, and prepares one random
   one-use token bound to the exact catalog digest. A drifting application database is quarantined
   by revoking observer `CONNECT`, so its catalog row remains visible with unavailable details;
3. `enable-approved-collection` rechecks approval, policy, Docker/PostgreSQL identity, and the
   exact catalog digest, then atomically consumes that token and sets `LOGIN` plus a short
   `VALID UNTIL`;
4. the least-privilege observer collector runs once;
5. a shielded mandatory close, with a cleanup signal independent of caller cancellation, restores
   `NOLOGIN`, expires `VALID UNTIL`, terminates sessions, and proves the closed state again; and
6. only after that proof may the lease return the fresh payload to the generic cache executor,
   which performs the cache commit afterward.

The local runner is supervised by a Linux parent-death signal and an isolated process group; abort
uses bounded `TERM` then `KILL` and waits for the group to be reaped. The PostgreSQL one-use token
is the authoritative fence for Docker-daemon work: close invalidates it under the same advisory
lock used by enable, so a delayed old psql cannot reopen the observer after close.

Explicit `activate-current-catalog` is the only operation allowed to create or refresh the
administrative approval binding. The marker is stored in
`mira_dashboard_observability_control.reconciliation_approval` and binds the exact
`pg_control_system().system_identifier` plus the exact current and previous immutable-release
policy digests. `sanitized-capabilities-v1` remains descriptive metadata and is never sufficient
authorization by itself. Lease operations may read but never create or update that approval.
Every open reapplies and verifies the exact database ACLs and sanitized capabilities, rechecks the
bounded catalog, and rejects approval, policy-digest, identity, or endpoint races before a token is
prepared. Cluster and control drift fail the attempt. Application-database drift revokes observer
`CONNECT` for that database and lets the remaining bounded inventory collect; the next open retries
full reconciliation. There is no persisted fingerprint, verification-age state, or reduced path.

Administrative authority terminates at the collection-lease port and its scrubbed
container-local psql boundary; the collector and its observer credential never receive it. Any
open, collection, or close failure settles the attempt as a retryable failure with one generic
redacted reason, preserves the last-known-good cache, and prevents a fresh payload or cache commit.
Fresh cache state therefore always proves that mandatory cleanup succeeded. Logs and durable job
output never contain database names, provider output, credentials, resolved Compose configuration,
or raw administrative errors.

The PostgreSQL close proof cannot prove that PgBouncer has no already-authenticated client waiting
for a server connection; PgBouncer admission is not transactionally coupled to the role-state
change. This design deliberately adds no exclusive-admission surface. Once close succeeds,
`NOLOGIN`, expired `VALID UNTIL`, and terminated PostgreSQL sessions prevent such a waiting client
from obtaining a new backend. If a waiting client interferes with open or close verification, the
attempt fails closed, retains last-known-good, and retries on the existing schedule.

## Tracked PgBouncer verifier risk

The private Docker repository currently tracks `/opt/docker/apps/pgbouncer/userlist.txt`. Its
SCRAM verifier is credential material even though it is not a cleartext password: repository access
and Git history extend its lifetime and permit offline guessing of a weak password. Before final
production cutover, replace it with a runtime-generated or equivalently secret-mounted,
non-versioned PgBouncer auth input, restrict it to `0600`, and rotate the affected PostgreSQL
credential after a rollback-capable authentication smoke test. History rewriting is a separate
destructive decision; rotation makes the retained historical verifier obsolete. Never print the
file, resolved Compose configuration, or secret values while validating the cutover.

## Approval-gated apply and activation

Never put a password, connection URL, SCRAM verifier, or other credential in this repository,
argv, shell history, CI output, or logs. The runner discovers the one healthy opted-in PgBouncer
Compose service and the one healthy local PostgreSQL service declared by its exact
`mira.dashboard.database-observability.postgres-service` label through a fixed, projected Docker
inventory. It pins the local Docker socket, root Compose file/project directory, observed project,
service index, OS user, local PostgreSQL socket, and container-local `/usr/local/bin/psql`. A fixed
`env -i` launcher carries only the existing non-secret `POSTGRES_USER`; it discards every other
container and host variable, including password and endpoint variables. SQL is expanded only from
bounded, descriptor-pinned files in the immutable artifact directory and sent over bounded stdin.
Every connection rechecks the probed superuser role OID and PostgreSQL system identifier before
SQL runs. The runner accepts no caller path, SQL text, database list, endpoint, or secret argument.

Run cluster, activation, disable, and rollback SQL with psql `AUTOCOMMIT` on and no active
outer transaction. Do not use `psql --single-transaction` or `-1`. The committed NOLOGIN and
password-null quarantine intentionally survives any later verification failure.

1. Inventory every non-owner application login that currently relies on `PUBLIC CONNECT` or
   `PUBLIC TEMP`, grant only its reviewed direct requirement, and test it. Full reconciliation removes
   all `PUBLIC` database privileges cluster-wide; do not proceed until that narrowing is safe.
2. Apply `apply-cluster.sql` through an approved administrative database. It creates or quarantines
   the observer, namespace owner, and isolated capability owner; gives the observer zero
   memberships; gives the `NOLOGIN` capability owner exactly `pg_read_all_stats`; terminates
   reserved sessions; and establishes the role-only boundary while the observer remains disabled
   and credential-free.
3. With psql autocommit enabled, apply `apply-control-database-capability.sql` through that
   administrative connection with
   `--set=apply_control_database_capability=approved`. `CREATE DATABASE` runs outside a
   transaction, is idempotent, and creates or validates exactly the `template0`-derived physical
   `mira_dashboard_observability` database before any database-local provisioning.
4. Set the observer password interactively with psql `\password`; never paste it into a SQL file
   or argv. Keep the observer `NOLOGIN`.
5. Apply `apply-database-capabilities.sql` to every database in the current bounded catalog. It
   grants the capability owner direct `SELECT` on `pg_catalog.pg_statistic`, installs the exact
   `table_health()` and `maintenance_metrics()` functions, and grants the observer only their
   `EXECUTE` boundary. In the fixed control database, then apply `apply-control-database.sql` with
   `--set=apply_statement_capability=approved`. It installs or updates `pg_stat_statements`, revokes
   raw extension relation/routine access from `PUBLIC` and the observer, and adds the sanitized
   `connection_metrics()` and identity-free `statement_metrics()` functions. The activation
   runner applies and verifies `apply-torrent-view.sql` in the exact `bitmagnet` and `comet`
   databases when present. It reconciles the count-only view while rejecting unrelated objects
   or an incompatible object at that name in the private schema.
6. Configure PgBouncer's exact observer policy and single capability label. The existing wildcard
   route needs no alias mapping or database environment variable. Compose the separate privileged
   collection-lease port into the existing hourly `cache.refresh.database-observability` executor,
   but do not add a second action, schedule, unit, loop, sidecar, login, or exclusive admission.
   Provider absence must skip the port entirely.
7. On the first installation, run the immutable current release with the exact selected production
   Bun runtime and `activate-current-catalog`:

    `/home/ubuntu/projects/mira-dashboard/production/runtimes/bun/current/bun /home/ubuntu/projects/mira-dashboard/production/releases/current/scripts/delivery/provisioning/database-observability/runProvisioning.ts activate-current-catalog --approved`

    This is the first runner operation after the manual prerequisites because
    `verify-current-catalog` requires an existing matching approval. The runner first
    idempotently revalidates the physical control capability, reconciles ACLs, applies and
    re-verifies the four sanitized interfaces and their underlying source revocations, verifies
    every discovered database and the activation approval boundary, and re-reads the full bounded
    catalog fingerprint to reject add/remove/rename/template/connection-flag races. Only explicit
    activation may create or refresh the approval binding to the current PostgreSQL system
    identifier and the exact current and previous immutable-release policy digests. It must finish
    with the observer `NOLOGIN`, expired, and with zero PostgreSQL sessions.

8. After reviewing activation, run the same command with `verify-current-catalog`. This verifies
   the approved cluster, capability-owner authority, exact source revocations, sanitized function
   shapes and ACLs, and every database in one bounded catalog snapshot without enabling `LOGIN` or
   installing a missing capability. On later releases, verification may run before activation only
   when the retained approval already covers that release through its exact current or previous
   policy digest. If neither digest is approved, explicit activation must run first.
9. Use one approved collection lease for the smoke check. Through PgBouncer's `pgbouncer` virtual
   database, prove only the expected `SHOW POOLS` and `SHOW STATS` operations succeed. Confirm no
   more than one retained observer backend per database and no more than 64 total, with at most two
   observer clients, then require the mandatory close proof before accepting the smoke result.
10. Enable the worker provider configuration only after that smoke check passes. On its next
    ordinary hourly run, confirm the existing cache job closes leftovers, opens the approved short
    lease, collects through the observer, proves mandatory close, and only then lets the generic
    executor commit bounded sanitized output.

## Fail-closed rollback

On any activation/smoke-check failure immediately run `disable-observer.sql` against
`mira_dashboard_observability`. It commits `NOLOGIN`, clears the observer password, and terminates
observer sessions. For full rollback: disable the worker provider configuration; disable the
observer; remove the reconciliation approval marker with
`rollback-reconciliation-approval.sql`; run optional
`rollback-torrent-view.sql` in `comet` and `bitmagnet` where installed; run
`rollback-control-database.sql`, then `rollback-database-capabilities.sql` in every provisioned
database; remove the PgBouncer policy; then run `rollback-cluster.sql` and finally
`rollback-control-database-capability.sql` in the retained control database. The access rollback
removes dedicated observer database grants but deliberately does not recreate unknowable broad
`PUBLIC` grants; restore reviewed application ACLs explicitly. The capability rollback verifies
that only reviewed extension objects remain and deliberately retains both the physical database
and `pg_stat_statements`; it never issues `DROP DATABASE` or guesses whether acquired data is
disposable. No rollback drops an application table or database.
