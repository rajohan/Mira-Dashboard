import { describe, expect, test } from "bun:test";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import {
    databaseObservabilityObserverRole,
    databaseObservabilityPgBouncerVirtualDatabase,
    databaseObservabilityReviewedPostgreSqlDatabases,
    databaseObservabilityTorrentCountDatabases,
    databaseObservabilityViewOwnerRole,
} from "../../src/shared/databaseObservabilityPolicy.ts";
import { databaseObservabilityProvisioningReleaseArtifactPaths } from "./databaseObservabilityProvisioningPolicy.ts";

const provisioningRoot = path.join(
    import.meta.dir,
    "provisioning/database-observability"
);
const sqlFiles = Object.freeze([
    "activate-observer.sql",
    "apply-cluster.sql",
    "apply-torrent-view.sql",
    "disable-observer.sql",
    "rollback-cluster.sql",
    "rollback-torrent-view.sql",
    "verify-cluster.sql",
    "verify-database.sql",
    "verify-torrent-view.sql",
]);

interface ProvisioningManifest {
    readonly activationOrder: readonly string[];
    readonly applyOrder: readonly string[];
    readonly formatVersion: number;
    readonly observerRole: string;
    readonly pgBouncer: {
        readonly adminUserForbidden: string;
        readonly statsUserRequired: string;
        readonly virtualDatabase: string;
    };
    readonly postgresql: {
        readonly builtinRoles: readonly string[];
        readonly reviewedDatabases: readonly string[];
        readonly sessionDefaults: Readonly<Record<string, string>>;
        readonly statementStatistics: {
            readonly database: string;
            readonly extension: string;
            readonly relations: readonly string[];
            readonly schema: string;
            readonly version: string;
        };
    };
    readonly rollbackOrder: readonly string[];
    readonly torrentViews: readonly {
        database: string;
        source: string;
        target: string;
    }[];
    readonly verifyOrder: readonly string[];
    readonly viewOwnerRole: string;
}

async function readProvisioningFile(fileName: string): Promise<string> {
    return readFile(path.join(provisioningRoot, fileName), "utf8");
}

describe("database observability provisioning", () => {
    test("inventories one deterministic approval-gated artifact set", async () => {
        const sourceEntries = await readdir(provisioningRoot);
        const entries = sourceEntries.toSorted();
        expect(entries).toEqual(["README.md", "manifest.json", ...sqlFiles].toSorted());
        expect(databaseObservabilityProvisioningReleaseArtifactPaths).toEqual(
            entries.map(
                (fileName) =>
                    `scripts/delivery/provisioning/database-observability/${fileName}`
            )
        );
        for (const entry of entries) {
            const status = await lstat(path.join(provisioningRoot, entry), {
                bigint: true,
            });
            expect(status.isFile()).toBe(true);
            expect(status.isSymbolicLink()).toBe(false);
            expect(status.nlink).toBe(1n);
            expect(status.mode & 0o111n).toBe(0n);
            expect(status.size).toBeGreaterThan(0n);
            expect(status.size).toBeLessThanOrEqual(64n * 1024n);
        }
    });

    test("declares the exact principal, database, view and PgBouncer boundary", async () => {
        const manifest = JSON.parse(
            await readProvisioningFile("manifest.json")
        ) as ProvisioningManifest;
        expect(manifest).toEqual({
            formatVersion: 2,
            observerRole: databaseObservabilityObserverRole,
            viewOwnerRole: databaseObservabilityViewOwnerRole,
            postgresql: {
                builtinRoles: ["pg_monitor", "pg_read_all_stats"],
                reviewedDatabases: databaseObservabilityReviewedPostgreSqlDatabases,
                sessionDefaults: {
                    default_transaction_read_only: "on",
                    statement_timeout: "5s",
                },
                statementStatistics: {
                    database: "postgres",
                    extension: "pg_stat_statements",
                    relations: [
                        "public.pg_stat_statements",
                        "public.pg_stat_statements_info",
                    ],
                    schema: "public",
                    version: "1.12",
                },
            },
            pgBouncer: {
                adminUserForbidden: databaseObservabilityObserverRole,
                statsUserRequired: databaseObservabilityObserverRole,
                virtualDatabase: databaseObservabilityPgBouncerVirtualDatabase,
            },
            torrentViews: [
                {
                    database: databaseObservabilityTorrentCountDatabases[0],
                    source: "public.torrents",
                    target: "mira_dashboard_observability.torrent_count",
                },
                {
                    database: databaseObservabilityTorrentCountDatabases[1],
                    source: "public.torrents",
                    target: "mira_dashboard_observability.torrent_count",
                },
            ],
            applyOrder: [
                "apply-cluster.sql",
                "interactive-observer-password",
                "apply-torrent-view.sql@bitmagnet",
                "apply-torrent-view.sql@comet",
                "manual-pgbouncer-stats-user",
            ],
            verifyOrder: [
                "verify-cluster.sql",
                "verify-database.sql@aiomanager",
                "verify-database.sql@aiometadata",
                "verify-database.sql@aiostreams",
                "verify-database.sql@authelia",
                "verify-database.sql@bitmagnet",
                "verify-database.sql@comet",
                "verify-database.sql@crowdsec",
                "verify-database.sql@metabase",
                "verify-database.sql@postgres",
                "verify-database.sql@speedtest_tracker",
                "verify-torrent-view.sql@bitmagnet",
                "verify-torrent-view.sql@comet",
                "manual-pgbouncer-config-check",
            ],
            activationOrder: [
                "activate-observer.sql",
                "manual-observer-pgbouncer-command-check",
                "enable-worker-credential",
            ],
            rollbackOrder: [
                "disable-worker-credential",
                "disable-observer.sql",
                "rollback-torrent-view.sql@comet",
                "rollback-torrent-view.sql@bitmagnet",
                "manual-pgbouncer-stats-user-removal",
                "rollback-cluster.sql",
            ],
        });
    });

    test("quarantines a fixed observer before granting only reviewed authority", async () => {
        const apply = await readProvisioningFile("apply-cluster.sql");
        expect(apply).toContain(
            "CREATE ROLE mira_dashboard_observer\n      NOLOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE"
        );
        expect(apply).toContain("NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1");
        expect(apply).toContain(
            "CREATE ROLE mira_dashboard_observability_owner\n      NOLOGIN NOINHERIT NOSUPERUSER"
        );
        expect(apply).toContain(
            "ALTER ROLE mira_dashboard_observability_owner PASSWORD NULL;"
        );
        expect(apply).toContain("ALTER ROLE mira_dashboard_observer PASSWORD NULL;");
        expect(apply).toContain("ALTER ROLE mira_dashboard_observer RESET ALL;");
        expect(apply).toContain("pg_terminate_backend(reserved_session.pid, 5000)");
        expect(apply).toContain("pg_stat_clear_snapshot()");
        expect(apply).toContain("observer_inbound_membership_count <> 0");
        expect(
            apply.match(/admin_option OR NOT inherit_option OR NOT set_option/gu)
        ).toHaveLength(2);
        expect(apply).toContain("owner_membership_count <> 0");
        expect(apply).toContain("observer.rolcanlogin");
        expect(apply).toContain("observer.rolpassword IS NOT NULL");
        expect(apply).toContain("cardinality(observer_config) IS DISTINCT FROM 2");
        expect(apply).toContain("GRANT pg_monitor TO mira_dashboard_observer;");
        expect(apply).toContain("GRANT pg_read_all_stats TO mira_dashboard_observer;");
        expect(apply).toContain("SET default_transaction_read_only = on;");
        expect(apply).toContain("SET statement_timeout = '5s';");
        for (const database of databaseObservabilityReviewedPostgreSqlDatabases) {
            expect(apply).toContain(
                `REVOKE ALL PRIVILEGES ON DATABASE ${database} FROM mira_dashboard_observer;`
            );
            expect(apply).toContain(
                `GRANT CONNECT ON DATABASE ${database} TO mira_dashboard_observer;`
            );
        }
        expect(apply.match(/GRANT CONNECT ON DATABASE /gu)).toHaveLength(
            databaseObservabilityReviewedPostgreSqlDatabases.length
        );
        const privilegeTransaction = apply.indexOf("\nBEGIN;\n");
        expect(privilegeTransaction).toBeGreaterThan(
            apply.indexOf("ALTER ROLE mira_dashboard_observer PASSWORD NULL;")
        );
        expect(privilegeTransaction).toBeGreaterThan(
            apply.indexOf("pg_terminate_backend(reserved_session.pid, 5000)")
        );
        expect(apply.indexOf("REVOKE pg_monitor")).toBeGreaterThan(
            apply.indexOf("$qualify_existing_roles$;")
        );
        expect(apply.indexOf("GRANT pg_monitor")).toBeGreaterThan(
            apply.indexOf("REVOKE pg_read_all_stats")
        );
        expect(apply).not.toContain("ALTER ROLE mira_dashboard_observer LOGIN;");
        expect(apply).not.toMatch(/VALID UNTIL|GRANT (CREATE|TEMP)/u);
    });

    test("activates LOGIN only after re-running every exact verifier", async () => {
        const activation = await readProvisioningFile("activate-observer.sql");
        const disable = await readProvisioningFile("disable-observer.sql");
        for (const database of databaseObservabilityReviewedPostgreSqlDatabases) {
            expect(activation).toContain(`\\connect ${database}`);
        }
        expect(activation.match(/\\ir verify-database\.sql/gu)).toHaveLength(
            databaseObservabilityReviewedPostgreSqlDatabases.length
        );
        expect(activation.match(/\\ir verify-torrent-view\.sql/gu)).toHaveLength(
            databaseObservabilityTorrentCountDatabases.length
        );
        const finalClusterVerification = activation.lastIndexOf(
            String.raw`\ir verify-cluster.sql`
        );
        const enableLogin = activation.indexOf(
            "ALTER ROLE mira_dashboard_observer LOGIN;"
        );
        expect(finalClusterVerification).toBeGreaterThan(activation.indexOf("BEGIN;"));
        expect(enableLogin).toBeGreaterThan(finalClusterVerification);
        expect(activation.indexOf("COMMIT;", enableLogin)).toBeGreaterThan(enableLogin);
        expect(
            disable.indexOf("ALTER ROLE mira_dashboard_observer NOLOGIN;")
        ).toBeLessThan(
            disable.indexOf("ALTER ROLE mira_dashboard_observer PASSWORD NULL;")
        );
        expect(disable).toContain("pg_terminate_backend(observer_session.pid, 5000)");
        expect(disable).toContain("pg_stat_clear_snapshot()");

        for (const fileName of sqlFiles.filter(
            (fileName) => fileName !== "activate-observer.sql"
        )) {
            expect(await readProvisioningFile(fileName)).not.toContain(
                "ALTER ROLE mira_dashboard_observer LOGIN;"
            );
        }
    });

    test("creates only an owner-rights count view and no observer base-table grant", async () => {
        const apply = await readProvisioningFile("apply-torrent-view.sql");
        expect(apply).toContain("current_database() NOT IN ('bitmagnet', 'comet')");
        expect(apply).toContain(
            "REVOKE ALL PRIVILEGES ON SCHEMA mira_dashboard_observability FROM PUBLIC;"
        );
        expect(apply).toContain(
            "GRANT SELECT ON TABLE public.torrents\n  TO mira_dashboard_observability_owner;"
        );
        expect(apply).toContain(
            "REVOKE ALL PRIVILEGES ON TABLE public.torrents\n  FROM mira_dashboard_observer;"
        );
        expect(apply).toContain("CREATE VIEW mira_dashboard_observability.torrent_count");
        expect(apply).toContain(
            "Database observability schema must be absent before apply"
        );
        expect(apply).toContain(
            "CREATE SCHEMA mira_dashboard_observability\n  AUTHORIZATION mira_dashboard_observability_owner;"
        );
        expect(apply).not.toMatch(/CREATE SCHEMA IF NOT EXISTS|CREATE OR REPLACE VIEW/u);
        expect(apply).toContain(
            "SELECT pg_catalog.count(*)::bigint AS count\nFROM public.torrents;"
        );
        expect(apply).toContain(
            "GRANT SELECT ON TABLE mira_dashboard_observability.torrent_count\n  TO mira_dashboard_observer;"
        );
        expect(apply).toContain("Database observability ACL is not exact");
        expect(apply).toContain("grants.grantee = owner_oid");
        expect(apply).toContain("grants.grantee = observer_oid");
        expect(apply).toContain("grants.is_grantable");
        expect(apply).toContain("'MAINTAIN'");
        expect(apply).not.toMatch(
            /GRANT SELECT ON TABLE public\.torrents\s+TO mira_dashboard_observer/u
        );
    });

    test("fails verification on inherited database or base-table authority", async () => {
        const cluster = await readProvisioningFile("verify-cluster.sql");
        const database = await readProvisioningFile("verify-database.sql");
        const view = await readProvisioningFile("verify-torrent-view.sql");
        expect(cluster).toContain(
            "effective_databases IS DISTINCT FROM expected_databases"
        );
        expect(cluster).toContain("observer.rolpassword NOT LIKE 'SCRAM-SHA-256$%'");
        expect(cluster).toContain("OR observer.rolcanlogin");
        expect(cluster).toContain("cardinality(observer_config) IS DISTINCT FROM 2");
        expect(cluster).toContain("observer_inbound_membership_count <> 0");
        expect(cluster).toContain("admin_option OR NOT inherit_option OR NOT set_option");
        expect(cluster).toContain("owner_membership_count <> 0");
        expect(cluster).toContain("reserved_session_count <> 0");
        expect(cluster).toContain(
            "direct_memberships IS DISTINCT FROM ARRAY[\n    'pg_monitor',\n    'pg_read_all_stats'"
        );
        expect(cluster).toContain("'TEMPORARY'");
        for (const databaseName of databaseObservabilityReviewedPostgreSqlDatabases) {
            expect(database).toContain(`'${databaseName}'`);
        }
        expect(database).toContain("classes.relkind IN ('r', 'p', 'f')");
        expect(database).toContain("classes.relkind IN ('v', 'm')");
        expect(database).toContain("extensions.extname = 'pg_stat_statements'");
        expect(database).toContain("extensions.extversion = '1.12'");
        expect(database).toContain("dependencies.deptype = 'e'");
        expect(database).toContain("'public.pg_stat_statements:v'");
        expect(database).toContain("'public.pg_stat_statements_info:v'");
        expect(database).toContain("classes.relowner IS DISTINCT FROM");
        expect(database).toContain("pg_stat_statements_extension_owner_oid");
        expect(database).toContain("'query:text'");
        expect(database).toContain("'stats_reset:timestamp with time zone'");
        expect(database).toContain("pg_stat_statements extension ACL is invalid");
        expect(database).toContain(
            "'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'"
        );
        expect(database).toContain("classes.relkind = 'S'");
        expect(database).toContain("has_sequence_privilege(");
        expect(database).toContain("'USAGE,SELECT,UPDATE'");
        expect(database).not.toContain(
            "'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,USAGE'"
        );
        expect(view).toContain(
            "schema_relations IS DISTINCT FROM ARRAY['torrent_count:v']"
        );
        expect(view).toContain(
            "Database observability schema contains unexpected routines"
        );
        expect(view).toContain("Database observability schema contains unexpected types");
        expect(view).toContain("routines.pronamespace = schema_oid");
        expect(view).toContain("types.typnamespace = schema_oid");
        expect(view).toContain("array_type.typelem = row_type.oid");
        expect(view).toContain(
            "Database observability view source dependency is invalid"
        );
        expect(view).toContain("'public.torrents'::pg_catalog.regclass");
        expect(view).toContain("set_config('search_path', 'pg_catalog', true)");
        expect(view).toContain("Database observability ACL is not exact");
        expect(view).toContain("grants.grantee = owner_oid");
        expect(view).toContain("grants.grantee = observer_oid");
        expect(view).not.toContain("grants.grantee = 0");
        expect(view).toContain(
            "'mira_dashboard_observer',\n      'public.torrents',\n      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'"
        );
        expect(view).toContain("projected_rows IS DISTINCT FROM 1");
        expect(view).toContain("projected_count IS DISTINCT FROM source_count");
        expect(view).toContain(
            "'mira_dashboard_observability_owner',\n      'public.torrents',\n      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'"
        );
    });

    test("keeps every SQL artifact non-interactive, bounded and free of secret or shell surfaces", async () => {
        for (const fileName of sqlFiles) {
            const sql = await readProvisioningFile(fileName);
            expect(sql.startsWith("\\set ON_ERROR_STOP 1\n")).toBe(true);
            expect(sql).not.toContain("\0");
            expect(sql).not.toMatch(
                /\\!|COPY[\s\S]*PROGRAM|ALTER SYSTEM|CREATE EXTENSION|dblink|postgres_fdw|docker|sudo|secret|credential|private-password|postgresql:\/\//iu
            );
            expect(sql).not.toMatch(/EXECUTE\s+['"]/iu);
            expect(sql).not.toContain("pg_catalog.coalesce(");
        }
    });

    test("documents explicit approval, secret handling, PgBouncer verification and fail-closed rollback", async () => {
        const readme = await readProvisioningFile("README.md");
        const disable = await readProvisioningFile("disable-observer.sql");
        const clusterRollback = await readProvisioningFile("rollback-cluster.sql");
        const viewRollback = await readProvisioningFile("rollback-torrent-view.sql");
        expect(readme).toContain("requires explicit approval");
        expect(readme).toContain("never executes them");
        expect(readme).toContain("intentionally first-install-only");
        expect(readme).toContain("cannot override a `PUBLIC` grant");
        expect(readme).toContain(
            "does not automate that potentially outage-causing change"
        );
        expect(readme).toContain(
            "add exactly\n   `mira_dashboard_observer` to `stats_users`"
        );
        expect(readme).toContain("absent from `admin_users`");
        expect(readme).toContain("Never paste it into a SQL file or argv");
        expect(readme).toContain("`AUTOCOMMIT` on");
        expect(readme).toContain("Do not use `psql --single-transaction`");
        expect(readme).toContain("Only `activate-observer.sql` may enable login");
        expect(readme).toContain("immediately run `disable-observer.sql`");
        expect(disable).toContain("ALTER ROLE mira_dashboard_observer PASSWORD NULL;");
        expect(clusterRollback).toContain("ALTER ROLE mira_dashboard_observer NOLOGIN;");
        expect(clusterRollback).toContain(
            "ALTER ROLE mira_dashboard_observer PASSWORD NULL;"
        );
        expect(clusterRollback.indexOf("ALTER ROLE")).toBeLessThan(
            clusterRollback.indexOf("BEGIN;")
        );
        expect(viewRollback).toContain(
            "DROP SCHEMA IF EXISTS mira_dashboard_observability RESTRICT;"
        );
        expect(clusterRollback).not.toMatch(/DROP DATABASE|DROP TABLE/u);
        expect(viewRollback).not.toMatch(/DROP DATABASE|DROP TABLE/u);
    });
});
