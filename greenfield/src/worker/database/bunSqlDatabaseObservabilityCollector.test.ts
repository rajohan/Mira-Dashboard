import { describe, expect, test } from "bun:test";

import { Redacted } from "effect";

import {
    databaseObservabilityControlDatabase,
    databaseObservabilityMetricDatabases,
    databaseObservabilityPgBouncerVirtualDatabase,
    databaseObservabilityReviewedPostgreSqlDatabases,
    databaseObservabilityTorrentCountDatabases,
} from "../../shared/databaseObservabilityPolicy.ts";
import {
    createBunSqlDatabaseObservabilityCollector,
    type DatabaseObservabilitySqlClient,
    type DatabaseObservabilitySqlClientFactory,
} from "./bunSqlDatabaseObservabilityCollector.ts";

const connectionUrl = Object.freeze(
    Redacted.make(
        "postgresql://mira_dashboard_observer:private-password@127.0.0.1:6432/postgres",
        {
            label: "database-observability-url",
        }
    )
);
const metricDatabases = databaseObservabilityMetricDatabases;

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
        create(_baseUrl: Redacted.Redacted<string>, database: string) {
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
                canCreateCurrentDatabase: false,
                canCreateDatabase: false,
                canCreateRole: false,
                canCreateSchema: false,
                canCreateTemporaryTables: false,
                canReplicate: false,
                canLogin: true,
                connectableDatabases: databaseObservabilityReviewedPostgreSqlDatabases,
                connectionLimit: 1,
                currentDatabase: database,
                directMemberships: ["pg_monitor", "pg_read_all_stats"],
                hasBaseTableAuthority: false,
                hasMembershipAdministration: false,
                hasSequenceAuthority: false,
                hasUnexpectedRelationAuthority: false,
                inheritsPrivileges: true,
                isPgMonitor: true,
                isSuperuser: false,
                isViewOwner: false,
                pgStatStatementsExtensionInstalled:
                    database === databaseObservabilityControlDatabase,
                pgStatStatementsRelationValid:
                    database === databaseObservabilityControlDatabase,
                roleName: "mira_dashboard_observer",
                roleConfiguration: [
                    "default_transaction_read_only=on",
                    "statement_timeout=5s",
                ],
            },
        ];
    }
    if (sql.includes("FROM pg_database")) {
        return metricDatabases.map((database) => {
            let numbackends = 0;
            let sizeBytes = 0;
            let committedTransactions = 0;
            let rolledBackTransactions = 0;
            if (database === "aiomanager") {
                numbackends = 2;
                sizeBytes = 100 * 1024 * 1024;
                committedTransactions = 10;
                rolledBackTransactions = 1;
            } else if (database === "aiometadata") {
                numbackends = 1;
                sizeBytes = 50 * 1024 * 1024;
                committedTransactions = 20;
                rolledBackTransactions = 2;
            }
            return {
                blks_hit: database === "aiomanager" ? 75 : 0,
                blks_read: database === "aiomanager" ? 25 : 0,
                database_count: metricDatabases.length,
                datname: database,
                numbackends,
                size_bytes: sizeBytes,
                xact_commit: committedTransactions,
                xact_rollback: rolledBackTransactions,
            };
        });
    }
    if (sql.includes("FROM pg_stat_activity")) {
        return [
            {
                active_connections: 1,
                idle_connections: 2,
                total_connections: 3,
            },
        ];
    }
    if (
        sql.includes("FROM pg_stat_user_tables") &&
        sql.includes("AS assessed_physical_bytes")
    ) {
        return [
            {
                assessed_physical_bytes: database === "aiomanager" ? 64 * 1024 * 1024 : 0,
                estimated_reclaimable_bytes:
                    database === "aiomanager" ? 10 * 1024 * 1024 : 0,
                high_dead_tuple_table_count: database === "aiomanager" ? 1 : 0,
                unassessed_physical_bytes: database === "aiometadata" ? 10 : 0,
                unassessed_table_count: database === "aiometadata" ? 1 : 0,
            },
        ];
    }
    if (sql.includes("FROM pg_stat_user_tables")) {
        if (!["aiomanager", "aiometadata"].includes(database)) return [];
        return [
            tableRow(database, {
                assessed: database === "aiomanager",
                dead_tuple_percent: database === "aiomanager" ? 20 : 1,
                dead_tuples: database === "aiomanager" ? 2000 : 1,
                estimated_reclaimable_bytes:
                    database === "aiomanager" ? 10 * 1024 * 1024 : null,
                last_autoanalyze_at_ms: null,
                last_autovacuum_at_ms: null,
                live_tuples: 10_000,
                physical_bytes: database === "aiomanager" ? 64 * 1024 * 1024 : 10,
            }),
        ];
    }
    if (sql.includes("FROM pg_catalog.pg_extension")) {
        return [{ enabled: database === databaseObservabilityControlDatabase }];
    }
    if (sql.includes("FROM public.pg_stat_statements")) {
        if (database !== databaseObservabilityControlDatabase) {
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
                cl_waiting: 1,
                database: "aiomanager",
                maxwait: 3,
                sv_active: 1,
                sv_idle: 1,
                sv_used: 0,
            },
        ];
    }
    if (sql === "SHOW STATS") {
        return [
            {
                avg_query_time: 2000,
                avg_xact_time: 4000,
                database: "aiomanager",
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
            connectionUrl,
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
                    assessmentComplete: false,
                    assessedPhysicalBytes: 64 * 1024 * 1024,
                    estimatedReclaimableBytes: 10 * 1024 * 1024,
                    estimatedReclaimablePercent: 15.625,
                    highDeadTupleTableCount: 1,
                    slowStatementCount: 0,
                    status: "review",
                    unassessedTableCount: 1,
                },
                totalDatabaseSizeBytes: 150 * 1024 * 1024,
            },
            torrentCounts: {
                bitmagnet: { count: 42, state: "available" },
                comet: { count: 84, state: "available" },
            },
        });
        expect(payload.databases).toHaveLength(metricDatabases.length);
        expect(payload.databases.map(({ name }) => name)).toEqual(metricDatabases);
        expect(payload.databases[0]).toMatchObject({
            cacheHitRatio: 75,
            name: "aiomanager",
            pool: {
                activeClients: 2,
                averageQueryMs: 2,
                totalQueries: 12,
                waitingClients: 1,
            },
        });
        expect(payload.databases[1]).toMatchObject({
            cacheHitRatio: 100,
            name: "aiometadata",
        });
        expect(payload.tableHealth.map(({ database }) => database)).toEqual([
            "aiomanager",
            "aiometadata",
        ]);
        const postgresqlConnections = [
            databaseObservabilityControlDatabase,
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
            expect(queries.slice(0, 4)).toEqual([
                `query:${database}:BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
                `query:${database}:SET LOCAL statement_timeout = '5s'`,
                `query:${database}:SET LOCAL search_path = pg_catalog`,
                expect.stringContaining(
                    `query:${database}:WITH pg_stat_statements_extension AS`
                ),
            ]);
        }
        expect(
            factory.events.some((event) => event.startsWith("query:pgbouncer:SET"))
        ).toBe(false);
        expect(factory.events.find((event) => event.startsWith("query:pgbouncer:"))).toBe(
            "query:pgbouncer:SHOW POOLS"
        );
        for (const database of ["aiomanager", "aiometadata"]) {
            const queries = factory.events.filter((event) =>
                event.startsWith(`query:${database}:`)
            );
            expect(queries[0]).toBe(
                `query:${database}:BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
            );
            expect(queries[1]).toBe(
                `query:${database}:SET LOCAL statement_timeout = '5s'`
            );
            expect(queries[2]).toBe(
                `query:${database}:SET LOCAL search_path = pg_catalog`
            );
            expect(
                queries.some(
                    (query) =>
                        query.includes("FROM pg_stat_user_tables") &&
                        query.includes("AS assessed_physical_bytes")
                )
            ).toBe(true);
            expect(
                queries.some(
                    (query) =>
                        query.includes("FROM pg_stat_user_tables") &&
                        !query.includes("AS assessed_physical_bytes")
                )
            ).toBe(true);
            expect(queries.at(-1)).toBe(`query:${database}:COMMIT`);
        }
        expect(
            factory.events.filter(
                (event) =>
                    event.startsWith("query:postgres:") &&
                    event.includes("FROM pg_database")
            )
        ).toHaveLength(1);
        expect(
            factory.events.filter((event) =>
                event.includes("FROM pg_catalog.pg_extension")
            )
        ).toEqual([expect.stringContaining("query:postgres:")]);
        expect(
            factory.events.filter((event) =>
                event.includes("FROM public.pg_stat_statements")
            )
        ).toEqual([expect.stringContaining("query:postgres:")]);
        expect(factory.events).toContain(
            `values:postgres:[["aiomanager","aiometadata","aiostreams","authelia","bitmagnet","comet","crowdsec","metabase","speedtest_tracker"],16]`
        );
        expect(factory.events).toContain(
            `values:aiomanager:[10,1000,20,${5 * 1024 ** 3},${64 * 1024 ** 2},20,1000,25]`
        );
        expect(factory.events).toContain(
            `values:aiomanager:[10,1000,20,${5 * 1024 ** 3},${64 * 1024 ** 2},20,1000]`
        );
        expect(factory.events).toContain(
            `values:postgres:[["aiomanager","aiometadata","aiostreams","authelia","bitmagnet","comet","crowdsec","metabase","speedtest_tracker"],20]`
        );
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
            connectionUrl,
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
            { connectionLimit: 2 },
            { roleConfiguration: ["statement_timeout=5s"] },
            {
                directMemberships: [
                    "application_role",
                    "pg_monitor",
                    "pg_read_all_stats",
                ],
            },
            { hasMembershipAdministration: true },
            {
                connectableDatabases: [
                    ...databaseObservabilityReviewedPostgreSqlDatabases,
                    "template1",
                ],
            },
            { currentDatabase: "template1" },
            { canCreateCurrentDatabase: true },
            { canCreateTemporaryTables: true },
            { canCreateSchema: true },
            { hasBaseTableAuthority: true },
            { hasUnexpectedRelationAuthority: true },
            { hasSequenceAuthority: true },
            { pgStatStatementsRelationValid: false },
            {
                pgStatStatementsExtensionInstalled: false,
                pgStatStatementsRelationValid: true,
            },
            { isPgMonitor: false },
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
                    connectionUrl,
                    sqlClientFactory: factory,
                }).collect()
            ).rejects.toThrow("Database observability collection failed");
            expect(factory.events).toContain("query:postgres:ROLLBACK");
            expect(
                factory.events.some((event) => event.includes("FROM pg_database"))
            ).toBe(false);
            expect(factory.events.filter((event) => event.startsWith("create:"))).toEqual(
                ["create:postgres"]
            );
        }
    });

    test("revalidates the monitoring principal before each metric database read", () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                const rows = fixtureRows(database, sql);
                return database === "aiomanager" && sql.includes("pg_roles AS roles")
                    ? [{ ...rows[0], isSuperuser: true }]
                    : rows;
            },
        });

        expect(
            createBunSqlDatabaseObservabilityCollector({
                connectionUrl,
                sqlClientFactory: factory,
            }).collect()
        ).rejects.toThrow("Database observability collection failed");
        expect(factory.events).toContain("query:aiomanager:ROLLBACK");
        expect(
            factory.events.some(
                (event) =>
                    event.startsWith("query:aiomanager:") &&
                    event.includes("FROM pg_stat_user_tables")
            )
        ).toBe(false);
        expect(factory.events).not.toContain("create:aiometadata");
    });

    test("rejects pg_stat_statements outside the fixed control database", () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                const rows = fixtureRows(database, sql);
                return database === "aiomanager" && sql.includes("pg_roles AS roles")
                    ? [
                          {
                              ...rows[0],
                              pgStatStatementsExtensionInstalled: true,
                              pgStatStatementsRelationValid: true,
                          },
                      ]
                    : rows;
            },
        });

        expect(
            createBunSqlDatabaseObservabilityCollector({
                connectionUrl,
                sqlClientFactory: factory,
            }).collect()
        ).rejects.toThrow("Database observability collection failed");
        expect(factory.events).toContain("query:aiomanager:ROLLBACK");
        expect(
            factory.events.some(
                (event) =>
                    event.startsWith("query:aiomanager:") &&
                    event.includes("FROM pg_stat_user_tables")
            )
        ).toBe(false);
    });

    test("revalidates the monitoring principal before each torrent-count read", () => {
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

        expect(
            createBunSqlDatabaseObservabilityCollector({
                connectionUrl,
                sqlClientFactory: factory,
            }).collect()
        ).rejects.toThrow("Database observability collection failed");
        expect(bitmagnetPolicyChecks).toBe(2);
        expect(
            factory.events.some(
                (event) =>
                    event.startsWith("query:bitmagnet:") &&
                    event.includes("FROM mira_dashboard_observability.torrent_count")
            )
        ).toBe(false);
        expect(factory.events).not.toContain("create:pgbouncer");
    });

    test("fails closed when the connectable reviewed inventory is incomplete", () => {
        const missingDatabase = "aiostreams";
        const factory = fixtureFactory({
            rows(database, sql) {
                const rows = fixtureRows(database, sql);
                if (database !== "postgres" || !sql.includes("FROM pg_database")) {
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

        expect(
            createBunSqlDatabaseObservabilityCollector({
                connectionUrl,
                sqlClientFactory: factory,
            }).collect()
        ).rejects.toThrow("Database observability collection failed");
        expect(factory.events.filter((event) => event.startsWith("create:"))).toEqual([
            "create:postgres",
        ]);
        const inventoryQuery = factory.events.find(
            (event) =>
                event.startsWith("query:postgres:") && event.includes("FROM pg_database")
        );
        expect(inventoryQuery).toContain("databases.datallowconn = true");
        expect(inventoryQuery).toContain(
            "has_database_privilege(current_user, stats.datname, 'CONNECT')"
        );
    });

    test("reads statement metrics once from the control database", async () => {
        const factory = fixtureFactory();

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionUrl,
            sqlClientFactory: factory,
        }).collect();

        expect(payload.summary.pgStatStatementsEnabled).toBe(true);
        expect(payload.statements).toEqual([
            expect.objectContaining({ calls: 4, rank: 1, totalExecutionMs: 480 }),
        ]);
        expect(
            factory.events.filter((event) =>
                event.includes("FROM pg_catalog.pg_extension")
            )
        ).toEqual([expect.stringContaining("query:postgres:")]);
        expect(
            factory.events.filter((event) =>
                event.includes("FROM public.pg_stat_statements")
            )
        ).toEqual([expect.stringContaining("query:postgres:")]);
        const statementQuery = factory.events.find((event) =>
            event.includes("FROM public.pg_stat_statements")
        );
        expect(statementQuery).toContain("JOIN pg_catalog.pg_database AS databases");
        expect(statementQuery).toContain("databases.datname = ANY(?::text[])");
        const policyQuery = factory.events.find(
            (event) =>
                event.startsWith("query:postgres:") &&
                event.includes("pg_stat_statements_extension")
        );
        expect(policyQuery).toContain("extensions.extnamespace");
        expect(policyQuery).toContain("extension.extension_version = '1.12'");
        expect(policyQuery).toContain("extension.extension_schema = 'public'");
        expect(policyQuery).toContain("FROM pg_catalog.pg_depend AS dependencies");
        expect(policyQuery).toContain("dependencies.deptype = 'e'");
        expect(policyQuery).toContain("extension.extension_owner_superuser");
        expect(policyQuery).toContain("'pg_stat_statements_info'");
        expect(
            policyQuery?.match(
                /'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'/gu
            )
        ).toHaveLength(2);
        expect(
            policyQuery?.match(
                /'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'/gu
            )
        ).toHaveLength(2);
        expect(policyQuery).not.toMatch(
            /'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'/u
        );
        expect(policyQuery).toContain("attributes.attrelid = (");
        expect(factory.events).toContain(
            `values:postgres:[["aiomanager","aiometadata","aiostreams","authelia","bitmagnet","comet","crowdsec","metabase","speedtest_tracker"],20]`
        );
    });

    test("excludes unreviewed PgBouncer rows from every projection", async () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                if (database === "pgbouncer" && sql === "SHOW POOLS") {
                    return [
                        ...fixtureRows(database, sql),
                        {
                            cl_active: 900,
                            cl_waiting: 800,
                            database: "unreviewed_service",
                            maxwait: 700,
                            sv_active: 600,
                            sv_idle: 500,
                            sv_used: 400,
                        },
                    ];
                }
                if (database === "pgbouncer" && sql === "SHOW STATS") {
                    return [
                        ...fixtureRows(database, sql),
                        {
                            avg_query_time: 900_000,
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
            connectionUrl,
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

    test("ranks bounded candidates globally and aggregates maintenance across databases", async () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                if (
                    sql.includes("FROM pg_stat_user_tables") &&
                    sql.includes("AS assessed_physical_bytes")
                ) {
                    let assessedPhysicalBytes = 0;
                    if (database === "aiomanager") assessedPhysicalBytes = 25;
                    else if (database === "aiometadata") {
                        assessedPhysicalBytes = 64 * 1024 * 1024;
                    }
                    return [
                        {
                            assessed_physical_bytes: assessedPhysicalBytes,
                            estimated_reclaimable_bytes: 0,
                            high_dead_tuple_table_count:
                                database === "aiometadata" ? 1 : 0,
                            unassessed_physical_bytes: 0,
                            unassessed_table_count: 0,
                        },
                    ];
                }
                if (sql.includes("FROM pg_stat_user_tables")) {
                    if (database === "aiomanager") {
                        return Array.from({ length: 25 }, (_, index) =>
                            tableRow(database, {
                                dead_tuple_percent: 100,
                                dead_tuples: 25 - index,
                                table_name: `aiomanager_${String(index).padStart(2, "0")}`,
                            })
                        );
                    }
                    return database === "aiometadata"
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
            connectionUrl,
            sqlClientFactory: factory,
        }).collect();

        expect(payload.tableHealth).toHaveLength(25);
        expect(payload.tableHealth[0]).toMatchObject({
            database: "aiometadata",
            table: "material_risk",
        });
        expect(
            payload.tableHealth.filter(({ database }) => database === "aiomanager")
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
                    sql.includes("FROM pg_stat_user_tables") &&
                    sql.includes("AS assessed_physical_bytes")
                ) {
                    return [
                        {
                            assessed_physical_bytes:
                                database === "aiomanager" ? 6 * 1024 ** 3 : 0,
                            estimated_reclaimable_bytes:
                                database === "aiomanager" ? 5 * 1024 ** 3 : 0,
                            high_dead_tuple_table_count: 0,
                            unassessed_physical_bytes: 0,
                            unassessed_table_count: 0,
                        },
                    ];
                }
                if (sql.includes("FROM pg_stat_user_tables")) {
                    return [tableRow(database)];
                }
                return fixtureRows(database, sql);
            },
        });

        const payload = await createBunSqlDatabaseObservabilityCollector({
            connectionUrl,
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

    test("fails closed before per-database work when the catalog exceeds sixteen", () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                if (
                    database === "postgres" &&
                    sql.includes("FROM pg_database") &&
                    !sql.includes("AS total_database_size_bytes")
                ) {
                    return Array.from({ length: 16 }, (_, index) => ({
                        blks_hit: 1,
                        blks_read: 0,
                        database_count: 17,
                        datname: `database_${String(index).padStart(2, "0")}`,
                        numbackends: 0,
                        size_bytes: 1,
                        xact_commit: 0,
                        xact_rollback: 0,
                    }));
                }
                return fixtureRows(database, sql);
            },
        });

        expect(
            createBunSqlDatabaseObservabilityCollector({
                connectionUrl,
                sqlClientFactory: factory,
            }).collect()
        ).rejects.toThrow("Database observability collection failed");
        expect(factory.events.filter((event) => event.startsWith("create:"))).toEqual([
            "create:postgres",
        ]);
    });

    test("rolls back and closes when a snapshot query fails", () => {
        const factory = fixtureFactory({
            rows(database, sql) {
                if (
                    database === "aiomanager" &&
                    sql.includes("FROM pg_stat_user_tables") &&
                    !sql.includes("AS assessed_physical_bytes")
                ) {
                    throw new Error("private query failure");
                }
                return fixtureRows(database, sql);
            },
        });

        expect(
            createBunSqlDatabaseObservabilityCollector({
                connectionUrl,
                sqlClientFactory: factory,
            }).collect()
        ).rejects.toThrow("Database observability collection failed");
        expect(factory.events).toContain("query:aiomanager:ROLLBACK");
        expect(factory.events).toContain("close:aiomanager");
        expect(factory.events).not.toContain("create:aiometadata");
    });

    test("cancels and closes an active query on cooperative abort", async () => {
        const probe = fixtureFactory();
        const databaseSql = probe.events;
        const firstFactory = fixtureFactory({ events: databaseSql });
        const collector = createBunSqlDatabaseObservabilityCollector({
            connectionUrl,
            sqlClientFactory: firstFactory,
        });
        const abort = new AbortController();
        // Discover the exact source-owned database query string without accepting
        // arbitrary SQL through the fixture boundary.
        await collector.collect();
        const target = firstFactory.events
            .find((event) => event.startsWith("query:postgres:"))!
            .slice("query:".length);

        const factory = fixtureFactory({ hangAt: target });
        const pending = createBunSqlDatabaseObservabilityCollector({
            connectionUrl,
            sqlClientFactory: factory,
        }).collect(abort.signal);
        await Promise.resolve();
        abort.abort();

        expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(factory.events.some((event) => event.startsWith("cancel:postgres:"))).toBe(
            true
        );
        expect(factory.events).toContain("close:postgres");
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
            connectionUrl,
            sqlClientFactory: factory,
        });
        expect(collector.collect()).rejects.toThrow(
            "Database observability collection failed"
        );
        expect(factory.events).toContain("close:pgbouncer");
    });
});
