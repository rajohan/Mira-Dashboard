import { describe, expect, test } from "bun:test";

import { Redacted } from "effect";

import {
    databaseObservabilityDatabaseMaximum,
    databaseObservabilityObserverConnectionLimit,
    databaseObservabilityPgBouncerControlAlias,
    databaseObservabilityPgBouncerVirtualDatabase,
    databaseObservabilityTorrentCountDatabases,
} from "../../shared/databaseObservabilityPolicy.ts";
import {
    createBunSqlDatabaseObservabilityCollector,
    type DatabaseObservabilityConnection,
    type DatabaseObservabilitySqlClient,
    type DatabaseObservabilitySqlClientFactory,
} from "./bunSqlDatabaseObservabilityCollector.ts";

const connection = Object.freeze({
    controlDatabase: databaseObservabilityPgBouncerControlAlias,
    hostname: "127.0.0.1",
    password: Object.freeze(
        Redacted.make("private-password", {
            label: "database-observability-password",
        })
    ),
    port: 6432,
});
const connectionResolver = Object.freeze({
    resolve: () =>
        Promise.resolve({
            connection,
            source: { containerId: "a".repeat(64), containerPort: 5432 },
        }),
});
const controlDatabase = databaseObservabilityPgBouncerControlAlias;
const metricDatabases = [
    "app_a",
    "app_b",
    "app_c",
    "app_d",
    "bitmagnet",
    "comet",
    "db_a",
    "db_b",
    controlDatabase,
    "service_a",
] as const;

type Row = Record<string, unknown>;

function tableRow(database: string, overrides: Row = {}): Row {
    return {
        assessed: true,
        dead_tuple_percent: 1,
        dead_tuples: 1,
        estimated_reclaimable_bytes: 0,
        last_autoanalyze_at_ms: null,
        last_autovacuum_at_ms: null,
        live_tuples: 10_000,
        physical_bytes: 1,
        schema_name: "public",
        table_name: `${database}_table`,
        ...overrides,
    };
}

function queryText(strings: TemplateStringsArray): string {
    return strings.join("?").replaceAll(/\s+/gu, " ").trim();
}

function fakeQuery<T>(
    result: Promise<T>,
    events: string[],
    database: string,
    sql: string
) {
    const promise = result as Promise<T> & {
        cancel(): unknown;
        simple(): typeof promise;
    };
    promise.cancel = () => {
        events.push(`cancel:${database}:${sql}`);
        return promise;
    };
    promise.simple = () => {
        events.push(`simple:${database}:${sql}`);
        return promise;
    };
    return promise;
}

function fixtureFactory(
    options: {
        readonly events?: string[];
        readonly hangAt?: string;
        readonly rows?: (database: string, sql: string) => readonly Row[];
    } = {}
): DatabaseObservabilitySqlClientFactory & { readonly events: string[] } {
    const events = options.events ?? [];
    return Object.freeze({
        create(_connection: DatabaseObservabilityConnection, database: string) {
            events.push(`create:${database}`);
            const client = (<T>(strings: TemplateStringsArray, ...values: unknown[]) => {
                const sql = queryText(strings);
                events.push(`query:${database}:${sql}`);
                if (values.length > 0) {
                    events.push(`values:${database}:${JSON.stringify(values)}`);
                }
                const result =
                    options.hangAt === `${database}:${sql}`
                        ? new Promise<T>(() => {})
                        : Promise.resolve(
                              (options.rows?.(database, sql) ??
                                  fixtureRows(database, sql)) as T
                          );
                return fakeQuery(result, events, database, sql);
            }) as DatabaseObservabilitySqlClient;
            client.connect = () => {
                events.push(`connect:${database}`);
                return Promise.resolve(client);
            };
            client.close = () => {
                events.push(`close:${database}`);
                return Promise.resolve();
            };
            return client;
        },
        events,
    });
}

function fixtureRows(database: string, sql: string): readonly Row[] {
    if (sql.startsWith("SET LOCAL ")) return [];
    if (
        sql === "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY" ||
        sql === "COMMIT" ||
        sql === "ROLLBACK"
    )
        return [];
    if (sql.includes("pg_roles AS roles")) {
        return [
            {
                bypassRowLevelSecurity: false,
                capabilityInterfacesValid: true,
                canCreateCurrentDatabase: false,
                canCreateDatabase: false,
                canCreateRole: false,
                canCreateSchema: false,
                canCreateTemporaryTables: false,
                canReplicate: false,
                canLogin: true,
                connectionLimit: databaseObservabilityObserverConnectionLimit,
                currentDatabase: database,
                databaseRoleConfiguration: [],
                directMemberships: [],
                hasBaseTableAuthority: false,
                hasDefaultAclAuthority: false,
                hasInboundMemberships: false,
                hasInvalidMembershipOptions: false,
                hasRoutineGrantAuthority: false,
                hasSecurityDefinerRoutineAuthority: false,
                hasSequenceAuthority: false,
                hasUnexpectedRelationAuthority: false,
                inheritsPrivileges: true,
                isCapabilityOwner: false,
                isPgMonitor: false,
                isPgReadAllStats: false,
                isSuperuser: false,
                isViewOwner: false,
                roleName: "mira_dashboard_observer",
                roleConfiguration: [
                    "default_transaction_read_only=on",
                    "idle_in_transaction_session_timeout=60s",
                    "idle_session_timeout=60s",
                    "pg_stat_statements.track=none",
                    "statement_timeout=5s",
                ],
                statementTracking: "none",
            },
        ];
    }
    if (sql.includes("FROM pg_database")) {
        return metricDatabases.map((database) => {
            let numbackends = 0;
            let sizeBytes = 0;
            let committedTransactions = 0;
            let rolledBackTransactions = 0;
            if (database === "app_a") {
                numbackends = 2;
                sizeBytes = 100 * 1024 * 1024;
                committedTransactions = 10;
                rolledBackTransactions = 1;
            } else if (database === "app_b") {
                numbackends = 1;
                sizeBytes = 50 * 1024 * 1024;
                committedTransactions = 20;
                rolledBackTransactions = 2;
            }
            return {
                blks_hit: database === "app_a" ? 75 : 0,
                blks_read: database === "app_a" ? 25 : 0,
                database_count: metricDatabases.length,
                datname: database,
                numbackends,
                size_bytes: sizeBytes,
                xact_commit: committedTransactions,
                xact_rollback: rolledBackTransactions,
            };
        });
    }
    if (
        sql.includes(
            "FROM mira_dashboard_observability_capabilities.connection_metrics()"
        )
    ) {
        return [
            {
                active_connections: 1,
                idle_connections: 2,
                total_connections: 3,
            },
        ];
    }
    if (
        sql.includes(
            "FROM mira_dashboard_observability_capabilities.maintenance_metrics()"
        )
    ) {
        return [
            {
                assessed_physical_bytes: database === "app_a" ? 64 * 1024 * 1024 : 0,
                estimated_reclaimable_bytes: database === "app_a" ? 10 * 1024 * 1024 : 0,
                high_dead_tuple_table_count: database === "app_a" ? 1 : 0,
                unassessed_physical_bytes: database === "app_b" ? 10 : 0,
                unassessed_table_count: database === "app_b" ? 1 : 0,
            },
        ];
    }
    if (sql.includes("FROM mira_dashboard_observability_capabilities.table_health()")) {
        if (!["app_a", "app_b"].includes(database)) return [];
        return [
            tableRow(database, {
                assessed: database === "app_a",
                dead_tuple_percent: database === "app_a" ? 20 : 1,
                dead_tuples: database === "app_a" ? 2000 : 1,
                estimated_reclaimable_bytes:
                    database === "app_a" ? 10 * 1024 * 1024 : null,
                last_autoanalyze_at_ms: null,
                last_autovacuum_at_ms: null,
                live_tuples: 10_000,
                physical_bytes: database === "app_a" ? 64 * 1024 * 1024 : 10,
            }),
        ];
    }
    if (sql.includes("FROM pg_catalog.pg_extension")) {
        return [{ enabled: database === controlDatabase }];
    }
    if (
        sql.includes("FROM mira_dashboard_observability_capabilities.statement_metrics()")
    ) {
        if (database !== controlDatabase) {
            throw new Error("Statement metrics must use the control database");
        }
        return [
            {
                calls: 4,
                mean_execution_ms: 120,
                rows: 8,
                shared_blocks_hit: 9,
                shared_blocks_read: 1,
                total_execution_ms: 480,
            },
        ];
    }
    if (sql.includes("FROM mira_dashboard_observability.torrent_count")) {
        return [{ count: database === "comet" ? 84 : 42 }];
    }
    if (sql === "SHOW POOLS") {
        return [
            {
                cl_active: 2,
                cl_active_cancel_req: 0,
                cl_waiting: 1,
                cl_waiting_cancel_req: 0,
                database: "app_a",
                maxwait: 3,
                sv_active: 1,
                sv_active_cancel: 0,
                sv_being_canceled: 0,
                sv_idle: 1,
                sv_login: 0,
                sv_tested: 0,
                sv_used: 0,
            },
        ];
    }
    if (sql === "SHOW STATS") {
        return [
            {
                avg_query_count: 12,
                avg_query_time: 2000,
                avg_xact_count: 6,
                avg_xact_time: 4000,
                database: "app_a",
                total_query_count: 12,
            },
        ];
    }
    throw new Error(`Unexpected fixed SQL: ${sql}`);
}

describe("Bun SQL database observability collector", () => {
    test("uses sequential per-database and PgBouncer clients and projects no identities", async () => {
        const factory = fixtureFactory();
        const collector = createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        });

        const payload = await collector.collect();
        expect(payload).toMatchObject({
            pgbouncer: {
                averageQueryMs: 2,
                averageTransactionMs: 4,
                clientConnections: 3,
                serverConnections: 2,
                waitingClients: 1,
            },
            statements: [{ rank: 1 }],
            summary: {
                maintenance: {
                    assessmentComplete: true,
                    assessedPhysicalBytes: 64 * 1024 * 1024,
                    estimatedReclaimableBytes: 10 * 1024 * 1024,
                    estimatedReclaimablePercent: 15.625,
                    highDeadTupleTableCount: 1,
                    slowStatementCount: 0,
                    status: "review",
                    unassessedTableCount: 1,
                },
                totalDatabaseSizeBytes: 150 * 1024 * 1024,
                unavailableDatabaseCount: 0,
            },
            torrentCounts: {
                bitmagnet: { count: 42, state: "available" },
                comet: { count: 84, state: "available" },
            },
        });
        expect(payload.databases).toHaveLength(metricDatabases.length);
        expect(payload.databases.map(({ name }) => name)).toEqual(metricDatabases);
        expect(
            payload.databases.every(({ detailsState }) => detailsState === "available")
        ).toBe(true);
        expect(payload.databases[0]).toMatchObject({
            blocksHit: 75,
            blocksRead: 25,
            cacheHitRatio: 75,
            name: "app_a",
            pool: {
                activeClients: 2,
                averageQueryMs: 2,
                totalQueries: 12,
                waitingClients: 1,
            },
        });
        expect(payload.databases[1]).toMatchObject({
            blocksHit: 0,
            blocksRead: 0,
            cacheHitRatio: 100,
            name: "app_b",
        });
        expect(payload.summary.averageCacheHitRatio).toBe(75);
        expect(payload.tableHealth.map(({ database }) => database)).toEqual([
            "app_a",
            "app_b",
        ]);
        const postgresqlConnections = [
            controlDatabase,
            ...metricDatabases,
            ...databaseObservabilityTorrentCountDatabases,
        ];
        expect(factory.events.filter((event) => event.startsWith("create:"))).toEqual([
            ...postgresqlConnections.map((database) => `create:${database}`),
            `create:${databaseObservabilityPgBouncerVirtualDatabase}`,
        ]);
        expect(factory.events.filter((event) => event.startsWith("close:"))).toEqual([
            ...postgresqlConnections.map((database) => `close:${database}`),
            `close:${databaseObservabilityPgBouncerVirtualDatabase}`,
        ]);
        expect(JSON.stringify(payload)).not.toContain("private-password");
        expect(JSON.stringify(payload)).not.toContain("mira_dashboard_observer");
        expect(JSON.stringify(payload)).not.toContain("query");
        expect(
            factory.events.some((event) => event.includes("simple:pgbouncer:SHOW POOLS"))
        ).toBe(true);
        for (const [index, event] of factory.events.entries()) {
            if (!event.startsWith("create:")) continue;
            const database = event.slice("create:".length);
            if (database === databaseObservabilityPgBouncerVirtualDatabase) continue;
            const closeIndex = factory.events.indexOf(`close:${database}`, index);
            const queries = factory.events
                .slice(index, closeIndex)
                .filter((candidate) => candidate.startsWith(`query:${database}:`));
            expect(queries.slice(0, 5)).toEqual([
                `query:${database}:BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
                `query:${database}:SET LOCAL pg_stat_statements.track = 'none'`,
                `query:${database}:SET LOCAL statement_timeout = '5s'`,
                `query:${database}:SET LOCAL search_path = pg_catalog, public`,
                expect.stringContaining(`query:${database}:WITH role_oids AS`),
            ]);
        }
        expect(
            factory.events.some((event) => event.startsWith("query:pgbouncer:SET"))
        ).toBe(false);
        expect(factory.events.find((event) => event.startsWith("query:pgbouncer:"))).toBe(
            "query:pgbouncer:SHOW POOLS"
        );
        for (const database of ["app_a", "app_b"]) {
            const queries = factory.events.filter((event) =>
                event.startsWith(`query:${database}:`)
            );
            expect(queries[0]).toBe(
                `query:${database}:BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
            );
            expect(queries[1]).toBe(
                `query:${database}:SET LOCAL pg_stat_statements.track = 'none'`
            );
            expect(queries[2]).toBe(
                `query:${database}:SET LOCAL statement_timeout = '5s'`
            );
            expect(queries[3]).toBe(
                `query:${database}:SET LOCAL search_path = pg_catalog, public`
            );
            expect(queries[5]).toBe(
                `query:${database}:SET LOCAL search_path = pg_catalog`
            );
            expect(
                queries.some((query) =>
                    query.includes(
                        "FROM mira_dashboard_observability_capabilities.maintenance_metrics()"
                    )
                )
            ).toBe(true);
            expect(
                queries.some((query) =>
                    query.includes(
                        "FROM mira_dashboard_observability_capabilities.table_health()"
                    )
                )
            ).toBe(true);
            expect(queries.at(-1)).toBe(`query:${database}:COMMIT`);
        }
        expect(
            factory.events.filter(
                (event) =>
                    event.startsWith("query:mira_dashboard_observability:") &&
                    event.includes("FROM pg_database")
            )
        ).toHaveLength(1);
        expect(
            factory.events.filter(
                (event) =>
                    event.startsWith(
                        "query:mira_dashboard_observability:SELECT EXISTS"
                    ) && event.includes("FROM pg_catalog.pg_extension")
            )
        ).toEqual([expect.stringContaining("query:mira_dashboard_observability:")]);
        expect(
            factory.events.filter((event) =>
                event.includes(
                    "FROM mira_dashboard_observability_capabilities.statement_metrics()"
                )
            )
        ).toEqual([expect.stringContaining("query:mira_dashboard_observability:")]);
        const observerPolicyQuery = factory.events.find(
            (event) =>
                event.startsWith(
                    "query:mira_dashboard_observability:WITH role_oids AS"
                ) && event.includes('AS "directMemberships"')
        );
        expect(observerPolicyQuery).toContain("NOT memberships.inherit_option");
        expect(observerPolicyQuery).toContain("NOT memberships.set_option");
        expect(observerPolicyQuery).toContain("memberships.roleid = roles.oid");
        expect(observerPolicyQuery).toContain('AS "databaseRoleConfiguration"');
        expect(observerPolicyQuery).toContain('AS "hasDefaultAclAuthority"');
        expect(observerPolicyQuery).toContain('AS "hasRoutineGrantAuthority"');
        expect(observerPolicyQuery).toContain('AS "hasSecurityDefinerRoutineAuthority"');
        expect(observerPolicyQuery).toContain("'table_health'");
        expect(observerPolicyQuery).toContain("'maintenance_metrics'");
        expect(observerPolicyQuery).toContain("'connection_metrics'");
        expect(observerPolicyQuery).toContain("'statement_metrics'");
        expect(observerPolicyQuery).toContain("routines.pronargs = 0");
        expect(observerPolicyQuery).toContain("pg_catalog.aclexplode(routines.proacl)");
        expect(observerPolicyQuery).toContain("grants.grantee = roles.oid");
        expect(observerPolicyQuery).toContain("grants.grantee <> 0");
        expect(observerPolicyQuery).toContain("routines.proowner");
        expect(observerPolicyQuery).toContain("routines.prosecdef");
        expect(observerPolicyQuery).toContain('AS "capabilityInterfacesValid"');
        expect(observerPolicyQuery).toContain("pg_catalog.sha256(");
        expect(observerPolicyQuery).toContain("pg_catalog.pg_get_function_sqlbody(");
        expect(observerPolicyQuery).toContain("routines.proconfig");
        expect(observerPolicyQuery).toContain("routines.proowner");
        expect(observerPolicyQuery).toContain("pg_catalog.has_function_privilege(");
        expect(observerPolicyQuery).toContain("routines.oid, 'EXECUTE'");
        expect(factory.events).toContain(
            `values:mira_dashboard_observability:[${databaseObservabilityDatabaseMaximum}]`
        );
        expect(factory.events).toContain(`values:app_a:[25]`);
        expect(factory.events).toContain(`values:mira_dashboard_observability:[20]`);
    });

    test("contains a count-only view failure to its exact torrent source", async () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                if (
                    database === "comet" &&
                    sql.includes("FROM mira_dashboard_observability.torrent_count")
                ) {
                    throw new Error("private upstream detail");
                }
                return fixtureRows(database, sql);
            },
        });

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        }).collect();

        expect(payload.torrentCounts).toEqual({
            bitmagnet: { count: 42, state: "available" },
            comet: { state: "unavailable" },
        });
        const countQueries = factory.events.filter((event) =>
            event.includes("mira_dashboard_observability.torrent_count")
        );
        expect(countQueries).toHaveLength(2);
        expect(countQueries.every((event) => !event.includes("FROM torrents"))).toBe(
            true
        );
        expect(factory.events).toContain("close:comet");
        expect(factory.events).toContain("create:pgbouncer");
    });

    test("fails before metrics when the monitoring principal violates policy", () => {
        for (const policyOverride of [
            { roleName: "postgres" },
            { canLogin: false },
            { inheritsPrivileges: false },
            { isSuperuser: true },
            { canCreateDatabase: true },
            { canCreateRole: true },
            { canReplicate: true },
            { bypassRowLevelSecurity: true },
            { connectionLimit: databaseObservabilityObserverConnectionLimit + 1 },
            { roleConfiguration: ["statement_timeout=5s"] },
            { statementTracking: "all" },
            { databaseRoleConfiguration: ["statement_timeout=60s"] },
            { directMemberships: ["pg_monitor"] },
            { directMemberships: ["pg_read_all_stats"] },
            { hasInvalidMembershipOptions: true },
            { hasInboundMemberships: true },
            { currentDatabase: "template1" },
            { canCreateCurrentDatabase: true },
            { canCreateTemporaryTables: true },
            { canCreateSchema: true },
            { hasBaseTableAuthority: true },
            { hasUnexpectedRelationAuthority: true },
            { hasSequenceAuthority: true },
            { hasRoutineGrantAuthority: true },
            { hasSecurityDefinerRoutineAuthority: true },
            { isPgMonitor: true },
            { isPgReadAllStats: true },
            { isCapabilityOwner: true },
            { isViewOwner: true },
        ]) {
            const factory = fixtureFactory({
                rows(database, sql) {
                    const rows = fixtureRows(database, sql);
                    return sql.includes("pg_roles AS roles")
                        ? [{ ...rows[0], ...policyOverride }]
                        : rows;
                },
            });

            expect(
                createBunSqlDatabaseObservabilityCollector({
                    connectionResolver,
                    sqlClientFactory: factory,
                }).collect()
            ).rejects.toThrow("Database observability collection failed");
            expect(factory.events).toContain(
                "query:mira_dashboard_observability:ROLLBACK"
            );
            expect(
                factory.events.some((event) => event.includes("FROM pg_database"))
            ).toBe(false);
            expect(factory.events.filter((event) => event.startsWith("create:"))).toEqual(
                ["create:mira_dashboard_observability"]
            );
        }
    });

    test("fails before metrics for observer-owned default ACL drift", () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                const rows = fixtureRows(database, sql);
                return sql.includes("pg_roles AS roles")
                    ? [{ ...rows[0], hasDefaultAclAuthority: true }]
                    : rows;
            },
        });

        expect(
            createBunSqlDatabaseObservabilityCollector({
                connectionResolver,
                sqlClientFactory: factory,
            }).collect()
        ).rejects.toThrow("Database observability collection failed");
        const policyQuery = factory.events.find(
            (event) =>
                event.startsWith(
                    "query:mira_dashboard_observability:WITH role_oids AS"
                ) && event.includes('AS "hasDefaultAclAuthority"')
        );
        expect(policyQuery).toContain("LEFT JOIN LATERAL");
        expect(policyQuery).toContain("default_acls.defaclrole = roles.oid");
        expect(factory.events).toContain("query:mira_dashboard_observability:ROLLBACK");
        expect(factory.events.some((event) => event.includes("FROM pg_database"))).toBe(
            false
        );
    });

    test("isolates per-database policy drift without hiding the dynamic inventory", async () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                const rows = fixtureRows(database, sql);
                return database === "app_a" && sql.includes("pg_roles AS roles")
                    ? [{ ...rows[0], isSuperuser: true }]
                    : rows;
            },
        });

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        }).collect();
        expect(payload.databases.find(({ name }) => name === "app_a")?.detailsState).toBe(
            "unavailable"
        );
        expect(payload.databases.find(({ name }) => name === "app_b")?.detailsState).toBe(
            "available"
        );
        expect(payload.summary.unavailableDatabaseCount).toBe(1);
        expect(payload.summary.maintenance.assessmentComplete).toBe(false);
        expect(factory.events).toContain("query:app_a:ROLLBACK");
        expect(
            factory.events.some(
                (event) =>
                    event.startsWith("query:app_a:") &&
                    event.includes(
                        "FROM mira_dashboard_observability_capabilities.table_health()"
                    )
            )
        ).toBe(false);
        expect(factory.events).toContain("create:app_b");
    });

    test("isolates routine authority drift to the affected database", async () => {
        for (const policyOverride of [
            { hasRoutineGrantAuthority: true },
            { hasSecurityDefinerRoutineAuthority: true },
        ]) {
            const factory = fixtureFactory({
                rows(database, sql) {
                    const rows = fixtureRows(database, sql);
                    return database === "app_a" && sql.includes("pg_roles AS roles")
                        ? [{ ...rows[0], ...policyOverride }]
                        : rows;
                },
            });

            const payload = await createBunSqlDatabaseObservabilityCollector({
                connectionResolver,
                sqlClientFactory: factory,
            }).collect();

            expect(
                payload.databases.find(({ name }) => name === "app_a")?.detailsState
            ).toBe("unavailable");
            expect(
                payload.databases.find(({ name }) => name === "app_b")?.detailsState
            ).toBe("available");
            expect(payload.summary.unavailableDatabaseCount).toBe(1);
            expect(factory.events).toContain("query:app_a:ROLLBACK");
            expect(
                factory.events.some(
                    (event) =>
                        event.startsWith("query:app_a:") &&
                        event.includes(
                            "FROM mira_dashboard_observability_capabilities.table_health()"
                        )
                )
            ).toBe(false);
        }
    });

    test("contains torrent-count policy drift to the optional named capability", async () => {
        let bitmagnetPolicyChecks = 0;
        const factory = fixtureFactory({
            rows(database, sql) {
                const rows = fixtureRows(database, sql);
                if (
                    database === "bitmagnet" &&
                    sql.includes("pg_roles AS roles") &&
                    ++bitmagnetPolicyChecks === 2
                ) {
                    return [{ ...rows[0], roleName: "unexpected_observer" }];
                }
                return rows;
            },
        });

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        }).collect();
        expect(payload.torrentCounts.bitmagnet).toEqual({ state: "unavailable" });
        expect(bitmagnetPolicyChecks).toBe(2);
        expect(
            factory.events.some(
                (event) =>
                    event.startsWith("query:bitmagnet:") &&
                    event.includes("FROM mira_dashboard_observability.torrent_count")
            )
        ).toBe(false);
        expect(factory.events).toContain("create:pgbouncer");
    });

    test("reconciles a removed database without a source or configuration edit", async () => {
        const missingDatabase = "app_c";
        const factory = fixtureFactory({
            rows(database, sql) {
                const rows = fixtureRows(database, sql);
                if (database !== controlDatabase || !sql.includes("FROM pg_database")) {
                    return rows;
                }
                const admittedRows = rows.filter(
                    (row) => row.datname !== missingDatabase
                );
                return admittedRows.map((row) => ({
                    ...row,
                    database_count: admittedRows.length,
                }));
            },
        });

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        }).collect();
        expect(payload.databases.map(({ name }) => name)).toEqual(
            metricDatabases.filter((name) => name !== missingDatabase)
        );
        expect(factory.events).not.toContain(`create:${missingDatabase}`);
        const inventoryQuery = factory.events.find(
            (event) =>
                event.startsWith("query:mira_dashboard_observability:") &&
                event.includes("FROM pg_database")
        );
        expect(inventoryQuery).toContain("databases.datallowconn = true");
        expect(inventoryQuery).not.toContain("has_database_privilege");
    });

    test("keeps optional torrent capabilities unavailable when their databases are absent", async () => {
        const torrentDatabases = new Set<string>(
            databaseObservabilityTorrentCountDatabases
        );
        const factory = fixtureFactory({
            rows(database, sql) {
                const rows = fixtureRows(database, sql);
                if (database !== controlDatabase || !sql.includes("FROM pg_database")) {
                    return rows;
                }
                const discoveredRows = rows.filter(
                    (row) => !torrentDatabases.has(String(row.datname))
                );
                return discoveredRows.map((row) => ({
                    ...row,
                    database_count: discoveredRows.length,
                }));
            },
        });

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        }).collect();

        expect(payload.torrentCounts).toEqual({
            bitmagnet: { state: "unavailable" },
            comet: { state: "unavailable" },
        });
        for (const database of databaseObservabilityTorrentCountDatabases) {
            expect(factory.events).not.toContain(`create:${database}`);
        }
    });

    test("discovers additions and renames and canonicalizes catalog order", async () => {
        const expectedDatabases = [
            ...metricDatabases.filter((database) => database !== "app_c"),
            "renamed_database",
            "zeta_dynamic",
        ].toSorted();
        const factory = fixtureFactory({
            rows(database, sql) {
                const rows = fixtureRows(database, sql);
                if (database !== controlDatabase || !sql.includes("FROM pg_database")) {
                    return rows;
                }
                const changedRows = [
                    ...rows.map((row) =>
                        row.datname === "app_c"
                            ? { ...row, datname: "renamed_database" }
                            : row
                    ),
                    {
                        blks_hit: 0,
                        blks_read: 0,
                        database_count: rows.length + 1,
                        datname: "zeta_dynamic",
                        numbackends: 0,
                        size_bytes: 0,
                        xact_commit: 0,
                        xact_rollback: 0,
                    },
                ];
                return changedRows
                    .map((row) => ({
                        ...row,
                        database_count: changedRows.length,
                    }))
                    .toReversed();
            },
        });

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        }).collect();

        expect(payload.databases.map(({ name }) => name)).toEqual(expectedDatabases);
        expect(
            payload.databases.every(({ detailsState }) => detailsState === "available")
        ).toBe(true);
        expect(factory.events).toContain("create:renamed_database");
        expect(factory.events).toContain("create:zeta_dynamic");
        expect(factory.events).not.toContain("create:app_c");
        expect(factory.events).toContain(`values:${controlDatabase}:[20]`);
    });

    test("keeps a new default-ACL database unavailable until access reconciliation converges", async () => {
        const dynamicDatabase = "new_default_acl_database";
        let reconciled = false;
        const factory = fixtureFactory({
            rows(database, sql) {
                const rows = fixtureRows(database, sql);
                if (database === dynamicDatabase && sql.includes("pg_roles AS roles")) {
                    return [{ ...rows[0], canCreateTemporaryTables: !reconciled }];
                }
                if (database !== controlDatabase || !sql.includes("FROM pg_database")) {
                    return rows;
                }
                const discoveredRows = [
                    ...rows,
                    {
                        blks_hit: 0,
                        blks_read: 0,
                        database_count: rows.length + 1,
                        datname: dynamicDatabase,
                        numbackends: 0,
                        size_bytes: 0,
                        xact_commit: 0,
                        xact_rollback: 0,
                    },
                ];
                return discoveredRows.map((row) => ({
                    ...row,
                    database_count: discoveredRows.length,
                }));
            },
        });
        const collector = createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        });

        const beforeReconcile = await collector.collect();
        expect(
            beforeReconcile.databases.find(({ name }) => name === dynamicDatabase)
                ?.detailsState
        ).toBe("unavailable");
        expect(
            beforeReconcile.databases.find(({ name }) => name === "app_a")?.detailsState
        ).toBe("available");

        reconciled = true;
        const afterReconcile = await collector.collect();
        expect(
            afterReconcile.databases.find(({ name }) => name === dynamicDatabase)
                ?.detailsState
        ).toBe("available");
    });

    test("reads statement metrics once from the control database", async () => {
        const factory = fixtureFactory();

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        }).collect();

        expect(payload.summary.pgStatStatementsEnabled).toBe(true);
        expect(payload.statements).toEqual([
            expect.objectContaining({ calls: 4, rank: 1, totalExecutionMs: 480 }),
        ]);
        expect(
            factory.events.filter(
                (event) =>
                    event.startsWith(
                        "query:mira_dashboard_observability:SELECT EXISTS"
                    ) && event.includes("FROM pg_catalog.pg_extension")
            )
        ).toEqual([expect.stringContaining("query:mira_dashboard_observability:")]);
        expect(
            factory.events.filter((event) =>
                event.includes(
                    "FROM mira_dashboard_observability_capabilities.statement_metrics()"
                )
            )
        ).toEqual([expect.stringContaining("query:mira_dashboard_observability:")]);
        const statementQuery = factory.events.find((event) =>
            event.includes(
                "FROM mira_dashboard_observability_capabilities.statement_metrics()"
            )
        );
        expect(statementQuery).not.toContain("JOIN pg_catalog.pg_database");
        expect(statementQuery).not.toMatch(/\b(dbid|userid|queryid)\b/u);
        expect(statementQuery).not.toContain(" query,");
        expect(statementQuery).not.toContain("public.pg_stat_statements");
        const policyQuery = factory.events.find((event) =>
            event.startsWith("query:mira_dashboard_observability:WITH role_oids AS")
        );
        expect(policyQuery).toContain("'statement_metrics'");
        expect(policyQuery).toContain("'connection_metrics'");
        expect(policyQuery).toContain("routines.pronargs = 0");
        expect(policyQuery).toContain('AS "hasRoutineGrantAuthority"');
        expect(policyQuery).toContain("'pg_read_all_stats'");
        expect(factory.events).toContain(`values:mira_dashboard_observability:[20]`);
    });

    test("reviews only recurring statements above the material latency threshold", async () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                if (
                    sql.includes(
                        "FROM mira_dashboard_observability_capabilities.statement_metrics()"
                    )
                ) {
                    return [
                        {
                            calls: 25,
                            mean_execution_ms: 1000,
                            rows: 25,
                            shared_blocks_hit: 250,
                            shared_blocks_read: 25,
                            total_execution_ms: 25_000,
                        },
                        {
                            calls: 24,
                            mean_execution_ms: 2000,
                            rows: 24,
                            shared_blocks_hit: 240,
                            shared_blocks_read: 24,
                            total_execution_ms: 24_000,
                        },
                    ];
                }
                return fixtureRows(database, sql);
            },
        });

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        }).collect();

        expect(payload.summary.maintenance.slowStatementCount).toBe(1);
        expect(payload.summary.maintenance.status).toBe("review");
    });

    test("rejects a control database outside the fixed capability alias", () => {
        const alternateControlDatabase = ".";
        const alternateConnection = Object.freeze({
            ...connection,
            controlDatabase: alternateControlDatabase,
            hostname: "localhost",
            port: 7444,
        });
        const factory = fixtureFactory();
        expect(
            createBunSqlDatabaseObservabilityCollector({
                connectionResolver: {
                    resolve: () =>
                        Promise.resolve({
                            connection: alternateConnection,
                            source: {
                                containerId: "b".repeat(64),
                                containerPort: 5432,
                            },
                        }),
                },
                sqlClientFactory: factory,
            }).collect()
        ).rejects.toThrow("Database observability collection failed");
        expect(factory.events).toEqual([]);
    });

    test("excludes non-discovered PgBouncer rows from every projection", async () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                if (database === "pgbouncer" && sql === "SHOW POOLS") {
                    return [
                        ...fixtureRows(database, sql),
                        {
                            cl_active: 900,
                            cl_active_cancel_req: 600,
                            cl_waiting: 800,
                            cl_waiting_cancel_req: 500,
                            database: "unreviewed_service",
                            maxwait: 700,
                            sv_active: 400,
                            sv_active_cancel: 300,
                            sv_being_canceled: 200,
                            sv_idle: 500,
                            sv_login: 100,
                            sv_tested: 90,
                            sv_used: 80,
                        },
                    ];
                }
                if (database === "pgbouncer" && sql === "SHOW STATS") {
                    return [
                        ...fixtureRows(database, sql),
                        {
                            avg_query_count: 700,
                            avg_query_time: 900_000,
                            avg_xact_count: 600,
                            avg_xact_time: 800_000,
                            database: "unreviewed_service",
                            total_query_count: 700,
                        },
                    ];
                }
                return fixtureRows(database, sql);
            },
        });

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        }).collect();

        expect(payload.pgbouncer).toMatchObject({
            averageQueryMs: 2,
            averageTransactionMs: 4,
            clientConnections: 3,
            maxWaitSeconds: 3,
            serverConnections: 2,
            waitingClients: 1,
        });
        expect(JSON.stringify(payload)).not.toContain("unreviewed_service");
    });

    test("traffic-weights durations and counts every PgBouncer connection state", async () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                if (database === "pgbouncer" && sql === "SHOW POOLS") {
                    return [
                        {
                            cl_active: 2,
                            cl_active_cancel_req: 3,
                            cl_waiting: 1,
                            cl_waiting_cancel_req: 4,
                            database: "app_a",
                            maxwait: 5,
                            sv_active: 1,
                            sv_active_cancel: 2,
                            sv_being_canceled: 3,
                            sv_idle: 4,
                            sv_login: 7,
                            sv_tested: 6,
                            sv_used: 5,
                        },
                        {
                            cl_active: 1,
                            cl_active_cancel_req: 0,
                            cl_waiting: 0,
                            cl_waiting_cancel_req: 0,
                            database: "app_b",
                            maxwait: 0,
                            sv_active: 1,
                            sv_active_cancel: 0,
                            sv_being_canceled: 0,
                            sv_idle: 0,
                            sv_login: 0,
                            sv_tested: 0,
                            sv_used: 0,
                        },
                    ];
                }
                if (database === "pgbouncer" && sql === "SHOW STATS") {
                    return [
                        {
                            avg_query_count: 1,
                            avg_query_time: 1000,
                            avg_xact_count: 1,
                            avg_xact_time: 2000,
                            database: "app_a",
                            total_query_count: 1,
                        },
                        {
                            avg_query_count: 9,
                            avg_query_time: 10_000,
                            avg_xact_count: 3,
                            avg_xact_time: 6000,
                            database: "app_b",
                            total_query_count: 9,
                        },
                    ];
                }
                return fixtureRows(database, sql);
            },
        });

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        }).collect();

        expect(payload.pgbouncer).toEqual({
            averageQueryMs: 9.1,
            averageTransactionMs: 5,
            clientConnections: 11,
            maxWaitSeconds: 5,
            serverConnections: 29,
            waitingClients: 5,
        });
        expect(payload.databases[0]?.pool).toEqual({
            activeClients: 5,
            activeServers: 6,
            averageQueryMs: 1,
            averageTransactionMs: 2,
            idleServers: 4,
            totalQueries: 1,
            usedServers: 5,
            waitingClients: 5,
        });
        expect(payload.databases[1]?.pool).toEqual({
            activeClients: 1,
            activeServers: 1,
            averageQueryMs: 10,
            averageTransactionMs: 6,
            idleServers: 0,
            totalQueries: 9,
            usedServers: 0,
            waitingClients: 0,
        });
    });

    test("projects PgBouncer stats-only and pool-only databases independently", async () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                if (database === "pgbouncer" && sql === "SHOW POOLS") {
                    return [
                        {
                            cl_active: 2,
                            cl_active_cancel_req: 0,
                            cl_waiting: 1,
                            cl_waiting_cancel_req: 0,
                            database: "app_b",
                            maxwait: 3,
                            sv_active: 1,
                            sv_active_cancel: 0,
                            sv_being_canceled: 0,
                            sv_idle: 4,
                            sv_login: 0,
                            sv_tested: 0,
                            sv_used: 2,
                        },
                    ];
                }
                if (database === "pgbouncer" && sql === "SHOW STATS") {
                    return [
                        {
                            avg_query_count: 4,
                            avg_query_time: 12_000,
                            avg_xact_count: 2,
                            avg_xact_time: 10_000,
                            database: "app_a",
                            total_query_count: 40,
                        },
                    ];
                }
                return fixtureRows(database, sql);
            },
        });

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        }).collect();

        expect(payload.databases.find(({ name }) => name === "app_a")?.pool).toEqual({
            activeClients: 0,
            activeServers: 0,
            averageQueryMs: 12,
            averageTransactionMs: 10,
            idleServers: 0,
            totalQueries: 40,
            usedServers: 0,
            waitingClients: 0,
        });
        expect(payload.databases.find(({ name }) => name === "app_b")?.pool).toEqual({
            activeClients: 2,
            activeServers: 1,
            averageQueryMs: 0,
            averageTransactionMs: 0,
            idleServers: 4,
            totalQueries: 0,
            usedServers: 2,
            waitingClients: 1,
        });
    });

    test("ranks bounded candidates globally and aggregates maintenance across databases", async () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                if (
                    sql.includes(
                        "FROM mira_dashboard_observability_capabilities.maintenance_metrics()"
                    )
                ) {
                    let assessedPhysicalBytes = 0;
                    if (database === "app_a") assessedPhysicalBytes = 25;
                    else if (database === "app_b") {
                        assessedPhysicalBytes = 64 * 1024 * 1024;
                    }
                    return [
                        {
                            assessed_physical_bytes: assessedPhysicalBytes,
                            estimated_reclaimable_bytes: 0,
                            high_dead_tuple_table_count: database === "app_b" ? 1 : 0,
                            unassessed_physical_bytes: 0,
                            unassessed_table_count: 0,
                        },
                    ];
                }
                if (
                    sql.includes(
                        "FROM mira_dashboard_observability_capabilities.table_health()"
                    )
                ) {
                    if (database === "app_a") {
                        return Array.from({ length: 25 }, (_, index) =>
                            tableRow(database, {
                                dead_tuple_percent: 100,
                                dead_tuples: 25 - index,
                                table_name: `app_a_${String(index).padStart(2, "0")}`,
                            })
                        );
                    }
                    return database === "app_b"
                        ? [
                              tableRow(database, {
                                  dead_tuple_percent: 20,
                                  dead_tuples: 1000,
                                  physical_bytes: 64 * 1024 * 1024,
                                  table_name: "material_risk",
                              }),
                          ]
                        : [];
                }
                return fixtureRows(database, sql);
            },
        });

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        }).collect();

        expect(payload.tableHealth).toHaveLength(25);
        expect(payload.tableHealth[0]).toMatchObject({
            database: "app_b",
            table: "material_risk",
        });
        expect(
            payload.tableHealth.filter(({ database }) => database === "app_a")
        ).toHaveLength(24);
        expect(payload.summary.maintenance).toMatchObject({
            assessmentComplete: true,
            assessedPhysicalBytes: 64 * 1024 * 1024 + 25,
            highDeadTupleTableCount: 1,
            status: "review",
            unassessedTableCount: 0,
        });
    });

    test("derives bloat review from canonical aggregate thresholds", async () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                if (sql.includes("FROM pg_database")) {
                    return fixtureRows(database, sql).map((row, index) => ({
                        ...row,
                        size_bytes: (index === 0 ? 6 : 1) * 1024 ** 3,
                    }));
                }
                if (
                    sql.includes(
                        "FROM mira_dashboard_observability_capabilities.maintenance_metrics()"
                    )
                ) {
                    return [
                        {
                            assessed_physical_bytes:
                                database === "app_a" ? 6 * 1024 ** 3 : 0,
                            estimated_reclaimable_bytes:
                                database === "app_a" ? 5 * 1024 ** 3 : 0,
                            high_dead_tuple_table_count: 0,
                            unassessed_physical_bytes: 0,
                            unassessed_table_count: 0,
                        },
                    ];
                }
                if (
                    sql.includes(
                        "FROM mira_dashboard_observability_capabilities.table_health()"
                    )
                ) {
                    return [tableRow(database)];
                }
                return fixtureRows(database, sql);
            },
        });

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        }).collect();

        expect(payload.summary.maintenance).toMatchObject({
            assessedPhysicalBytes: 6 * 1024 ** 3,
            estimatedReclaimableBytes: 5 * 1024 ** 3,
            requiresBloatReview: true,
            status: "review",
        });
        expect(payload.summary.maintenance.estimatedReclaimablePercent).toBeCloseTo(
            250 / 3,
            5
        );
    });

    test("orders equal-risk table health by reclaimable bytes before dead tuples", async () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                if (
                    sql.includes(
                        "FROM mira_dashboard_observability_capabilities.table_health()"
                    )
                ) {
                    if (database !== "app_a") return [];
                    return [
                        tableRow(database, {
                            dead_tuples: 200,
                            estimated_reclaimable_bytes: 1,
                            physical_bytes: 2,
                            table_name: "more_dead",
                        }),
                        tableRow(database, {
                            dead_tuples: 100,
                            estimated_reclaimable_bytes: 2,
                            physical_bytes: 2,
                            table_name: "more_reclaimable",
                        }),
                    ];
                }
                return fixtureRows(database, sql);
            },
        });

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        }).collect();

        expect(payload.tableHealth.slice(0, 2).map(({ table }) => table)).toEqual([
            "more_reclaimable",
            "more_dead",
        ]);
    });

    test("fails closed before per-database work when the catalog exceeds its bound", () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                if (
                    database === controlDatabase &&
                    sql.includes("FROM pg_database") &&
                    !sql.includes("AS total_database_size_bytes")
                ) {
                    return Array.from(
                        { length: databaseObservabilityDatabaseMaximum },
                        (_, index) => ({
                            blks_hit: 1,
                            blks_read: 0,
                            database_count: databaseObservabilityDatabaseMaximum + 1,
                            datname: `database_${String(index).padStart(2, "0")}`,
                            numbackends: 0,
                            size_bytes: 1,
                            xact_commit: 0,
                            xact_rollback: 0,
                        })
                    );
                }
                return fixtureRows(database, sql);
            },
        });

        expect(
            createBunSqlDatabaseObservabilityCollector({
                connectionResolver,
                sqlClientFactory: factory,
            }).collect()
        ).rejects.toThrow("Database observability collection failed");
        expect(factory.events.filter((event) => event.startsWith("create:"))).toEqual([
            `create:${controlDatabase}`,
        ]);
    });

    test("rejects catalog identifiers outside the operator-safe projection boundary", () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                if (
                    database === controlDatabase &&
                    sql.includes("FROM pg_database") &&
                    !sql.includes("AS total_database_size_bytes")
                ) {
                    const rows = fixtureRows(database, sql);
                    const databaseCount = rows.length + 1;
                    return [
                        ...rows.map((row) => ({ ...row, database_count: databaseCount })),
                        {
                            blks_hit: 1,
                            blks_read: 0,
                            database_count: databaseCount,
                            datname: " \u2028 ",
                            numbackends: 0,
                            size_bytes: 1,
                            xact_commit: 0,
                            xact_rollback: 0,
                        },
                    ];
                }
                return fixtureRows(database, sql);
            },
        });

        expect(
            createBunSqlDatabaseObservabilityCollector({
                connectionResolver,
                sqlClientFactory: factory,
            }).collect()
        ).rejects.toThrow("Database observability collection failed");
        expect(factory.events.filter((event) => event.startsWith("create:"))).toEqual([
            `create:${controlDatabase}`,
        ]);
    });

    test("rolls back, closes, and isolates one failed database detail query", async () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                if (
                    database === "app_a" &&
                    sql.includes(
                        "FROM mira_dashboard_observability_capabilities.table_health()"
                    )
                ) {
                    throw new Error("private query failure");
                }
                return fixtureRows(database, sql);
            },
        });

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        }).collect();
        expect(payload.databases.find(({ name }) => name === "app_a")?.detailsState).toBe(
            "unavailable"
        );
        expect(factory.events).toContain("query:app_a:ROLLBACK");
        expect(factory.events).toContain("close:app_a");
        expect(factory.events).toContain("create:app_b");
    });

    test("cancels and closes an active query on cooperative abort", async () => {
        const probe = fixtureFactory();
        const databaseSql = probe.events;
        const firstFactory = fixtureFactory({ events: databaseSql });
        const collector = createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: firstFactory,
        });
        const abort = new AbortController();
        // Discover the exact source-owned database query string without accepting
        // arbitrary SQL through the fixture boundary.
        await collector.collect();
        const target = firstFactory.events
            .find((event) => event.startsWith("query:mira_dashboard_observability:"))!
            .slice("query:".length);

        const factory = fixtureFactory({ hangAt: target });
        const pending = createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        }).collect(abort.signal);
        await Promise.resolve();
        abort.abort();

        expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(
            factory.events.some((event) => event.startsWith(`cancel:${controlDatabase}:`))
        ).toBe(true);
        expect(factory.events).toContain(`close:${controlDatabase}`);
    });

    test("fails unavailable without opening a client when unprovisioned", () => {
        const factory = fixtureFactory();
        const collector = createBunSqlDatabaseObservabilityCollector({
            sqlClientFactory: factory,
        });
        expect(collector.collect()).rejects.toThrow(
            "Database observability monitoring is unavailable"
        );
        expect(factory.events).toEqual([]);
    });

    test("rejects raw PgBouncer aggregate overflow and closes the admin client", () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                if (database === "pgbouncer" && sql === "SHOW POOLS") {
                    return Array.from(
                        { length: 513 },
                        () => fixtureRows(database, sql)[0]!
                    );
                }
                return fixtureRows(database, sql);
            },
        });
        const collector = createBunSqlDatabaseObservabilityCollector({
            connectionResolver,
            sqlClientFactory: factory,
        });
        expect(collector.collect()).rejects.toThrow(
            "Database observability collection failed"
        );
        expect(factory.events).toContain("close:pgbouncer");
    });
});
