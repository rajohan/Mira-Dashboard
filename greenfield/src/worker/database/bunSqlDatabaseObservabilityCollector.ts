import { Redacted } from "effect";
import * as v from "valibot";

import {
    type DatabaseObservabilityCachePayload,
    databaseObservabilityBloatReviewBytes,
    databaseObservabilityBloatReviewMinimumBytes,
    databaseObservabilityBloatReviewPercent,
    databaseObservabilityCachePayloadMaximumBytes,
    databaseObservabilityCachePayloadSchema,
    databaseObservabilityDatabaseMaximum,
    databaseObservabilityHighDeadTupleMinimum,
    databaseObservabilityHighDeadTupleMinimumBytes,
    databaseObservabilityHighDeadTuplePercent,
    databaseObservabilitySlowStatementMeanMs,
    databaseObservabilityStatementMaximum,
    databaseObservabilityTableHealthMaximum,
} from "../../contracts/database.ts";
import type { DatabaseObservabilityCollector } from "../../contracts/databaseObservabilityCollector.ts";
import {
    databaseObservabilityControlDatabase,
    databaseObservabilityMetricDatabases,
    databaseObservabilityObserverRole,
    databaseObservabilityPgBouncerVirtualDatabase,
    databaseObservabilityReviewedPostgreSqlDatabases,
    databaseObservabilityTorrentCountDatabases,
    databaseObservabilityViewOwnerRole,
    type DatabaseObservabilityReviewedPostgreSqlDatabase,
} from "../../shared/databaseObservabilityPolicy.ts";
import { utf8ByteLength } from "../../shared/encoding.ts";
import { compareStrings } from "../../shared/validation.ts";

/** Maximum raw PgBouncer rows admitted before aggregate projection. */
export const databaseObservabilityPgBouncerInputMaximum = 512;
export const databaseObservabilityConnectTimeoutSeconds = 5;
export const databaseObservabilityDeadlineMs = 60_000;

const catalogTupleEstimateTolerancePercent = 10;
type SqlQuery<T> = Promise<T> & {
    cancel(): unknown;
    simple(): SqlQuery<T>;
};
export type DatabaseObservabilitySqlClient = {
    <T>(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery<T>;
    close(options?: { timeout?: number }): Promise<void>;
    connect(): Promise<unknown>;
};

export interface DatabaseObservabilitySqlClientFactory {
    create(
        baseUrl: Redacted.Redacted<string>,
        database: string
    ): DatabaseObservabilitySqlClient;
}

interface DatabaseRow {
    blks_hit: unknown;
    blks_read: unknown;
    datname: unknown;
    database_count: unknown;
    numbackends: unknown;
    size_bytes: unknown;
    xact_commit: unknown;
    xact_rollback: unknown;
}

interface ConnectionRow {
    active_connections: unknown;
    idle_connections: unknown;
    total_connections: unknown;
}

interface ObserverPolicyRow {
    bypassRowLevelSecurity: unknown;
    canLogin: unknown;
    canCreateDatabase: unknown;
    canCreateCurrentDatabase: unknown;
    canCreateRole: unknown;
    canCreateSchema: unknown;
    canCreateTemporaryTables: unknown;
    canReplicate: unknown;
    connectableDatabases: unknown;
    connectionLimit: unknown;
    currentDatabase: unknown;
    directMemberships: unknown;
    hasBaseTableAuthority: unknown;
    hasMembershipAdministration: unknown;
    hasSequenceAuthority: unknown;
    hasUnexpectedRelationAuthority: unknown;
    inheritsPrivileges: unknown;
    isPgMonitor: unknown;
    isSuperuser: unknown;
    isViewOwner: unknown;
    pgStatStatementsExtensionInstalled: unknown;
    pgStatStatementsRelationValid: unknown;
    roleName: unknown;
    roleConfiguration: unknown;
}

interface TableHealthRow {
    assessed: unknown;
    dead_tuple_percent: unknown;
    dead_tuples: unknown;
    estimated_reclaimable_bytes: unknown;
    live_tuples: unknown;
    last_autoanalyze_at_ms: unknown;
    last_autovacuum_at_ms: unknown;
    physical_bytes: unknown;
    schema_name: unknown;
    table_name: unknown;
}

interface MaintenanceRow {
    assessed_physical_bytes: unknown;
    estimated_reclaimable_bytes: unknown;
    high_dead_tuple_table_count: unknown;
    unassessed_physical_bytes: unknown;
    unassessed_table_count: unknown;
}

interface ExtensionRow {
    enabled: unknown;
}

interface StatementRow {
    calls: unknown;
    mean_execution_ms: unknown;
    rows: unknown;
    shared_blocks_hit: unknown;
    shared_blocks_read: unknown;
    total_execution_ms: unknown;
}

interface TorrentCountRow {
    count: unknown;
}

interface PgBouncerPoolRow {
    database: unknown;
    cl_active: unknown;
    cl_waiting: unknown;
    maxwait: unknown;
    sv_active: unknown;
    sv_idle: unknown;
    sv_used: unknown;
}

interface PgBouncerStatsRow {
    avg_query_time: unknown;
    avg_xact_time: unknown;
    database: unknown;
    total_query_count: unknown;
}

class ObserverPolicyViolationError extends Error {}

function derivedConnectionUrl(
    baseUrl: Redacted.Redacted<string>,
    database: string
): string {
    const source = new URL(Redacted.value(baseUrl));
    if (
        !["postgres:", "postgresql:"].includes(source.protocol) ||
        source.hostname !== "127.0.0.1" ||
        source.port !== "6432" ||
        source.pathname !== "/postgres" ||
        source.search !== "" ||
        source.hash !== ""
    ) {
        throw new TypeError("Database observability endpoint is invalid");
    }
    source.pathname = `/${encodeURIComponent(name(database))}`;
    return source.href;
}

function defaultSqlClientFactory(): DatabaseObservabilitySqlClientFactory {
    return Object.freeze({
        create(
            baseUrl: Redacted.Redacted<string>,
            database: string
        ): DatabaseObservabilitySqlClient {
            return new Bun.SQL({
                adapter: "postgres",
                connectionTimeout: databaseObservabilityConnectTimeoutSeconds,
                idleTimeout: databaseObservabilityConnectTimeoutSeconds,
                max: 1,
                prepare: false,
                tls: false,
                url: derivedConnectionUrl(baseUrl, database),
            }) as DatabaseObservabilitySqlClient;
        },
    });
}

function finiteNumber(value: unknown): number {
    const number = Number(value);
    if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) {
        throw new TypeError("Database observability numeric row is invalid");
    }
    return number;
}

function count(value: unknown): number {
    const number = finiteNumber(value);
    if (!Number.isSafeInteger(number) || number < 0) {
        throw new TypeError("Database observability count row is invalid");
    }
    return number;
}

function nonnegativeNumber(value: unknown): number {
    const number = finiteNumber(value);
    if (number < 0) {
        throw new TypeError("Database observability metric row is invalid");
    }
    return number;
}

function name(value: unknown): string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 128 ||
        /[\p{Cc}\p{Cf}]/u.test(value)
    ) {
        throw new TypeError("Database observability name row is invalid");
    }
    return value;
}

function booleanValue(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (value === "t" || value === "true" || value === 1) return true;
    if (value === "f" || value === "false" || value === 0) return false;
    throw new TypeError("Database observability boolean row is invalid");
}

function exactNames(value: unknown, expected: readonly string[]): boolean {
    return (
        Array.isArray(value) &&
        value.length === expected.length &&
        value.every((candidate, index) => name(candidate) === expected[index])
    );
}

function assertRows<T>(value: unknown, maximum: number): readonly T[] {
    if (!Array.isArray(value) || value.length > maximum) {
        throw new TypeError("Database observability query row budget exceeded");
    }
    return value as readonly T[];
}

function signalFailure(): Error {
    return new DOMException("Database observability collection aborted", "AbortError");
}

function collectionFailure(): Error {
    return new Error("Database observability collection failed");
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signalFailure();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signalFailure());
        signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
        return await Promise.race([operation, aborted]);
    } finally {
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
}

async function executeQuery<T>(
    query: SqlQuery<T[]>,
    signal: AbortSignal
): Promise<readonly T[]> {
    if (signal.aborted) {
        query.cancel();
        throw signalFailure();
    }
    const cancel = () => {
        query.cancel();
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
        return await query;
    } finally {
        signal.removeEventListener("abort", cancel);
    }
}

async function withClient<T>(
    factory: DatabaseObservabilitySqlClientFactory,
    baseUrl: Redacted.Redacted<string>,
    database: string,
    signal: AbortSignal,
    operation: (client: DatabaseObservabilitySqlClient) => Promise<T>
): Promise<T> {
    if (signal.aborted) throw signalFailure();
    const client = factory.create(baseUrl, database);
    const closeOnAbort = () => {
        void client.close({ timeout: 0 }).catch(() => {});
    };
    signal.addEventListener("abort", closeOnAbort, { once: true });
    try {
        await abortable(client.connect(), signal);
        return await operation(client);
    } finally {
        signal.removeEventListener("abort", closeOnAbort);
        await client.close({ timeout: 0 }).catch(() => {});
    }
}

async function withReadOnlySnapshot<T>(
    client: DatabaseObservabilitySqlClient,
    signal: AbortSignal,
    operation: () => Promise<T>
): Promise<T> {
    await executeQuery(
        client<never[]>`
            BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY
        `,
        signal
    );
    try {
        await executeQuery(client<never[]>`SET LOCAL statement_timeout = '5s'`, signal);
        await executeQuery(client<never[]>`SET LOCAL search_path = pg_catalog`, signal);
        const result = await operation();
        await executeQuery(client<never[]>`COMMIT`, signal);
        return result;
    } catch (error) {
        if (!signal.aborted) {
            await executeQuery(client<never[]>`ROLLBACK`, signal).catch(() => {});
        }
        throw error;
    }
}

function databaseRowsQuery(client: DatabaseObservabilitySqlClient) {
    return client<DatabaseRow[]>`
        WITH reviewed_databases AS (
          SELECT stats.datname,
                 pg_database_size(stats.datname)::bigint AS size_bytes,
                 stats.numbackends::bigint,
                 stats.xact_commit::bigint,
                 stats.xact_rollback::bigint,
                 stats.blks_hit::bigint,
                 stats.blks_read::bigint
          FROM pg_database AS databases
          JOIN pg_stat_database AS stats ON stats.datid = databases.oid
          WHERE databases.datistemplate = false
            AND databases.datallowconn = true
            AND stats.datname = ANY(${databaseObservabilityMetricDatabases}::text[])
            AND has_database_privilege(current_user, stats.datname, 'CONNECT')
        )
        SELECT reviewed_databases.*,
               COUNT(*) OVER ()::bigint AS database_count
        FROM reviewed_databases
        ORDER BY datname
        LIMIT ${databaseObservabilityDatabaseMaximum}
    `;
}

function connectionRowsQuery(client: DatabaseObservabilitySqlClient) {
    return client<ConnectionRow[]>`
        SELECT
          COUNT(*) FILTER (WHERE state = 'active')::bigint AS active_connections,
          COUNT(*) FILTER (WHERE state = 'idle')::bigint AS idle_connections,
          COUNT(*)::bigint AS total_connections
        FROM pg_stat_activity
        WHERE datname = ANY(${databaseObservabilityMetricDatabases}::text[])
    `;
}

function observerPolicyRowsQuery(client: DatabaseObservabilitySqlClient) {
    return client<ObserverPolicyRow[]>`
        WITH pg_stat_statements_extension AS (
          SELECT extensions.oid AS extension_oid,
                 extensions.extowner AS extension_owner_oid,
                 extensions.extversion AS extension_version,
                 namespaces.nspname AS extension_schema,
                 extension_owners.rolname AS extension_owner_name,
                 extension_owners.rolsuper AS extension_owner_superuser
          FROM (VALUES (true)) AS anchor(present)
          LEFT JOIN pg_catalog.pg_extension AS extensions
            ON extensions.extname = 'pg_stat_statements'
          LEFT JOIN pg_catalog.pg_namespace AS namespaces
            ON namespaces.oid = extensions.extnamespace
          LEFT JOIN pg_catalog.pg_roles AS extension_owners
            ON extension_owners.oid = extensions.extowner
        ), pg_stat_statements_relations AS (
          SELECT extension.extension_oid,
                 extension.extension_owner_oid,
                 extension.extension_version,
                 extension.extension_schema,
                 extension.extension_owner_name,
                 extension.extension_owner_superuser,
                 relations.oid AS relation_oid,
                 relations.relname AS relation_name,
                 relations.relkind AS relation_kind,
                 relations.relowner AS relation_owner_oid,
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_depend AS dependencies
                   WHERE dependencies.classid =
                       'pg_catalog.pg_class'::pg_catalog.regclass
                     AND dependencies.objid = relations.oid
                     AND dependencies.objsubid = 0
                     AND dependencies.refclassid =
                       'pg_catalog.pg_extension'::pg_catalog.regclass
                     AND dependencies.refobjid = extension.extension_oid
                     AND dependencies.deptype = 'e'
                 ) AS extension_owned,
                 pg_catalog.has_table_privilege(
                   current_user,
                   relations.oid,
                   'SELECT'
                 ) AS can_select,
                 pg_catalog.has_table_privilege(
                   current_user,
                   relations.oid,
                   'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
                 )
                   OR pg_catalog.has_any_column_privilege(
                     current_user,
                     relations.oid,
                     'INSERT,UPDATE,REFERENCES'
                   ) AS can_mutate
          FROM pg_stat_statements_extension AS extension
          LEFT JOIN pg_catalog.pg_class AS relations
            ON relations.relnamespace = (
              SELECT oid
              FROM pg_catalog.pg_namespace
              WHERE nspname = 'public'
            )
           AND relations.relname IN (
             'pg_stat_statements',
             'pg_stat_statements_info'
           )
        ), pg_stat_statements_policy AS (
          SELECT extension.extension_oid IS NOT NULL AS extension_installed,
                 CASE WHEN
                   pg_catalog.current_database() = ${databaseObservabilityControlDatabase}
                   AND extension.extension_oid IS NOT NULL
                   AND extension.extension_version = '1.12'
                   AND extension.extension_schema = 'public'
                   AND extension.extension_owner_superuser
                   AND extension.extension_owner_name <> current_user
                   AND (
                     SELECT pg_catalog.count(*)
                     FROM pg_stat_statements_relations AS relations
                     WHERE relations.relation_oid IS NOT NULL
                       AND relations.relation_name IN (
                         'pg_stat_statements',
                         'pg_stat_statements_info'
                       )
                       AND relations.relation_kind = 'v'
                       AND relations.relation_owner_oid =
                         relations.extension_owner_oid
                       AND relations.extension_owned
                       AND relations.can_select
                       AND NOT relations.can_mutate
                   ) = 2
                   AND (
                     SELECT pg_catalog.count(*)
                     FROM pg_catalog.pg_attribute AS attributes
                     WHERE attributes.attrelid = (
                         SELECT relations.relation_oid
                         FROM pg_stat_statements_relations AS relations
                         WHERE relations.relation_name = 'pg_stat_statements'
                       )
                       AND attributes.attnum > 0
                       AND NOT attributes.attisdropped
                       AND (
                         attributes.attname IN ('dbid', 'userid')
                           AND attributes.atttypid =
                             'pg_catalog.oid'::pg_catalog.regtype
                         OR attributes.attname IN (
                           'calls',
                           'queryid',
                           'rows',
                           'shared_blks_hit',
                           'shared_blks_read'
                         )
                           AND attributes.atttypid =
                             'pg_catalog.int8'::pg_catalog.regtype
                         OR attributes.attname IN (
                           'mean_exec_time',
                           'total_exec_time'
                         )
                           AND attributes.atttypid =
                             'pg_catalog.float8'::pg_catalog.regtype
                       )
                   ) = 9
                 THEN ARRAY(
                   SELECT relations.relation_oid
                   FROM pg_stat_statements_relations AS relations
                   WHERE relations.relation_name IN (
                     'pg_stat_statements',
                     'pg_stat_statements_info'
                   )
                   ORDER BY relations.relation_name
                 )
                 ELSE ARRAY[]::oid[]
                 END AS admitted_relation_oids
          FROM pg_stat_statements_extension AS extension
        )
        SELECT roles.rolname AS "roleName",
               roles.rolcanlogin AS "canLogin",
               roles.rolinherit AS "inheritsPrivileges",
               roles.rolsuper AS "isSuperuser",
               roles.rolcreatedb AS "canCreateDatabase",
               roles.rolcreaterole AS "canCreateRole",
               roles.rolreplication AS "canReplicate",
               roles.rolbypassrls AS "bypassRowLevelSecurity",
               roles.rolconnlimit::bigint AS "connectionLimit",
               pg_catalog.coalesce(
                 ARRAY(
                   SELECT setting
                   FROM pg_catalog.unnest(roles.rolconfig) AS setting
                   ORDER BY setting
                 ),
                 ARRAY[]::text[]
               ) AS "roleConfiguration",
               pg_catalog.coalesce(
                 (
                   SELECT pg_catalog.array_agg(member_roles.rolname ORDER BY member_roles.rolname)
                   FROM pg_catalog.pg_auth_members AS memberships
                   JOIN pg_catalog.pg_roles AS member_roles
                     ON member_roles.oid = memberships.roleid
                   WHERE memberships.member = roles.oid
                 ),
                 ARRAY[]::text[]
               ) AS "directMemberships",
               EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_auth_members AS memberships
                 WHERE memberships.member = roles.oid
                   AND memberships.admin_option
               ) AS "hasMembershipAdministration",
               pg_catalog.coalesce(
                 (
                   SELECT pg_catalog.array_agg(databases.datname ORDER BY databases.datname)
                   FROM pg_catalog.pg_database AS databases
                   WHERE databases.datallowconn
                     AND pg_catalog.has_database_privilege(
                       current_user,
                       databases.oid,
                       'CONNECT'
                     )
                 ),
                 ARRAY[]::text[]
               ) AS "connectableDatabases",
               pg_catalog.current_database() AS "currentDatabase",
               pg_catalog.has_database_privilege(
                 current_user,
                 pg_catalog.current_database(),
                 'CREATE'
               ) AS "canCreateCurrentDatabase",
               pg_catalog.has_database_privilege(
                 current_user,
                 pg_catalog.current_database(),
                 'TEMPORARY'
               ) AS "canCreateTemporaryTables",
               EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_namespace AS namespaces
                 WHERE namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
                   AND namespaces.nspname NOT LIKE 'pg_toast%'
                   AND namespaces.nspname NOT LIKE 'pg_temp_%'
                   AND pg_catalog.has_schema_privilege(
                     current_user,
                     namespaces.oid,
                     'CREATE'
                   )
               ) AS "canCreateSchema",
               EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_class AS classes
                 JOIN pg_catalog.pg_namespace AS namespaces
                   ON namespaces.oid = classes.relnamespace
                 WHERE namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
                   AND namespaces.nspname NOT LIKE 'pg_toast%'
                   AND namespaces.nspname NOT LIKE 'pg_temp_%'
                   AND classes.relkind IN ('r', 'p', 'f')
                   AND (
                     pg_catalog.has_table_privilege(
                       current_user,
                       classes.oid,
                       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
                     )
                     OR pg_catalog.has_any_column_privilege(
                       current_user,
                       classes.oid,
                       'SELECT,INSERT,UPDATE,REFERENCES'
                     )
                   )
               ) AS "hasBaseTableAuthority",
               EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_class AS classes
                 JOIN pg_catalog.pg_namespace AS namespaces
                   ON namespaces.oid = classes.relnamespace
                 WHERE namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
                   AND namespaces.nspname NOT LIKE 'pg_toast%'
                   AND namespaces.nspname NOT LIKE 'pg_temp_%'
                   AND classes.relkind IN ('v', 'm')
                   AND (
                     (
                       NOT (
                         pg_catalog.current_database() IN ('bitmagnet', 'comet')
                         AND namespaces.nspname = 'mira_dashboard_observability'
                         AND classes.relname = 'torrent_count'
                         AND classes.relkind = 'v'
                         OR classes.oid = ANY(policy.admitted_relation_oids)
                       )
                       AND pg_catalog.has_table_privilege(
                         current_user,
                         classes.oid,
                         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
                       )
                     )
                     OR (
                       pg_catalog.current_database() IN ('bitmagnet', 'comet')
                       AND namespaces.nspname = 'mira_dashboard_observability'
                       AND classes.relname = 'torrent_count'
                       AND classes.relkind = 'v'
                       AND pg_catalog.has_table_privilege(
                         current_user,
                         classes.oid,
                         'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
                       )
                     )
                   )
               ) AS "hasUnexpectedRelationAuthority",
               EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_class AS classes
                 JOIN pg_catalog.pg_namespace AS namespaces
                   ON namespaces.oid = classes.relnamespace
                 WHERE namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
                   AND namespaces.nspname NOT LIKE 'pg_toast%'
                   AND namespaces.nspname NOT LIKE 'pg_temp_%'
                   AND classes.relkind = 'S'
                   AND pg_catalog.has_sequence_privilege(
                     current_user,
                     classes.oid,
                     'USAGE,SELECT,UPDATE'
                   )
               ) AS "hasSequenceAuthority",
               pg_catalog.pg_has_role(
                 current_user,
                 'pg_monitor',
                 'member'
               ) AS "isPgMonitor",
               pg_catalog.pg_has_role(
                 current_user,
                 ${databaseObservabilityViewOwnerRole},
                 'member'
               ) AS "isViewOwner",
               policy.extension_installed AS
                 "pgStatStatementsExtensionInstalled",
               pg_catalog.cardinality(policy.admitted_relation_oids) = 2 AS
                 "pgStatStatementsRelationValid"
        FROM pg_catalog.pg_roles AS roles
        CROSS JOIN pg_stat_statements_policy AS policy
        WHERE roles.rolname = current_user
    `;
}

function assertObserverPolicy(
    rows: readonly ObserverPolicyRow[],
    expectedDatabase: DatabaseObservabilityReviewedPostgreSqlDatabase
): void {
    const row = rows.length === 1 ? rows[0] : undefined;
    let satisfiesPolicy: boolean;
    try {
        const extensionInstalled = booleanValue(row?.pgStatStatementsExtensionInstalled);
        const relationValid = booleanValue(row?.pgStatStatementsRelationValid);
        const pgStatStatementsPolicyValid = extensionInstalled
            ? expectedDatabase === databaseObservabilityControlDatabase && relationValid
            : !relationValid;
        satisfiesPolicy =
            row !== undefined &&
            name(row.roleName) === databaseObservabilityObserverRole &&
            booleanValue(row.canLogin) &&
            booleanValue(row.inheritsPrivileges) &&
            !booleanValue(row.isSuperuser) &&
            !booleanValue(row.canCreateDatabase) &&
            !booleanValue(row.canCreateRole) &&
            !booleanValue(row.canReplicate) &&
            !booleanValue(row.bypassRowLevelSecurity) &&
            count(row.connectionLimit) === 1 &&
            exactNames(row.roleConfiguration, [
                "default_transaction_read_only=on",
                "statement_timeout=5s",
            ]) &&
            exactNames(row.directMemberships, ["pg_monitor", "pg_read_all_stats"]) &&
            !booleanValue(row.hasMembershipAdministration) &&
            exactNames(
                row.connectableDatabases,
                databaseObservabilityReviewedPostgreSqlDatabases
            ) &&
            name(row.currentDatabase) === expectedDatabase &&
            !booleanValue(row.canCreateCurrentDatabase) &&
            !booleanValue(row.canCreateTemporaryTables) &&
            !booleanValue(row.canCreateSchema) &&
            !booleanValue(row.hasBaseTableAuthority) &&
            !booleanValue(row.hasUnexpectedRelationAuthority) &&
            !booleanValue(row.hasSequenceAuthority) &&
            pgStatStatementsPolicyValid &&
            booleanValue(row.isPgMonitor) &&
            !booleanValue(row.isViewOwner);
    } catch {
        satisfiesPolicy = false;
    }
    if (!satisfiesPolicy) throw new ObserverPolicyViolationError();
}

async function assertClientObserverPolicy(
    client: DatabaseObservabilitySqlClient,
    expectedDatabase: DatabaseObservabilityReviewedPostgreSqlDatabase,
    signal: AbortSignal
): Promise<void> {
    assertObserverPolicy(
        assertRows<ObserverPolicyRow>(
            await executeQuery(observerPolicyRowsQuery(client), signal),
            1
        ),
        expectedDatabase
    );
}

function tableHealthRowsQuery(client: DatabaseObservabilitySqlClient, maximum: number) {
    return client<TableHealthRow[]>`
        WITH average_row_widths AS (
          SELECT schemaname, tablename, SUM(avg_width)::numeric AS row_width
          FROM pg_stats
          GROUP BY schemaname, tablename
        ), table_estimates AS (
          SELECT tables.schemaname,
                 tables.relname,
                 tables.relid,
                 tables.n_live_tup,
                 tables.n_dead_tup,
                 tables.last_autovacuum,
                 tables.last_autoanalyze,
                 GREATEST(
                   tables.n_live_tup::numeric,
                   classes.reltuples::numeric
                 ) AS estimated_live_tuples,
                 CASE
                   WHEN classes.reltuples > 0
                    AND tables.n_live_tup < classes.reltuples
                    AND ABS(
                      tables.n_live_tup::numeric + tables.n_dead_tup::numeric -
                      classes.reltuples::numeric
                    ) / classes.reltuples::numeric * 100 <=
                      ${catalogTupleEstimateTolerancePercent}
                   THEN tables.n_live_tup::numeric
                   ELSE GREATEST(
                     tables.n_live_tup::numeric,
                     classes.reltuples::numeric
                   )
                 END AS dead_tuple_live_estimate,
                 (
                   tables.n_live_tup < classes.reltuples
                   AND tables.n_dead_tup >= ${databaseObservabilityHighDeadTupleMinimum}
                   AND (
                     tables.n_dead_tup::numeric /
                       NULLIF(classes.reltuples::numeric, 0) * 100 >=
                         ${databaseObservabilityHighDeadTuplePercent}
                     OR pg_relation_size(tables.relid)::numeric *
                       tables.n_dead_tup::numeric /
                       NULLIF(classes.reltuples::numeric, 0) >=
                         ${databaseObservabilityBloatReviewBytes}
                   )
                 ) AS catalog_estimate_may_be_stale
          FROM pg_stat_user_tables AS tables
          JOIN pg_class AS classes ON classes.oid = tables.relid
        )
        SELECT estimates.schemaname AS schema_name,
               estimates.relname AS table_name,
               pg_relation_size(estimates.relid)::bigint AS physical_bytes,
               estimates.n_live_tup::bigint AS live_tuples,
               estimates.n_dead_tup::bigint AS dead_tuples,
               (EXTRACT(EPOCH FROM estimates.last_autovacuum) * 1000)::bigint
                 AS last_autovacuum_at_ms,
               (EXTRACT(EPOCH FROM estimates.last_autoanalyze) * 1000)::bigint
                 AS last_autoanalyze_at_ms,
               LEAST(
                 100,
                 ROUND(
                   CASE WHEN estimates.dead_tuple_live_estimate <= 0 THEN 0
                        ELSE estimates.n_dead_tup::numeric /
                          NULLIF(estimates.dead_tuple_live_estimate, 0) * 100
                   END,
                   2
                 )
               ) AS dead_tuple_percent,
               (
                 widths.row_width IS NOT NULL
                 AND estimates.estimated_live_tuples > 0
                 AND NOT estimates.catalog_estimate_may_be_stale
               ) AS assessed,
               CASE
                 WHEN widths.row_width IS NULL
                   OR estimates.estimated_live_tuples <= 0
                   OR estimates.catalog_estimate_may_be_stale
                 THEN NULL
                 ELSE GREATEST(
                   pg_relation_size(estimates.relid) - CEIL(
                     estimates.estimated_live_tuples *
                     (widths.row_width + 32) * 1.2
                   ),
                   0
                 )::bigint
               END AS estimated_reclaimable_bytes
        FROM table_estimates AS estimates
        LEFT JOIN average_row_widths AS widths
          ON widths.schemaname = estimates.schemaname
         AND widths.tablename = estimates.relname
        WHERE pg_relation_size(estimates.relid) > 0
        ORDER BY (
                   pg_relation_size(estimates.relid) >=
                     ${databaseObservabilityHighDeadTupleMinimumBytes}
                   AND LEAST(
                     100,
                     ROUND(
                       CASE WHEN estimates.dead_tuple_live_estimate <= 0 THEN 0
                            ELSE estimates.n_dead_tup::numeric /
                              NULLIF(estimates.dead_tuple_live_estimate, 0) * 100
                       END,
                       2
                     )
                   ) >= ${databaseObservabilityHighDeadTuplePercent}
                   AND estimates.n_dead_tup >=
                     ${databaseObservabilityHighDeadTupleMinimum}
                 ) DESC,
                 estimates.n_dead_tup DESC,
                 estimates.schemaname,
                 estimates.relname
        LIMIT ${maximum}
    `;
}

function maintenanceRowsQuery(client: DatabaseObservabilitySqlClient) {
    return client<MaintenanceRow[]>`
        WITH average_row_widths AS (
          SELECT schemaname, tablename, SUM(avg_width)::numeric AS row_width
          FROM pg_stats
          GROUP BY schemaname, tablename
        ), table_estimates AS (
          SELECT tables.schemaname,
                 tables.relname,
                 tables.relid,
                 tables.n_live_tup,
                 tables.n_dead_tup,
                 GREATEST(
                   tables.n_live_tup::numeric,
                   classes.reltuples::numeric
                 ) AS estimated_live_tuples,
                 CASE
                   WHEN classes.reltuples > 0
                    AND tables.n_live_tup < classes.reltuples
                    AND ABS(
                      tables.n_live_tup::numeric + tables.n_dead_tup::numeric -
                      classes.reltuples::numeric
                    ) / classes.reltuples::numeric * 100 <=
                      ${catalogTupleEstimateTolerancePercent}
                   THEN tables.n_live_tup::numeric
                   ELSE GREATEST(
                     tables.n_live_tup::numeric,
                     classes.reltuples::numeric
                   )
                 END AS dead_tuple_live_estimate,
                 (
                   tables.n_live_tup < classes.reltuples
                   AND tables.n_dead_tup >= ${databaseObservabilityHighDeadTupleMinimum}
                   AND (
                     tables.n_dead_tup::numeric /
                       NULLIF(classes.reltuples::numeric, 0) * 100 >=
                         ${databaseObservabilityHighDeadTuplePercent}
                     OR pg_relation_size(tables.relid)::numeric *
                       tables.n_dead_tup::numeric /
                       NULLIF(classes.reltuples::numeric, 0) >=
                         ${databaseObservabilityBloatReviewBytes}
                   )
                 ) AS catalog_estimate_may_be_stale
          FROM pg_stat_user_tables AS tables
          JOIN pg_class AS classes ON classes.oid = tables.relid
        ), projections AS (
          SELECT pg_relation_size(estimates.relid)::bigint AS physical_bytes,
                 estimates.n_dead_tup::bigint AS dead_tuples,
                 LEAST(
                   100,
                   ROUND(
                     CASE WHEN estimates.dead_tuple_live_estimate <= 0 THEN 0
                          ELSE estimates.n_dead_tup::numeric /
                            NULLIF(estimates.dead_tuple_live_estimate, 0) * 100
                     END,
                     2
                   )
                 ) AS dead_tuple_percent,
                 (
                   widths.row_width IS NOT NULL
                   AND estimates.estimated_live_tuples > 0
                   AND NOT estimates.catalog_estimate_may_be_stale
                 ) AS assessed,
                 CASE
                   WHEN widths.row_width IS NULL
                     OR estimates.estimated_live_tuples <= 0
                     OR estimates.catalog_estimate_may_be_stale
                   THEN 0
                   ELSE GREATEST(
                     pg_relation_size(estimates.relid) - CEIL(
                       estimates.estimated_live_tuples *
                       (widths.row_width + 32) * 1.2
                     ),
                     0
                   )::bigint
                 END AS estimated_reclaimable_bytes
          FROM table_estimates AS estimates
          LEFT JOIN average_row_widths AS widths
            ON widths.schemaname = estimates.schemaname
           AND widths.tablename = estimates.relname
          WHERE pg_relation_size(estimates.relid) > 0
        )
        SELECT COALESCE(
                 SUM(physical_bytes) FILTER (WHERE assessed),
                 0
               )::bigint AS assessed_physical_bytes,
               COALESCE(
                 SUM(estimated_reclaimable_bytes) FILTER (WHERE assessed),
                 0
               )::bigint AS estimated_reclaimable_bytes,
               COUNT(*) FILTER (
                 WHERE physical_bytes >= ${databaseObservabilityHighDeadTupleMinimumBytes}
                   AND dead_tuple_percent >= ${databaseObservabilityHighDeadTuplePercent}
                   AND dead_tuples >= ${databaseObservabilityHighDeadTupleMinimum}
               )::bigint AS high_dead_tuple_table_count,
               COALESCE(
                 SUM(physical_bytes) FILTER (WHERE NOT assessed),
                 0
               )::bigint AS unassessed_physical_bytes,
               COUNT(*) FILTER (WHERE NOT assessed)::bigint
                 AS unassessed_table_count
        FROM projections
    `;
}

function extensionRowsQuery(client: DatabaseObservabilitySqlClient) {
    return client<ExtensionRow[]>`
        SELECT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_extension
          WHERE extname = 'pg_stat_statements'
        ) AS enabled
    `;
}

function statementRowsQuery(client: DatabaseObservabilitySqlClient) {
    return client<StatementRow[]>`
        SELECT calls::bigint,
               total_exec_time::double precision AS total_execution_ms,
               mean_exec_time::double precision AS mean_execution_ms,
               rows::bigint,
               shared_blks_hit::bigint AS shared_blocks_hit,
               shared_blks_read::bigint AS shared_blocks_read
        FROM public.pg_stat_statements AS statements
        JOIN pg_catalog.pg_database AS databases
          ON databases.oid = statements.dbid
         AND databases.datname = ANY(${databaseObservabilityMetricDatabases}::text[])
        ORDER BY statements.total_exec_time DESC,
                 statements.calls DESC,
                 statements.rows DESC,
                 statements.dbid,
                 statements.userid,
                 statements.queryid
        LIMIT ${databaseObservabilityStatementMaximum}
    `;
}

function torrentCountRowsQuery(client: DatabaseObservabilitySqlClient) {
    return client<TorrentCountRow[]>`
        SELECT count::bigint AS count
        FROM mira_dashboard_observability.torrent_count
    `;
}

function pgBouncerPoolsQuery(client: DatabaseObservabilitySqlClient) {
    return client<PgBouncerPoolRow[]>`SHOW POOLS`.simple();
}

function pgBouncerStatsQuery(client: DatabaseObservabilitySqlClient) {
    return client<PgBouncerStatsRow[]>`SHOW STATS`.simple();
}

function unavailableCollector(): DatabaseObservabilityCollector {
    return Object.freeze({
        collect() {
            return Promise.reject(
                new Error("Database observability monitoring is unavailable")
            );
        },
    });
}

type MaintenanceAggregate = {
    assessedPhysicalBytes: number;
    estimatedReclaimableBytes: number;
    highDeadTupleTableCount: number;
    unassessedPhysicalBytes: number;
    unassessedTableCount: number;
};

function tableHealthRowIsHighRisk(
    row: DatabaseObservabilityCachePayload["tableHealth"][number]
): boolean {
    return (
        row.physicalBytes >= databaseObservabilityHighDeadTupleMinimumBytes &&
        row.deadTuplePercent >= databaseObservabilityHighDeadTuplePercent &&
        row.deadTuples >= databaseObservabilityHighDeadTupleMinimum
    );
}

function compareTableHealthRows(
    left: DatabaseObservabilityCachePayload["tableHealth"][number],
    right: DatabaseObservabilityCachePayload["tableHealth"][number]
): number {
    return (
        Number(tableHealthRowIsHighRisk(right)) -
            Number(tableHealthRowIsHighRisk(left)) ||
        right.deadTuples - left.deadTuples ||
        compareStrings(left.database, right.database) ||
        compareStrings(left.schema, right.schema) ||
        compareStrings(left.table, right.table)
    );
}

function addCount(left: number, right: unknown): number {
    return count(left + count(right));
}

function addMaintenanceRow(aggregate: MaintenanceAggregate, row: MaintenanceRow): void {
    aggregate.assessedPhysicalBytes = addCount(
        aggregate.assessedPhysicalBytes,
        row.assessed_physical_bytes
    );
    aggregate.estimatedReclaimableBytes = addCount(
        aggregate.estimatedReclaimableBytes,
        row.estimated_reclaimable_bytes
    );
    aggregate.highDeadTupleTableCount = addCount(
        aggregate.highDeadTupleTableCount,
        row.high_dead_tuple_table_count
    );
    aggregate.unassessedPhysicalBytes = addCount(
        aggregate.unassessedPhysicalBytes,
        row.unassessed_physical_bytes
    );
    aggregate.unassessedTableCount = addCount(
        aggregate.unassessedTableCount,
        row.unassessed_table_count
    );
}

async function collectTorrentCount(
    factory: DatabaseObservabilitySqlClientFactory,
    baseUrl: Redacted.Redacted<string>,
    database: (typeof databaseObservabilityTorrentCountDatabases)[number],
    signal: AbortSignal
): Promise<DatabaseObservabilityCachePayload["torrentCounts"][typeof database]> {
    try {
        return await withClient(factory, baseUrl, database, signal, async (client) => {
            const rows = await withReadOnlySnapshot(client, signal, async () => {
                await assertClientObserverPolicy(client, database, signal);
                return assertRows<TorrentCountRow>(
                    await executeQuery(torrentCountRowsQuery(client), signal),
                    1
                );
            });
            if (rows.length !== 1) {
                throw new TypeError("Database torrent-count row is absent");
            }
            return { count: count(rows[0]!.count), state: "available" };
        });
    } catch (error) {
        if (
            signal.aborted ||
            (error instanceof DOMException && error.name === "AbortError")
        ) {
            throw signalFailure();
        }
        if (error instanceof ObserverPolicyViolationError) throw error;
        return { state: "unavailable" };
    }
}

export interface BunSqlDatabaseObservabilityCollectorOptions {
    readonly connectionUrl?: Redacted.Redacted<string>;
    readonly deadlineMs?: number;
    readonly sqlClientFactory?: DatabaseObservabilitySqlClientFactory;
}

/**
 * Creates a sequential direct-protocol collector. Each pool is fixed to one connection,
 * every discovered database name is bounded, and PgBouncer uses its separate admin DB.
 * @returns A worker-owned bounded database observability collector.
 */
export function createBunSqlDatabaseObservabilityCollector(
    options: BunSqlDatabaseObservabilityCollectorOptions
): DatabaseObservabilityCollector {
    if (options.connectionUrl === undefined) return unavailableCollector();
    const deadlineMs = options.deadlineMs ?? databaseObservabilityDeadlineMs;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) {
        throw new RangeError("Database observability deadline is invalid");
    }
    const sqlClientFactory = options.sqlClientFactory ?? defaultSqlClientFactory();

    return Object.freeze({
        async collect(parentSignal?: AbortSignal) {
            const controller = new AbortController();
            const relayAbort = () => controller.abort(signalFailure());
            if (parentSignal?.aborted) relayAbort();
            else parentSignal?.addEventListener("abort", relayAbort, { once: true });
            const deadline = setTimeout(relayAbort, deadlineMs);
            try {
                const catalog = await withClient(
                    sqlClientFactory,
                    options.connectionUrl as Redacted.Redacted<string>,
                    databaseObservabilityControlDatabase,
                    controller.signal,
                    async (client) => {
                        return withReadOnlySnapshot(
                            client,
                            controller.signal,
                            async () => {
                                await assertClientObserverPolicy(
                                    client,
                                    databaseObservabilityControlDatabase,
                                    controller.signal
                                );
                                const extensionRows = assertRows<ExtensionRow>(
                                    await executeQuery(
                                        extensionRowsQuery(client),
                                        controller.signal
                                    ),
                                    1
                                );
                                if (extensionRows.length !== 1) {
                                    throw new TypeError(
                                        "Database extension status row is absent"
                                    );
                                }
                                const pgStatStatementsEnabled = booleanValue(
                                    extensionRows[0]!.enabled
                                );
                                const statementRows = pgStatStatementsEnabled
                                    ? assertRows<StatementRow>(
                                          await executeQuery(
                                              statementRowsQuery(client),
                                              controller.signal
                                          ),
                                          databaseObservabilityStatementMaximum
                                      )
                                    : [];
                                const databaseRows = assertRows<DatabaseRow>(
                                    await executeQuery(
                                        databaseRowsQuery(client),
                                        controller.signal
                                    ),
                                    databaseObservabilityDatabaseMaximum
                                );
                                const connectionRows = assertRows<ConnectionRow>(
                                    await executeQuery(
                                        connectionRowsQuery(client),
                                        controller.signal
                                    ),
                                    1
                                );
                                return {
                                    connectionRows,
                                    databaseRows,
                                    pgStatStatementsEnabled,
                                    statementRows,
                                };
                            }
                        );
                    }
                );
                const databases = catalog.databaseRows
                    .map((row) => {
                        const blocksHit = count(row.blks_hit);
                        const blocksRead = count(row.blks_read);
                        return {
                            cacheHitRatio:
                                blocksHit + blocksRead === 0
                                    ? 100
                                    : (blocksHit / (blocksHit + blocksRead)) * 100,
                            committedTransactions: count(row.xact_commit),
                            connections: count(row.numbackends),
                            name: name(row.datname),
                            rolledBackTransactions: count(row.xact_rollback),
                            sizeBytes: count(row.size_bytes),
                        };
                    })
                    .toSorted((left, right) => compareStrings(left.name, right.name));
                const clusterDatabaseCount =
                    catalog.databaseRows.length === 0
                        ? 0
                        : count(catalog.databaseRows[0]!.database_count);
                if (
                    clusterDatabaseCount !== catalog.databaseRows.length ||
                    catalog.databaseRows.some(
                        (row) => count(row.database_count) !== clusterDatabaseCount
                    )
                ) {
                    throw new RangeError(
                        "Database observability database budget was exceeded"
                    );
                }
                if (
                    databases.length !== databaseObservabilityMetricDatabases.length ||
                    databases.some(
                        ({ name: database }, index) =>
                            database !== databaseObservabilityMetricDatabases[index]
                    )
                ) {
                    throw new TypeError(
                        "Database observability rows are outside the reviewed inventory"
                    );
                }
                const connections = catalog.connectionRows[0];
                if (connections === undefined) {
                    throw new TypeError("Database connection summary is absent");
                }
                let totalDatabaseSizeBytes = 0;
                let totalCacheHitRatio = 0;
                for (const database of databases) {
                    totalDatabaseSizeBytes = addCount(
                        totalDatabaseSizeBytes,
                        database.sizeBytes
                    );
                    totalCacheHitRatio += database.cacheHitRatio;
                }
                const averageCacheHitRatio =
                    totalCacheHitRatio / databaseObservabilityMetricDatabases.length;

                const tableHealthCandidates: DatabaseObservabilityCachePayload["tableHealth"][number][] =
                    [];
                const maintenance: MaintenanceAggregate = {
                    assessedPhysicalBytes: 0,
                    estimatedReclaimableBytes: 0,
                    highDeadTupleTableCount: 0,
                    unassessedPhysicalBytes: 0,
                    unassessedTableCount: 0,
                };
                for (const database of databases) {
                    await withClient(
                        sqlClientFactory,
                        options.connectionUrl as Redacted.Redacted<string>,
                        database.name as DatabaseObservabilityReviewedPostgreSqlDatabase,
                        controller.signal,
                        async (client) => {
                            const { maintenanceRows, rows } = await withReadOnlySnapshot(
                                client,
                                controller.signal,
                                async () => {
                                    await assertClientObserverPolicy(
                                        client,
                                        database.name as DatabaseObservabilityReviewedPostgreSqlDatabase,
                                        controller.signal
                                    );
                                    return {
                                        maintenanceRows: assertRows<MaintenanceRow>(
                                            await executeQuery(
                                                maintenanceRowsQuery(client),
                                                controller.signal
                                            ),
                                            1
                                        ),
                                        rows: assertRows<TableHealthRow>(
                                            await executeQuery(
                                                tableHealthRowsQuery(
                                                    client,
                                                    databaseObservabilityTableHealthMaximum
                                                ),
                                                controller.signal
                                            ),
                                            databaseObservabilityTableHealthMaximum
                                        ),
                                    };
                                }
                            );
                            tableHealthCandidates.push(
                                ...rows.map((row) => {
                                    const assessed = booleanValue(row.assessed);
                                    if (
                                        assessed ===
                                        (row.estimated_reclaimable_bytes === null)
                                    ) {
                                        throw new TypeError(
                                            "Database table assessment row is inconsistent"
                                        );
                                    }
                                    return {
                                        assessment: assessed
                                            ? ("assessed" as const)
                                            : ("unavailable" as const),
                                        database: database.name,
                                        deadTuplePercent: nonnegativeNumber(
                                            row.dead_tuple_percent
                                        ),
                                        deadTuples: count(row.dead_tuples),
                                        ...(assessed
                                            ? {
                                                  estimatedReclaimableBytes: count(
                                                      row.estimated_reclaimable_bytes
                                                  ),
                                              }
                                            : {}),
                                        ...(row.last_autoanalyze_at_ms === null
                                            ? {}
                                            : {
                                                  lastAutoanalyzeAtMs: Math.min(
                                                      count(row.last_autoanalyze_at_ms),
                                                      Date.now()
                                                  ),
                                              }),
                                        ...(row.last_autovacuum_at_ms === null
                                            ? {}
                                            : {
                                                  lastAutovacuumAtMs: Math.min(
                                                      count(row.last_autovacuum_at_ms),
                                                      Date.now()
                                                  ),
                                              }),
                                        liveTuples: count(row.live_tuples),
                                        physicalBytes: count(row.physical_bytes),
                                        schema: name(row.schema_name),
                                        table: name(row.table_name),
                                    };
                                })
                            );
                            if (maintenanceRows.length !== 1) {
                                throw new TypeError(
                                    "Database maintenance summary row is absent"
                                );
                            }
                            addMaintenanceRow(maintenance, maintenanceRows[0]!);
                        }
                    );
                }
                tableHealthCandidates.sort(compareTableHealthRows);
                if (
                    new Set(
                        tableHealthCandidates.map(
                            (row) => `${row.database}\0${row.schema}\0${row.table}`
                        )
                    ).size !== tableHealthCandidates.length
                ) {
                    throw new TypeError("Database table-health rows are not unique");
                }
                const tableHealth = tableHealthCandidates.slice(
                    0,
                    databaseObservabilityTableHealthMaximum
                );
                const statements = catalog.statementRows.map((row, index) => ({
                    calls: count(row.calls),
                    meanExecutionMs: nonnegativeNumber(row.mean_execution_ms),
                    rank: index + 1,
                    rows: count(row.rows),
                    sharedBlocksHit: count(row.shared_blocks_hit),
                    sharedBlocksRead: count(row.shared_blocks_read),
                    totalExecutionMs: nonnegativeNumber(row.total_execution_ms),
                }));

                const torrentCounts = {
                    bitmagnet: await collectTorrentCount(
                        sqlClientFactory,
                        options.connectionUrl as Redacted.Redacted<string>,
                        databaseObservabilityTorrentCountDatabases[0],
                        controller.signal
                    ),
                    comet: await collectTorrentCount(
                        sqlClientFactory,
                        options.connectionUrl as Redacted.Redacted<string>,
                        databaseObservabilityTorrentCountDatabases[1],
                        controller.signal
                    ),
                };

                const pgBouncer = await withClient(
                    sqlClientFactory,
                    options.connectionUrl as Redacted.Redacted<string>,
                    databaseObservabilityPgBouncerVirtualDatabase,
                    controller.signal,
                    async (client) => {
                        const poolRows = assertRows<PgBouncerPoolRow>(
                            await executeQuery(
                                pgBouncerPoolsQuery(client),
                                controller.signal
                            ),
                            databaseObservabilityPgBouncerInputMaximum
                        );
                        const statsRows = assertRows<PgBouncerStatsRow>(
                            await executeQuery(
                                pgBouncerStatsQuery(client),
                                controller.signal
                            ),
                            databaseObservabilityPgBouncerInputMaximum - poolRows.length
                        );
                        const reviewedDatabaseSet = new Set<string>(
                            databaseObservabilityMetricDatabases
                        );
                        const reviewedPoolRows = poolRows.filter((row) =>
                            reviewedDatabaseSet.has(name(row.database))
                        );
                        const reviewedStatsRows = statsRows.filter((row) =>
                            reviewedDatabaseSet.has(name(row.database))
                        );
                        const averageQueryMs =
                            reviewedStatsRows.length === 0
                                ? 0
                                : reviewedStatsRows.reduce(
                                      (sum, row) =>
                                          sum + nonnegativeNumber(row.avg_query_time),
                                      0
                                  ) /
                                  reviewedStatsRows.length /
                                  1000;
                        const averageTransactionMs =
                            reviewedStatsRows.length === 0
                                ? 0
                                : reviewedStatsRows.reduce(
                                      (sum, row) =>
                                          sum + nonnegativeNumber(row.avg_xact_time),
                                      0
                                  ) /
                                  reviewedStatsRows.length /
                                  1000;
                        const poolsByDatabase = new Map<
                            string,
                            {
                                activeClients: number;
                                activeServers: number;
                                idleServers: number;
                                usedServers: number;
                                waitingClients: number;
                            }
                        >();
                        for (const row of reviewedPoolRows) {
                            const database = name(row.database);
                            const aggregate = poolsByDatabase.get(database) ?? {
                                activeClients: 0,
                                activeServers: 0,
                                idleServers: 0,
                                usedServers: 0,
                                waitingClients: 0,
                            };
                            aggregate.activeClients += count(row.cl_active);
                            aggregate.activeServers += count(row.sv_active);
                            aggregate.idleServers += count(row.sv_idle);
                            aggregate.usedServers += count(row.sv_used);
                            aggregate.waitingClients += count(row.cl_waiting);
                            poolsByDatabase.set(database, aggregate);
                        }
                        const statsByDatabase = new Map<
                            string,
                            {
                                averageQueryMs: number;
                                averageTransactionMs: number;
                                totalQueries: number;
                            }
                        >();
                        for (const row of reviewedStatsRows) {
                            statsByDatabase.set(name(row.database), {
                                averageQueryMs:
                                    nonnegativeNumber(row.avg_query_time) / 1000,
                                averageTransactionMs:
                                    nonnegativeNumber(row.avg_xact_time) / 1000,
                                totalQueries: count(row.total_query_count),
                            });
                        }
                        let maxWaitSeconds = 0;
                        for (const row of reviewedPoolRows) {
                            maxWaitSeconds = Math.max(
                                maxWaitSeconds,
                                nonnegativeNumber(row.maxwait)
                            );
                        }
                        return {
                            averageQueryMs,
                            averageTransactionMs,
                            clientConnections: reviewedPoolRows.reduce(
                                (sum, row) =>
                                    sum + count(row.cl_active) + count(row.cl_waiting),
                                0
                            ),
                            maxWaitSeconds,
                            serverConnections: reviewedPoolRows.reduce(
                                (sum, row) =>
                                    sum +
                                    count(row.sv_active) +
                                    count(row.sv_idle) +
                                    count(row.sv_used),
                                0
                            ),
                            waitingClients: reviewedPoolRows.reduce(
                                (sum, row) => sum + count(row.cl_waiting),
                                0
                            ),
                            perDatabase: new Map(
                                [...poolsByDatabase.entries()].map(([database, pool]) => [
                                    database,
                                    {
                                        ...pool,
                                        ...(statsByDatabase.get(database) ?? {
                                            averageQueryMs: 0,
                                            averageTransactionMs: 0,
                                            totalQueries: 0,
                                        }),
                                    },
                                ])
                            ),
                        };
                    }
                );
                const databasesWithPools = databases.map((database) => ({
                    ...database,
                    ...(pgBouncer.perDatabase.get(database.name) === undefined
                        ? {}
                        : { pool: pgBouncer.perDatabase.get(database.name)! }),
                }));
                const { perDatabase: _perDatabase, ...pgBouncerSummary } = pgBouncer;
                const slowStatementCount = statements.filter(
                    (row) =>
                        row.meanExecutionMs >= databaseObservabilitySlowStatementMeanMs
                ).length;
                const estimatedReclaimablePercent =
                    maintenance.assessedPhysicalBytes === 0
                        ? 0
                        : (maintenance.estimatedReclaimableBytes /
                              maintenance.assessedPhysicalBytes) *
                          100;
                const requiresBloatReview =
                    maintenance.estimatedReclaimableBytes >=
                        databaseObservabilityBloatReviewBytes ||
                    (maintenance.estimatedReclaimableBytes >=
                        databaseObservabilityBloatReviewMinimumBytes &&
                        estimatedReclaimablePercent >=
                            databaseObservabilityBloatReviewPercent);
                const assessmentComplete = maintenance.unassessedTableCount === 0;
                const requiresMaintenanceReview =
                    requiresBloatReview ||
                    maintenance.highDeadTupleTableCount > 0 ||
                    slowStatementCount > 0;
                let maintenanceStatus: "healthy" | "not-assessed" | "review" =
                    assessmentComplete ? "healthy" : "not-assessed";
                if (requiresMaintenanceReview) maintenanceStatus = "review";
                const payload = v.parse(databaseObservabilityCachePayloadSchema, {
                    databases: databasesWithPools,
                    pgbouncer: pgBouncerSummary,
                    statements,
                    summary: {
                        activeConnections: count(connections.active_connections),
                        averageCacheHitRatio,
                        idleConnections: count(connections.idle_connections),
                        maintenance: {
                            assessmentComplete,
                            assessedPhysicalBytes: maintenance.assessedPhysicalBytes,
                            estimatedReclaimableBytes:
                                maintenance.estimatedReclaimableBytes,
                            estimatedReclaimablePercent,
                            highDeadTupleTableCount: maintenance.highDeadTupleTableCount,
                            requiresBloatReview,
                            slowStatementCount,
                            status: maintenanceStatus,
                            unassessedPhysicalBytes: maintenance.unassessedPhysicalBytes,
                            unassessedTableCount: maintenance.unassessedTableCount,
                        },
                        pgStatStatementsEnabled: catalog.pgStatStatementsEnabled,
                        totalConnections: count(connections.total_connections),
                        totalDatabaseSizeBytes,
                    },
                    tableHealth,
                    torrentCounts,
                } satisfies DatabaseObservabilityCachePayload);
                if (
                    utf8ByteLength(JSON.stringify(payload)) >
                    databaseObservabilityCachePayloadMaximumBytes
                ) {
                    throw new RangeError(
                        "Database observability payload is outside its budget"
                    );
                }
                return payload;
            } catch (error) {
                if (
                    controller.signal.aborted ||
                    (error instanceof DOMException && error.name === "AbortError")
                ) {
                    throw signalFailure();
                }
                throw collectionFailure();
            } finally {
                clearTimeout(deadline);
                parentSignal?.removeEventListener("abort", relayAbort);
            }
        },
    });
}

/**
 * Development deliberately receives no production external-database authority.
 * @returns An unavailable collector that never opens a database connection.
 */
export function createUnavailableDatabaseObservabilityCollector(): DatabaseObservabilityCollector {
    return unavailableCollector();
}
