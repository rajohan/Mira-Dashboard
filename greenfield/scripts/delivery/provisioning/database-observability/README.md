# Database observability provisioning

These artifacts define the least-privilege PostgreSQL and PgBouncer boundary used by
Dashboard database observability. A source build, release build, test run, or application
startup never executes them. Production use is a separate privileged transition that
requires explicit approval, a reviewed clean commit, a database-admin session, a current
backup, and a tested rollback window.

## Fixed authority

- `mira_dashboard_observer` is the only eventual login. Apply first quarantines it as
  `NOLOGIN` with a null password, terminates any same-named sessions, and refuses unexpected
  inbound or outbound memberships before granting anything. It is not an application role or
  a superuser. It has a one-connection limit, read-only transactions, a five-second statement
  timeout, direct membership only in `pg_monitor` and `pg_read_all_stats`, and `CONNECT` only
  to the ten databases listed in `manifest.json`. Only `activate-observer.sql` may enable login,
  after re-running every PostgreSQL database and view verifier.
- `mira_dashboard_observability_owner` cannot log in. In `comet` and `bitmagnet` it owns the
  private `mira_dashboard_observability` schema and the one-column, one-row
  `torrent_count` view. It receives only the base-table `SELECT` required for owner-rights
  view evaluation.
- The observer gets `USAGE` on that private schema and `SELECT` on the view. It gets no
  base-table `SELECT`, object creation, writes, or ownership. `PUBLIC` gets no authority on
  the private schema or view.
- PgBouncer must list the observer in `stats_users` and must not list it in `admin_users`.
  The only admitted administrative-database operations are the collector's fixed
  `SHOW POOLS` and `SHOW STATS` reads.
- The `postgres` control database must contain stock PostgreSQL 18
  `pg_stat_statements` version `1.12` in `public`. Both stock extension-owned views,
  `public.pg_stat_statements` and `public.pg_stat_statements_info`, must retain their exact
  extension dependency, superuser extension owner, reviewed column shapes, and stock ACL. The
  observer may only read them; the collector reads only the schema-qualified
  `public.pg_stat_statements` metrics allowlist and never selects query text.

## Approval-gated apply

Do not put a password, connection URL, or SCRAM verifier in this repository, a command-line
argument, shell history, CI output, or application log. Run `psql` from an already-approved
local database-admin session (for example peer authentication) and pass only database names
and reviewed file paths as arguments.

Run every cluster, activation, disable, and rollback artifact with psql `AUTOCOMMIT` on and with
no active outer transaction. Stop if `\echo :AUTOCOMMIT` does not report `on`. The committed
`NOLOGIN`/password-null quarantine intentionally precedes the later privilege transaction; an
outer transaction would defeat that fail-closed boundary. Do not use `psql --single-transaction`,
`-1`, or a wrapper that begins a transaction around these artifacts.

1. Compare `manifest.json` with the live PostgreSQL database inventory and PgBouncer
   database map. Stop if any connectable database is not listed.
2. Verify that `PUBLIC` does not give the observer effective `CONNECT` to `template1` or any
   unreviewed database, and that `PUBLIC` or inherited roles do not give it access to either
   `public.torrents` table. PostgreSQL privileges are additive: a direct revoke from the
   observer cannot override a `PUBLIC` grant.
3. If those shared ACLs are not already safe, prepare and approve a separate cluster ACL
   migration that restores every affected application principal before revoking `PUBLIC`.
   This repository deliberately does not automate that potentially outage-causing change.
   Also verify that stock `pg_stat_statements` version `1.12` is installed in `public` on
   `postgres`; the verifier rejects a relocated, upgraded, spoofed, or ACL-modified relation.
4. Apply `apply-cluster.sql` to `postgres` as a database administrator. Its first committed
   transition forces both reserved roles to `NOLOGIN`, clears the observer password, and
   terminates same-named sessions before the privilege transaction starts. If later
   qualification or exact-boundary checks fail, the observer remains disabled and
   credential-free. Do not continue until the cause is reviewed and corrected.
5. Set a new observer password interactively with psql's `\password` command for
   `mira_dashboard_observer`. The role remains `NOLOGIN`. Store only the resulting credential
   through the approved secret-manager flow. Never paste it into a SQL file or argv.
6. Prove that the `mira_dashboard_observability` schema is absent in both `bitmagnet`
   and `comet`, then apply `apply-torrent-view.sql` separately to each database. The
   apply is intentionally first-install-only and fails if the namespace already exists;
   verify an existing installation or roll it back before applying a replacement. This
   prevents pre-existing routines or types with ambient `PUBLIC` authority from being
   hidden behind the reviewed schema name.
7. Through the separately reviewed PgBouncer configuration workflow, add exactly
   `mira_dashboard_observer` to `stats_users`, prove it is absent from `admin_users`, update
   authentication without writing a secret to source, and perform the approved reload. Review
   the resulting configuration before activation; the disabled observer cannot yet run commands.
8. Run `verify-cluster.sql` against `postgres`, `verify-database.sql` against every exact
   database in `manifest.json`, and `verify-torrent-view.sql` against both `bitmagnet` and
   `comet`. `verify-cluster.sql` requires the observer to remain `NOLOGIN` while holding one
   fresh SCRAM password. These checks reject ambient create, temporary-table, schema-create, or
   base-table authority inherited through `PUBLIC` or another role.
9. From this artifact directory, run `activate-observer.sql` against `postgres` in the same
   approved local database-admin psql session. It reconnects to every reviewed database,
   re-runs every database and view verifier, re-runs the disabled cluster verifier inside the
   final transaction, and only then changes the observer to `LOGIN`. Any SQL or verification
   failure leaves the observer disabled.
10. Connect as the observer to PgBouncer's `pgbouncer` database and prove that `SHOW POOLS` and
    `SHOW STATS` succeed while administrative commands remain unavailable. If this smoke check
    fails, immediately run `disable-observer.sql` against `postgres`; it commits `NOLOGIN`,
    clears the password, and terminates observer sessions before any later cleanup.
11. Only after activation and the observer smoke check pass may the worker credential be enabled
    and the worker release activated. A missing credential or failed check remains
    `unavailable`; there is no fallback to an application or superuser credential.

## Rollback

First disable the worker credential and wait for the bounded collector attempt to settle. Run
`disable-observer.sql` against `postgres` before any cleanup, then apply
`rollback-torrent-view.sql` to `comet` and `bitmagnet`, remove the observer from PgBouncer
`stats_users` through the approved configuration workflow, reload PgBouncer, and finally apply
`rollback-cluster.sql` to `postgres`.

Both the dedicated disable artifact and cluster rollback disable login and clear the password
before beginning later work, so a dependency failure cannot re-enable the observer or restore
its credential. The view rollback is transactional. The schema drop is `RESTRICT`, and the role
drop fails closed if an unexpected dependency remains. The scripts do not modify application
tables, application roles, shared `PUBLIC` database ACLs, PgBouncer files, secrets, or worker
configuration.
