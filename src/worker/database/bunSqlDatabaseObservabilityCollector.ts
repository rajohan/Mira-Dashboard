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
    databaseObservabilityHostnameIsLoopback,
    databaseObservabilityObserverConnectionLimit,
    databaseObservabilityObserverRole,
    databaseObservabilityPgBouncerControlAlias,
    databaseObservabilityPgBouncerVirtualDatabase,
    databaseObservabilityTorrentCountDatabases,
    type DatabaseObservabilityTorrentCountDatabase,
} from "../../shared/databaseObservabilityPolicy.ts";
import { utf8ByteLength } from "../../shared/encoding.ts";
import { compareStrings, hasNoUnicodeControlOrFormat } from "../../shared/validation.ts";
import {
    createDockerPgBouncerAdminCollector,
    type PgBouncerAdminCollector,
} from "./dockerPgBouncerAdminCollector.ts";

/** Maximum raw PgBouncer rows admitted before aggregate projection. */
export const databaseObservabilityPgBouncerInputMaximum = 512;
export const databaseObservabilityConnectTimeoutSeconds = 5;
export const databaseObservabilityDeadlineMs = 60_000;

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
        connection: DatabaseObservabilityConnection,
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
    connectionLimit: unknown;
    currentDatabase: unknown;
    databaseRoleConfiguration: unknown;
    directMemberships: unknown;
    hasBaseTableAuthority: unknown;
    hasDefaultAclAuthority: unknown;
    hasInboundMemberships: unknown;
    hasInvalidMembershipOptions: unknown;
    hasRoutineGrantAuthority: unknown;
    hasSecurityDefinerRoutineAuthority: unknown;
    hasSequenceAuthority: unknown;
    hasUnexpectedRelationAuthority: unknown;
    inheritsPrivileges: unknown;
    capabilityInterfacesValid: unknown;
    isCapabilityOwner: unknown;
    isPgMonitor: unknown;
    isPgReadAllStats: unknown;
    isSuperuser: unknown;
    isViewOwner: unknown;
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
    cl_active_cancel_req: unknown;
    cl_waiting: unknown;
    cl_waiting_cancel_req: unknown;
    maxwait: unknown;
    sv_active: unknown;
    sv_active_cancel: unknown;
    sv_being_canceled: unknown;
    sv_idle: unknown;
    sv_login: unknown;
    sv_tested: unknown;
    sv_used: unknown;
}

interface PgBouncerStatsRow {
    avg_query_count: unknown;
    avg_query_time: unknown;
    avg_xact_count: unknown;
    avg_xact_time: unknown;
    database: unknown;
    total_query_count: unknown;
}

class ObserverPolicyViolationError extends Error {}

function validatedConnection(
    connection: DatabaseObservabilityConnection
): DatabaseObservabilityConnection {
    const password = Redacted.value(connection.password);
    if (
        !databaseObservabilityHostnameIsLoopback(connection.hostname) ||
        !Number.isSafeInteger(connection.port) ||
        connection.port < 1 ||
        connection.port > 65_535 ||
        connection.controlDatabase !== databaseObservabilityPgBouncerControlAlias ||
        password.length === 0 ||
        password.length > 4096 ||
        password !== password.trim() ||
        /[\p{Cc}\p{Cf}]/u.test(password)
    ) {
        throw new TypeError("Database observability endpoint is invalid");
    }
    return Object.freeze({
        controlDatabase: connection.controlDatabase,
        hostname: connection.hostname,
        password: connection.password,
        port: connection.port,
    });
}

function defaultSqlClientFactory(): DatabaseObservabilitySqlClientFactory {
    return Object.freeze({
        create(
            connection: DatabaseObservabilityConnection,
            database: string
        ): DatabaseObservabilitySqlClient {
            return new Bun.SQL({
                adapter: "postgres",
                connectionTimeout: databaseObservabilityConnectTimeoutSeconds,
                database: name(database),
                hostname: connection.hostname,
                idleTimeout: databaseObservabilityConnectTimeoutSeconds,
                max: 1,
                password: Redacted.value(connection.password),
                port: connection.port,
                prepare: false,
                tls: false,
                username: databaseObservabilityObserverRole,
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

function addCounts(total: number, value: unknown): number {
    const result = total + count(value);
    if (!Number.isSafeInteger(result)) {
        throw new TypeError("Database observability count aggregate is invalid");
    }
    return result;
}

function addNonnegativeNumbers(total: number, value: unknown): number {
    const result = total + nonnegativeNumber(value);
    if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER) {
        throw new TypeError("Database observability metric aggregate is invalid");
    }
    return result;
}

function averageDurationMs(totalMicroseconds: number, totalCount: number): number {
    if (totalCount === 0) {
        if (totalMicroseconds !== 0) {
            throw new TypeError("Database observability duration aggregate is invalid");
        }
        return 0;
    }
    return totalMicroseconds / totalCount / 1000;
}

function addWeightedDuration(
    totalMicroseconds: number,
    durationMicroseconds: unknown,
    rawWeight: unknown
): number {
    const weightedDuration = nonnegativeNumber(durationMicroseconds) * count(rawWeight);
    if (
        !Number.isFinite(weightedDuration) ||
        weightedDuration > Number.MAX_SAFE_INTEGER
    ) {
        throw new TypeError("Database observability duration aggregate is invalid");
    }
    return addNonnegativeNumbers(totalMicroseconds, weightedDuration);
}

function name(value: unknown): string {
    if (
        typeof value !== "string" ||
        !/\S/u.test(value) ||
        utf8ByteLength(value) > 63 ||
        !hasNoUnicodeControlOrFormat(value)
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
    connection: DatabaseObservabilityConnection,
    database: string,
    signal: AbortSignal,
    operation: (client: DatabaseObservabilitySqlClient) => Promise<T>
): Promise<T> {
    if (signal.aborted) throw signalFailure();
    const client = factory.create(connection, database);
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
        await executeQuery(
            // Function-body hashes are provisioned in this exact deparser context.
            // The policy query fully qualifies every catalog object and resets the
            // path to pg_catalog before invoking any admitted capability.
            client<never[]>`SET LOCAL search_path = pg_catalog, public`,
            signal
        );
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
        WITH observed_databases AS (
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
        )
        SELECT observed_databases.*,
               COUNT(*) OVER ()::bigint AS database_count
        FROM observed_databases
        ORDER BY datname
        LIMIT ${databaseObservabilityDatabaseMaximum}
    `;
}

function connectionRowsQuery(client: DatabaseObservabilitySqlClient) {
    return client<ConnectionRow[]>`
        SELECT active_connections::bigint,
               idle_connections::bigint,
               total_connections::bigint
        FROM mira_dashboard_observability_capabilities.connection_metrics()
    `;
}

function observerPolicyRowsQuery(client: DatabaseObservabilitySqlClient) {
    return client<ObserverPolicyRow[]>`
        WITH role_oids AS (
          SELECT observer.oid AS observer_oid,
                 capability_owner.oid AS capability_owner_oid,
                 view_owner.oid AS view_owner_oid,
                 read_all_stats.oid AS read_all_stats_oid
          FROM pg_catalog.pg_roles AS observer
          JOIN pg_catalog.pg_roles AS capability_owner
            ON capability_owner.rolname =
              'mira_dashboard_observability_capability_owner'
          JOIN pg_catalog.pg_roles AS view_owner
            ON view_owner.rolname = 'mira_dashboard_observability_owner'
          JOIN pg_catalog.pg_roles AS read_all_stats
            ON read_all_stats.rolname = 'pg_read_all_stats'
          WHERE observer.rolname = 'mira_dashboard_observer'
        ), expected_capability_routines AS (
          SELECT expected.*
          FROM (
            VALUES
              (
                'table_health'::text,
                'sql'::name,
                'v'::"char",
                'u'::"char",
                ARRAY[
                  'schema_name', 'table_name', 'physical_bytes', 'live_tuples',
                  'dead_tuples', 'last_autovacuum_at_ms',
                  'last_autoanalyze_at_ms', 'dead_tuple_percent', 'assessed',
                  'estimated_reclaimable_bytes'
                ]::text[],
                ARRAY[
                  'pg_catalog.name'::pg_catalog.regtype,
                  'pg_catalog.name'::pg_catalog.regtype,
                  'pg_catalog.int8'::pg_catalog.regtype,
                  'pg_catalog.int8'::pg_catalog.regtype,
                  'pg_catalog.int8'::pg_catalog.regtype,
                  'pg_catalog.int8'::pg_catalog.regtype,
                  'pg_catalog.int8'::pg_catalog.regtype,
                  'pg_catalog.numeric'::pg_catalog.regtype,
                  'pg_catalog.bool'::pg_catalog.regtype,
                  'pg_catalog.int8'::pg_catalog.regtype
                ]::oid[],
                ARRAY[
                  't','t','t','t','t','t','t','t','t','t'
                ]::"char"[],
                ARRAY[
                  'search_path=pg_catalog, pg_temp',
                  'statement_timeout=5s'
                ]::text[],
                25::real,
                '391b9e5325dd42c9f4a319b44dd8ddae0fb88a0cd5276540ab5d65d53ace5606'::text
              ),
              (
                'maintenance_metrics'::text,
                'sql'::name,
                'v'::"char",
                'u'::"char",
                ARRAY[
                  'assessed_physical_bytes', 'estimated_reclaimable_bytes',
                  'high_dead_tuple_table_count', 'unassessed_physical_bytes',
                  'unassessed_table_count'
                ]::text[],
                ARRAY[
                  'pg_catalog.int8'::pg_catalog.regtype,
                  'pg_catalog.int8'::pg_catalog.regtype,
                  'pg_catalog.int8'::pg_catalog.regtype,
                  'pg_catalog.int8'::pg_catalog.regtype,
                  'pg_catalog.int8'::pg_catalog.regtype
                ]::oid[],
                ARRAY['t','t','t','t','t']::"char"[],
                ARRAY[
                  'search_path=pg_catalog, pg_temp',
                  'statement_timeout=5s'
                ]::text[],
                1::real,
                '617ddca7f3f255858cf01b3ec1c07cf2fa37a5d5ba4e21fc52e2ce451f473c0a'::text
              ),
              (
                'connection_metrics'::text,
                'sql'::name,
                'v'::"char",
                'u'::"char",
                ARRAY[
                  'active_connections', 'idle_connections', 'total_connections'
                ]::text[],
                ARRAY[
                  'pg_catalog.int8'::pg_catalog.regtype,
                  'pg_catalog.int8'::pg_catalog.regtype,
                  'pg_catalog.int8'::pg_catalog.regtype
                ]::oid[],
                ARRAY['t','t','t']::"char"[],
                ARRAY[
                  'search_path=pg_catalog, pg_temp',
                  'statement_timeout=5s'
                ]::text[],
                1::real,
                'e7dd5805171b451837fda6aefad1f8f71e3ada90424d296fc4aed746005ab638'::text
              ),
              (
                'statement_metrics'::text,
                'sql'::name,
                'v'::"char",
                'u'::"char",
                ARRAY[
                  'calls', 'total_execution_ms', 'mean_execution_ms', 'rows',
                  'shared_blocks_hit', 'shared_blocks_read'
                ]::text[],
                ARRAY[
                  'pg_catalog.int8'::pg_catalog.regtype,
                  'pg_catalog.float8'::pg_catalog.regtype,
                  'pg_catalog.float8'::pg_catalog.regtype,
                  'pg_catalog.int8'::pg_catalog.regtype,
                  'pg_catalog.int8'::pg_catalog.regtype,
                  'pg_catalog.int8'::pg_catalog.regtype
                ]::oid[],
                ARRAY['t','t','t','t','t','t']::"char"[],
                ARRAY[
                  'search_path=pg_catalog, pg_temp',
                  'statement_timeout=5s'
                ]::text[],
                20::real,
                'e96e15f965236535b5d8901c5fea3422c663f6c7858517b840dab82d66910e9e'::text
              )
          ) AS expected(
            routine_name,
            language_name,
            volatility,
            parallel_safety,
            output_names,
            output_types,
            output_modes,
            routine_configuration,
            row_estimate,
            source_hash
          )
          WHERE expected.routine_name IN ('table_health', 'maintenance_metrics')
             OR pg_catalog.current_database() = 'mira_dashboard_observability'
        ), capability_routines AS (
          SELECT routines.*,
                 languages.lanname,
                 expected.language_name,
                 expected.volatility,
                 expected.parallel_safety,
                 expected.output_names,
                 expected.output_types,
                 expected.output_modes,
                 expected.routine_configuration,
                 expected.row_estimate,
                 expected.source_hash
          FROM expected_capability_routines AS expected
          LEFT JOIN pg_catalog.pg_namespace AS namespaces
            ON namespaces.nspname = 'mira_dashboard_observability_capabilities'
          LEFT JOIN pg_catalog.pg_proc AS routines
            ON routines.pronamespace = namespaces.oid
           AND routines.proname = expected.routine_name
           AND routines.pronargs = 0
          LEFT JOIN pg_catalog.pg_language AS languages
            ON languages.oid = routines.prolang
        ), capability_interfaces AS (
          SELECT
            EXISTS (
              SELECT 1
              FROM pg_catalog.pg_roles AS capability_owner
              CROSS JOIN role_oids
              WHERE capability_owner.oid = role_oids.capability_owner_oid
                AND NOT capability_owner.rolcanlogin
                AND capability_owner.rolinherit
                AND NOT capability_owner.rolsuper
                AND NOT capability_owner.rolcreatedb
                AND NOT capability_owner.rolcreaterole
                AND NOT capability_owner.rolreplication
                AND NOT capability_owner.rolbypassrls
                AND capability_owner.rolconfig IS NULL
                AND COALESCE(
                  (
                    SELECT pg_catalog.array_agg(
                      member_roles.rolname ORDER BY member_roles.rolname
                    )
                    FROM pg_catalog.pg_auth_members AS memberships
                    JOIN pg_catalog.pg_roles AS member_roles
                      ON member_roles.oid = memberships.roleid
                    WHERE memberships.member = capability_owner.oid
                  ),
                  ARRAY[]::name[]
                ) = ARRAY['pg_read_all_stats'::name]
                AND NOT EXISTS (
                  SELECT 1
                  FROM pg_catalog.pg_auth_members AS memberships
                  WHERE memberships.member = capability_owner.oid
                    AND (
                      memberships.admin_option
                      OR NOT memberships.inherit_option
                      OR memberships.set_option
                    )
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM pg_catalog.pg_auth_members AS memberships
                  WHERE memberships.roleid = capability_owner.oid
                )
            )
            AND EXISTS (
              SELECT 1
              FROM pg_catalog.pg_roles AS view_owner
              CROSS JOIN role_oids
              WHERE view_owner.oid = role_oids.view_owner_oid
                AND NOT view_owner.rolcanlogin
                AND NOT view_owner.rolinherit
                AND NOT view_owner.rolsuper
                AND NOT view_owner.rolcreatedb
                AND NOT view_owner.rolcreaterole
                AND NOT view_owner.rolreplication
                AND NOT view_owner.rolbypassrls
                AND view_owner.rolconfig IS NULL
                AND NOT EXISTS (
                  SELECT 1
                  FROM pg_catalog.pg_auth_members AS memberships
                  WHERE memberships.member = view_owner.oid
                     OR memberships.roleid = view_owner.oid
                )
            )
            AND EXISTS (
              SELECT 1
              FROM pg_catalog.pg_namespace AS namespaces
              CROSS JOIN role_oids
              WHERE namespaces.nspname = 'mira_dashboard_observability_capabilities'
                AND namespaces.nspowner = role_oids.view_owner_oid
                AND pg_catalog.has_schema_privilege(
                  role_oids.observer_oid,
                  namespaces.oid,
                  'USAGE'
                )
                AND NOT pg_catalog.has_schema_privilege(
                  role_oids.observer_oid,
                  namespaces.oid,
                  'CREATE'
                )
                AND (
                  SELECT pg_catalog.count(*)
                  FROM pg_catalog.aclexplode(namespaces.nspacl) AS grants
                ) = 4
                AND NOT EXISTS (
                  SELECT 1
                  FROM pg_catalog.aclexplode(namespaces.nspacl) AS grants
                  WHERE grants.grantor <> role_oids.view_owner_oid
                     OR grants.is_grantable
                     OR NOT (
                       grants.grantee = role_oids.view_owner_oid
                         AND grants.privilege_type IN ('CREATE', 'USAGE')
                       OR grants.grantee = role_oids.capability_owner_oid
                         AND grants.privilege_type = 'USAGE'
                       OR grants.grantee = role_oids.observer_oid
                         AND grants.privilege_type = 'USAGE'
                     )
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM pg_catalog.pg_class AS classes
                  WHERE classes.relnamespace = namespaces.oid
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM pg_catalog.pg_type AS types
                  WHERE types.typnamespace = namespaces.oid
                )
                AND (
                  SELECT pg_catalog.count(*)
                  FROM pg_catalog.pg_proc AS routines
                  WHERE routines.pronamespace = namespaces.oid
                ) = (
                  SELECT pg_catalog.count(*)
                  FROM expected_capability_routines
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM capability_routines AS routines
              CROSS JOIN role_oids
              WHERE routines.oid IS NULL
                 OR routines.proowner <> role_oids.capability_owner_oid
                 OR routines.prokind <> 'f'
                 OR routines.prorettype <>
                   'pg_catalog.record'::pg_catalog.regtype
                 OR routines.pronargdefaults <> 0
                 OR routines.provolatile <> routines.volatility
                 OR routines.proparallel <> routines.parallel_safety
                 OR NOT routines.prosecdef
                 OR routines.proleakproof
                 OR routines.proisstrict
                 OR routines.lanname <> routines.language_name
                 OR routines.proargnames IS DISTINCT FROM routines.output_names
                 OR routines.proallargtypes IS DISTINCT FROM routines.output_types
                 OR routines.proargmodes IS DISTINCT FROM routines.output_modes
                 OR routines.proconfig IS DISTINCT FROM
                   routines.routine_configuration
                 OR routines.prorows IS DISTINCT FROM routines.row_estimate
                 OR pg_catalog.encode(
                   pg_catalog.sha256(
                     pg_catalog.convert_to(
                       pg_catalog.pg_get_function_sqlbody(routines.oid),
                       'UTF8'
                     )
                   ),
                   'hex'
                 ) IS DISTINCT FROM routines.source_hash
                 OR NOT pg_catalog.has_function_privilege(
                   role_oids.observer_oid,
                   routines.oid,
                   'EXECUTE'
                 )
                 OR (
                   SELECT pg_catalog.count(*)
                   FROM pg_catalog.aclexplode(routines.proacl) AS grants
                 ) <> 2
                 OR EXISTS (
                   SELECT 1
                   FROM pg_catalog.aclexplode(routines.proacl) AS grants
                   WHERE grants.grantor <> role_oids.capability_owner_oid
                      OR grants.is_grantable
                      OR grants.privilege_type <> 'EXECUTE'
                      OR grants.grantee NOT IN (
                        role_oids.capability_owner_oid,
                        role_oids.observer_oid
                      )
                 )
            )
            AND CASE
              WHEN pg_catalog.current_database() <> 'mira_dashboard_observability'
              THEN NOT EXISTS (
                SELECT 1
                FROM pg_catalog.pg_extension AS extensions
                WHERE extensions.extname = 'pg_stat_statements'
              )
              ELSE EXISTS (
                SELECT 1
                FROM pg_catalog.pg_extension AS extensions
                WHERE extensions.extname = 'pg_stat_statements'
              )
                AND (
                  SELECT pg_catalog.count(*)
                  FROM pg_catalog.pg_class AS sources
                  JOIN pg_catalog.pg_extension AS extensions
                    ON extensions.extname = 'pg_stat_statements'
                   AND extensions.extnamespace = sources.relnamespace
                  JOIN pg_catalog.pg_depend AS dependencies
                    ON dependencies.classid =
                      'pg_catalog.pg_class'::pg_catalog.regclass
                   AND dependencies.objid = sources.oid
                   AND dependencies.objsubid = 0
                   AND dependencies.refclassid =
                     'pg_catalog.pg_extension'::pg_catalog.regclass
                   AND dependencies.refobjid = extensions.oid
                   AND dependencies.deptype = 'e'
                  WHERE sources.relname IN (
                    'pg_stat_statements',
                    'pg_stat_statements_info'
                  )
                    AND sources.relkind = 'v'
                ) = 2
                AND NOT EXISTS (
                  SELECT 1
                  FROM pg_catalog.pg_class AS sources
                  JOIN pg_catalog.pg_extension AS extensions
                    ON extensions.extname = 'pg_stat_statements'
                   AND extensions.extnamespace = sources.relnamespace
                  JOIN role_oids ON true
                  CROSS JOIN LATERAL
                    pg_catalog.aclexplode(
                      COALESCE(
                        sources.relacl,
                        pg_catalog.acldefault('r', sources.relowner)
                      )
                    ) AS grants
                  WHERE sources.relname IN (
                    'pg_stat_statements',
                    'pg_stat_statements_info'
                  )
                    AND grants.grantee IN (
                      0,
                      role_oids.observer_oid,
                      role_oids.capability_owner_oid,
                      role_oids.view_owner_oid,
                      role_oids.read_all_stats_oid
                    )
                )
                AND (
                  SELECT pg_catalog.count(*)
                  FROM pg_catalog.pg_proc AS routines
                  JOIN pg_catalog.pg_extension AS extensions
                    ON extensions.extname = 'pg_stat_statements'
                  JOIN pg_catalog.pg_depend AS dependencies
                    ON dependencies.classid =
                      'pg_catalog.pg_proc'::pg_catalog.regclass
                   AND dependencies.objid = routines.oid
                   AND dependencies.objsubid = 0
                   AND dependencies.refclassid =
                     'pg_catalog.pg_extension'::pg_catalog.regclass
                   AND dependencies.refobjid = extensions.oid
                   AND dependencies.deptype = 'e'
                  CROSS JOIN role_oids
                  WHERE routines.proname = 'pg_stat_statements'
                    AND routines.pronargs = 1
                    AND routines.proargtypes =
                      ARRAY['pg_catalog.bool'::pg_catalog.regtype]::oidvector
                    AND pg_catalog.has_function_privilege(
                      role_oids.capability_owner_oid,
                      routines.oid,
                      'EXECUTE'
                    )
                ) = 1
                AND NOT EXISTS (
                  SELECT 1
                  FROM pg_catalog.pg_proc AS routines
                  JOIN pg_catalog.pg_extension AS extensions
                    ON extensions.extname = 'pg_stat_statements'
                  JOIN pg_catalog.pg_depend AS dependencies
                    ON dependencies.classid =
                      'pg_catalog.pg_proc'::pg_catalog.regclass
                   AND dependencies.objid = routines.oid
                   AND dependencies.objsubid = 0
                   AND dependencies.refclassid =
                     'pg_catalog.pg_extension'::pg_catalog.regclass
                   AND dependencies.refobjid = extensions.oid
                   AND dependencies.deptype = 'e'
                  CROSS JOIN role_oids
                  CROSS JOIN LATERAL
                    pg_catalog.aclexplode(
                      COALESCE(
                        routines.proacl,
                        pg_catalog.acldefault('f', routines.proowner)
                      )
                    ) AS grants
                  WHERE grants.grantee IN (
                    0,
                    role_oids.observer_oid,
                    role_oids.view_owner_oid,
                    role_oids.read_all_stats_oid
                  )
                     OR grants.grantee = role_oids.capability_owner_oid
                       AND NOT (
                         routines.proname = 'pg_stat_statements'
                         AND routines.pronargs = 1
                         AND routines.proargtypes = ARRAY[
                           'pg_catalog.bool'::pg_catalog.regtype
                         ]::oidvector
                         AND grants.privilege_type = 'EXECUTE'
                         AND NOT grants.is_grantable
                       )
                )
            END AS valid
        ), admitted_routines AS (
          SELECT routines.oid
          FROM capability_routines AS routines
          CROSS JOIN capability_interfaces
          WHERE capability_interfaces.valid
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
               COALESCE(
                 ARRAY(
                   SELECT setting
                   FROM pg_catalog.unnest(roles.rolconfig) AS setting
                   ORDER BY setting
                 ),
                 ARRAY[]::text[]
               ) AS "roleConfiguration",
               COALESCE(
                 (
                   SELECT settings.setconfig
                   FROM pg_catalog.pg_db_role_setting AS settings
                   WHERE settings.setrole = roles.oid
                     AND settings.setdatabase = (
                       SELECT databases.oid
                       FROM pg_catalog.pg_database AS databases
                       WHERE databases.datname = pg_catalog.current_database()
                     )
                 ),
                 ARRAY[]::text[]
               ) AS "databaseRoleConfiguration",
               COALESCE(
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
                   AND (
                     memberships.admin_option
                     OR NOT memberships.inherit_option
                     OR NOT memberships.set_option
                   )
               ) AS "hasInvalidMembershipOptions",
               EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_auth_members AS memberships
                 WHERE memberships.roleid = roles.oid
               ) AS "hasInboundMemberships",
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
               EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_default_acl AS default_acls
                 LEFT JOIN LATERAL
                   pg_catalog.aclexplode(default_acls.defaclacl) AS grants
                   ON true
                 WHERE default_acls.defaclrole = roles.oid
                    OR grants.grantee = roles.oid
                    OR (
                      grants.grantee <> 0
                      AND pg_catalog.pg_has_role(
                        roles.oid,
                        grants.grantee,
                        'USAGE'
                      )
                    )
               ) AS "hasDefaultAclAuthority",
               EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_proc AS routines
                 JOIN pg_catalog.pg_namespace AS namespaces
                   ON namespaces.oid = routines.pronamespace
                 WHERE namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
                   AND namespaces.nspname NOT LIKE 'pg_toast%'
                   AND namespaces.nspname NOT LIKE 'pg_temp_%'
                   AND routines.oid NOT IN (SELECT oid FROM admitted_routines)
                   AND (
                     pg_catalog.pg_has_role(
                       roles.oid,
                       routines.proowner,
                       'USAGE'
                     )
                     OR EXISTS (
                       SELECT 1
                       FROM pg_catalog.aclexplode(routines.proacl) AS grants
                       WHERE grants.grantee = roles.oid
                          OR (
                            grants.grantee <> 0
                            AND pg_catalog.pg_has_role(
                              roles.oid,
                              grants.grantee,
                              'USAGE'
                            )
                          )
                       )
                   )
               ) AS "hasRoutineGrantAuthority",
               EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_proc AS routines
                 JOIN pg_catalog.pg_namespace AS namespaces
                   ON namespaces.oid = routines.pronamespace
                 WHERE namespaces.nspname NOT IN ('information_schema', 'pg_catalog')
                   AND namespaces.nspname NOT LIKE 'pg_toast%'
                   AND namespaces.nspname NOT LIKE 'pg_temp_%'
                   AND routines.prosecdef
                   AND routines.oid NOT IN (SELECT oid FROM admitted_routines)
                   AND pg_catalog.has_function_privilege(
                     roles.oid,
                     routines.oid,
                     'EXECUTE'
                   )
               ) AS "hasSecurityDefinerRoutineAuthority",
               pg_catalog.pg_has_role(
                 current_user,
                 'pg_monitor',
                 'member'
               ) AS "isPgMonitor",
               pg_catalog.pg_has_role(
                 current_user,
                 'pg_read_all_stats',
                 'member'
               ) AS "isPgReadAllStats",
               pg_catalog.pg_has_role(
                 current_user,
                 'mira_dashboard_observability_capability_owner',
                 'member'
               ) AS "isCapabilityOwner",
               pg_catalog.pg_has_role(
                 current_user,
                 'mira_dashboard_observability_owner',
                 'member'
               ) AS "isViewOwner",
               COALESCE(
                 (SELECT valid FROM capability_interfaces),
                 false
               ) AS "capabilityInterfacesValid"
        FROM pg_catalog.pg_roles AS roles
        WHERE roles.rolname = current_user
    `;
}

function assertObserverPolicy(
    rows: readonly ObserverPolicyRow[],
    expectedDatabase: string
): void {
    const row = rows.length === 1 ? rows[0] : undefined;
    let satisfiesPolicy: boolean;
    try {
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
            count(row.connectionLimit) === databaseObservabilityObserverConnectionLimit &&
            exactNames(row.roleConfiguration, [
                "default_transaction_read_only=on",
                "idle_in_transaction_session_timeout=60s",
                "idle_session_timeout=60s",
                "statement_timeout=5s",
            ]) &&
            exactNames(row.databaseRoleConfiguration, []) &&
            exactNames(row.directMemberships, []) &&
            !booleanValue(row.hasInvalidMembershipOptions) &&
            !booleanValue(row.hasInboundMemberships) &&
            name(row.currentDatabase) === expectedDatabase &&
            !booleanValue(row.canCreateCurrentDatabase) &&
            !booleanValue(row.canCreateTemporaryTables) &&
            !booleanValue(row.canCreateSchema) &&
            !booleanValue(row.hasBaseTableAuthority) &&
            !booleanValue(row.hasUnexpectedRelationAuthority) &&
            !booleanValue(row.hasSequenceAuthority) &&
            !booleanValue(row.hasDefaultAclAuthority) &&
            !booleanValue(row.hasRoutineGrantAuthority) &&
            !booleanValue(row.hasSecurityDefinerRoutineAuthority) &&
            booleanValue(row.capabilityInterfacesValid) &&
            !booleanValue(row.isPgMonitor) &&
            !booleanValue(row.isPgReadAllStats) &&
            !booleanValue(row.isCapabilityOwner) &&
            !booleanValue(row.isViewOwner);
    } catch {
        satisfiesPolicy = false;
    }
    if (!satisfiesPolicy) throw new ObserverPolicyViolationError();
}

async function assertClientObserverPolicy(
    client: DatabaseObservabilitySqlClient,
    expectedDatabase: string,
    signal: AbortSignal
): Promise<void> {
    assertObserverPolicy(
        assertRows<ObserverPolicyRow>(
            await executeQuery(observerPolicyRowsQuery(client), signal),
            1
        ),
        expectedDatabase
    );
    await executeQuery(client<never[]>`SET LOCAL search_path = pg_catalog`, signal);
}

function tableHealthRowsQuery(client: DatabaseObservabilitySqlClient) {
    return client<TableHealthRow[]>`
        SELECT schema_name,
               table_name,
               physical_bytes::bigint,
               live_tuples::bigint,
               dead_tuples::bigint,
               last_autovacuum_at_ms::bigint,
               last_autoanalyze_at_ms::bigint,
               dead_tuple_percent,
               assessed,
               estimated_reclaimable_bytes::bigint
        FROM mira_dashboard_observability_capabilities.table_health()
        LIMIT ${databaseObservabilityTableHealthMaximum}
    `;
}

function maintenanceRowsQuery(client: DatabaseObservabilitySqlClient) {
    return client<MaintenanceRow[]>`
        SELECT assessed_physical_bytes::bigint,
               estimated_reclaimable_bytes::bigint,
               high_dead_tuple_table_count::bigint,
               unassessed_physical_bytes::bigint,
               unassessed_table_count::bigint
        FROM mira_dashboard_observability_capabilities.maintenance_metrics()
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
               total_execution_ms::double precision,
               mean_execution_ms::double precision,
               rows::bigint,
               shared_blocks_hit::bigint,
               shared_blocks_read::bigint
        FROM mira_dashboard_observability_capabilities.statement_metrics()
        ORDER BY total_execution_ms DESC,
                 calls DESC,
                 rows DESC,
                 shared_blocks_read DESC,
                 shared_blocks_hit DESC
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

function createSqlPgBouncerAdminCollector(
    sqlClientFactory: DatabaseObservabilitySqlClientFactory
): PgBouncerAdminCollector {
    return Object.freeze({
        collect: (
            resolved: DatabaseObservabilityResolvedConnection,
            signal: AbortSignal
        ) =>
            withClient(
                sqlClientFactory,
                resolved.connection,
                databaseObservabilityPgBouncerVirtualDatabase,
                signal,
                async (client) => ({
                    pools: await executeQuery(pgBouncerPoolsQuery(client), signal),
                    stats: await executeQuery(pgBouncerStatsQuery(client), signal),
                })
            ),
    });
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
        (right.estimatedReclaimableBytes ?? 0) - (left.estimatedReclaimableBytes ?? 0) ||
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
    connection: DatabaseObservabilityConnection,
    database: DatabaseObservabilityTorrentCountDatabase,
    signal: AbortSignal
): Promise<DatabaseObservabilityCachePayload["torrentCounts"][typeof database]> {
    try {
        return await withClient(factory, connection, database, signal, async (client) => {
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
        return { state: "unavailable" };
    }
}

export interface BunSqlDatabaseObservabilityCollectorOptions {
    readonly connectionResolver?: DatabaseObservabilityConnectionResolver | undefined;
    readonly deadlineMs?: number;
    readonly pgBouncerAdminCollector?: PgBouncerAdminCollector;
    readonly sqlClientFactory?: DatabaseObservabilitySqlClientFactory;
}

/** Worker-private source identity retained only for diagnostics and reconciliation. */
export interface DatabaseObservabilityConnectionSource {
    readonly containerId: string;
    readonly containerPort: number;
    readonly composeProject?: string;
    readonly composeService?: string;
}

/** Validated worker-private connection fields; no topology value is application configuration. */
export interface DatabaseObservabilityConnection {
    readonly controlDatabase: string;
    readonly hostname: string;
    readonly password: Redacted.Redacted<string>;
    readonly port: number;
}

/** One dynamically resolved connection whose source identity never enters cache payloads. */
export interface DatabaseObservabilityResolvedConnection {
    readonly connection: DatabaseObservabilityConnection;
    readonly source: DatabaseObservabilityConnectionSource;
}

/** Re-resolves the current database endpoint for every external snapshot attempt. */
export interface DatabaseObservabilityConnectionResolver {
    readonly resolve: (
        signal?: AbortSignal
    ) => Promise<DatabaseObservabilityResolvedConnection>;
}

/**
 * Creates a sequential direct-protocol collector. Each pool is fixed to one connection,
 * every discovered database name is bounded, and PgBouncer uses its separate admin DB.
 * @returns A worker-owned bounded database observability collector.
 */
export function createBunSqlDatabaseObservabilityCollector(
    options: BunSqlDatabaseObservabilityCollectorOptions
): DatabaseObservabilityCollector {
    const connectionResolver = options.connectionResolver;
    if (connectionResolver === undefined) {
        return unavailableCollector();
    }
    const deadlineMs = options.deadlineMs ?? databaseObservabilityDeadlineMs;
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) {
        throw new RangeError("Database observability deadline is invalid");
    }
    const sqlClientFactory = options.sqlClientFactory ?? defaultSqlClientFactory();
    const pgBouncerAdminCollector =
        options.pgBouncerAdminCollector ??
        (options.sqlClientFactory === undefined
            ? createDockerPgBouncerAdminCollector()
            : createSqlPgBouncerAdminCollector(sqlClientFactory));
    return Object.freeze({
        async collect(parentSignal?: AbortSignal) {
            const controller = new AbortController();
            const relayAbort = () => controller.abort(signalFailure());
            if (parentSignal?.aborted) relayAbort();
            else parentSignal?.addEventListener("abort", relayAbort, { once: true });
            const deadline = setTimeout(relayAbort, deadlineMs);
            try {
                const resolvedConnection = await connectionResolver.resolve(
                    controller.signal
                );
                const connection = validatedConnection(resolvedConnection.connection);
                const { controlDatabase } = connection;
                const catalog = await withClient(
                    sqlClientFactory,
                    connection,
                    controlDatabase,
                    controller.signal,
                    async (client) => {
                        return withReadOnlySnapshot(
                            client,
                            controller.signal,
                            async () => {
                                await assertClientObserverPolicy(
                                    client,
                                    controlDatabase,
                                    controller.signal
                                );
                                const databaseRows = assertRows<DatabaseRow>(
                                    await executeQuery(
                                        databaseRowsQuery(client),
                                        controller.signal
                                    ),
                                    databaseObservabilityDatabaseMaximum
                                );
                                const clusterDatabaseCount =
                                    databaseRows.length === 0
                                        ? 0
                                        : count(databaseRows[0]!.database_count);
                                if (
                                    clusterDatabaseCount !== databaseRows.length ||
                                    databaseRows.some(
                                        (row) =>
                                            count(row.database_count) !==
                                            clusterDatabaseCount
                                    )
                                ) {
                                    throw new RangeError(
                                        "Database observability database budget was exceeded"
                                    );
                                }
                                const databaseNames = databaseRows
                                    .map((row) => name(row.datname))
                                    .toSorted(compareStrings);
                                if (
                                    databaseNames.length === 0 ||
                                    new Set(databaseNames).size !==
                                        databaseNames.length ||
                                    !databaseNames.includes(controlDatabase)
                                ) {
                                    throw new TypeError(
                                        "Database observability catalog inventory is invalid"
                                    );
                                }
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
                                const connectionRows = assertRows<ConnectionRow>(
                                    await executeQuery(
                                        connectionRowsQuery(client),
                                        controller.signal
                                    ),
                                    1
                                );
                                return {
                                    connectionRows,
                                    databaseNames,
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
                            blocksHit,
                            blocksRead,
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
                const connections = catalog.connectionRows[0];
                if (connections === undefined) {
                    throw new TypeError("Database connection summary is absent");
                }
                let totalDatabaseSizeBytes = 0;
                let totalBlocksHit = 0;
                let totalBlocksRead = 0;
                for (const row of catalog.databaseRows) {
                    totalBlocksHit = addCount(totalBlocksHit, count(row.blks_hit));
                    totalBlocksRead = addCount(totalBlocksRead, count(row.blks_read));
                }
                for (const database of databases) {
                    totalDatabaseSizeBytes = addCount(
                        totalDatabaseSizeBytes,
                        database.sizeBytes
                    );
                }
                const averageCacheHitRatio =
                    totalBlocksHit + totalBlocksRead === 0
                        ? 100
                        : (totalBlocksHit / (totalBlocksHit + totalBlocksRead)) * 100;

                const tableHealthCandidates: DatabaseObservabilityCachePayload["tableHealth"][number][] =
                    [];
                const maintenance: MaintenanceAggregate = {
                    assessedPhysicalBytes: 0,
                    estimatedReclaimableBytes: 0,
                    highDeadTupleTableCount: 0,
                    unassessedPhysicalBytes: 0,
                    unassessedTableCount: 0,
                };
                const availableDatabaseNames = new Set<string>();
                for (const database of databases) {
                    try {
                        const observation = await withClient(
                            sqlClientFactory,
                            connection,
                            database.name,
                            controller.signal,
                            async (client) => {
                                const { maintenanceRows, rows } =
                                    await withReadOnlySnapshot(
                                        client,
                                        controller.signal,
                                        async () => {
                                            await assertClientObserverPolicy(
                                                client,
                                                database.name,
                                                controller.signal
                                            );
                                            return {
                                                maintenanceRows:
                                                    assertRows<MaintenanceRow>(
                                                        await executeQuery(
                                                            maintenanceRowsQuery(client),
                                                            controller.signal
                                                        ),
                                                        1
                                                    ),
                                                rows: assertRows<TableHealthRow>(
                                                    await executeQuery(
                                                        tableHealthRowsQuery(client),
                                                        controller.signal
                                                    ),
                                                    databaseObservabilityTableHealthMaximum
                                                ),
                                            };
                                        }
                                    );
                                if (maintenanceRows.length !== 1) {
                                    throw new TypeError(
                                        "Database maintenance summary row is absent"
                                    );
                                }
                                const projectedRows = rows.map((row) => {
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
                                });
                                const projectedMaintenance: MaintenanceAggregate = {
                                    assessedPhysicalBytes: 0,
                                    estimatedReclaimableBytes: 0,
                                    highDeadTupleTableCount: 0,
                                    unassessedPhysicalBytes: 0,
                                    unassessedTableCount: 0,
                                };
                                addMaintenanceRow(
                                    projectedMaintenance,
                                    maintenanceRows[0]!
                                );
                                return {
                                    maintenance: projectedMaintenance,
                                    rows: projectedRows,
                                };
                            }
                        );
                        tableHealthCandidates.push(...observation.rows);
                        maintenance.assessedPhysicalBytes = addCount(
                            maintenance.assessedPhysicalBytes,
                            observation.maintenance.assessedPhysicalBytes
                        );
                        maintenance.estimatedReclaimableBytes = addCount(
                            maintenance.estimatedReclaimableBytes,
                            observation.maintenance.estimatedReclaimableBytes
                        );
                        maintenance.highDeadTupleTableCount = addCount(
                            maintenance.highDeadTupleTableCount,
                            observation.maintenance.highDeadTupleTableCount
                        );
                        maintenance.unassessedPhysicalBytes = addCount(
                            maintenance.unassessedPhysicalBytes,
                            observation.maintenance.unassessedPhysicalBytes
                        );
                        maintenance.unassessedTableCount = addCount(
                            maintenance.unassessedTableCount,
                            observation.maintenance.unassessedTableCount
                        );
                        availableDatabaseNames.add(database.name);
                    } catch (error) {
                        if (
                            controller.signal.aborted ||
                            (error instanceof DOMException && error.name === "AbortError")
                        ) {
                            throw signalFailure();
                        }
                    }
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

                const discoveredDatabaseNames = new Set(catalog.databaseNames);
                const torrentCounts = {
                    bitmagnet: discoveredDatabaseNames.has(
                        databaseObservabilityTorrentCountDatabases[0]
                    )
                        ? await collectTorrentCount(
                              sqlClientFactory,
                              connection,
                              databaseObservabilityTorrentCountDatabases[0],
                              controller.signal
                          )
                        : { state: "unavailable" as const },
                    comet: discoveredDatabaseNames.has(
                        databaseObservabilityTorrentCountDatabases[1]
                    )
                        ? await collectTorrentCount(
                              sqlClientFactory,
                              connection,
                              databaseObservabilityTorrentCountDatabases[1],
                              controller.signal
                          )
                        : { state: "unavailable" as const },
                };

                const pgBouncerRows = await pgBouncerAdminCollector.collect(
                    resolvedConnection,
                    controller.signal
                );
                const pgBouncer = (() => {
                    const poolRows = assertRows<PgBouncerPoolRow>(
                        pgBouncerRows.pools,
                        databaseObservabilityPgBouncerInputMaximum
                    );
                    const statsRows = assertRows<PgBouncerStatsRow>(
                        pgBouncerRows.stats,
                        databaseObservabilityPgBouncerInputMaximum - poolRows.length
                    );
                    const observedPoolRows = poolRows.filter((row) =>
                        discoveredDatabaseNames.has(name(row.database))
                    );
                    const observedStatsRows = statsRows.filter((row) =>
                        discoveredDatabaseNames.has(name(row.database))
                    );
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
                    for (const row of observedPoolRows) {
                        const database = name(row.database);
                        const aggregate = poolsByDatabase.get(database) ?? {
                            activeClients: 0,
                            activeServers: 0,
                            idleServers: 0,
                            usedServers: 0,
                            waitingClients: 0,
                        };
                        aggregate.activeClients = addCounts(
                            addCounts(aggregate.activeClients, row.cl_active),
                            row.cl_active_cancel_req
                        );
                        aggregate.activeServers = addCounts(
                            addCounts(
                                addCounts(aggregate.activeServers, row.sv_active),
                                row.sv_active_cancel
                            ),
                            row.sv_being_canceled
                        );
                        aggregate.idleServers = addCounts(
                            aggregate.idleServers,
                            row.sv_idle
                        );
                        aggregate.usedServers = addCounts(
                            aggregate.usedServers,
                            row.sv_used
                        );
                        aggregate.waitingClients = addCounts(
                            addCounts(aggregate.waitingClients, row.cl_waiting),
                            row.cl_waiting_cancel_req
                        );
                        poolsByDatabase.set(database, aggregate);
                    }
                    const statsByDatabase = new Map<
                        string,
                        {
                            averageQueryCount: number;
                            averageTransactionCount: number;
                            totalQueries: number;
                            weightedQueryTimeMicroseconds: number;
                            weightedTransactionTimeMicroseconds: number;
                        }
                    >();
                    for (const row of observedStatsRows) {
                        const database = name(row.database);
                        const aggregate = statsByDatabase.get(database) ?? {
                            averageQueryCount: 0,
                            averageTransactionCount: 0,
                            totalQueries: 0,
                            weightedQueryTimeMicroseconds: 0,
                            weightedTransactionTimeMicroseconds: 0,
                        };
                        aggregate.averageQueryCount = addCounts(
                            aggregate.averageQueryCount,
                            row.avg_query_count
                        );
                        aggregate.averageTransactionCount = addCounts(
                            aggregate.averageTransactionCount,
                            row.avg_xact_count
                        );
                        aggregate.totalQueries = addCounts(
                            aggregate.totalQueries,
                            row.total_query_count
                        );
                        aggregate.weightedQueryTimeMicroseconds = addWeightedDuration(
                            aggregate.weightedQueryTimeMicroseconds,
                            row.avg_query_time,
                            row.avg_query_count
                        );
                        aggregate.weightedTransactionTimeMicroseconds =
                            addWeightedDuration(
                                aggregate.weightedTransactionTimeMicroseconds,
                                row.avg_xact_time,
                                row.avg_xact_count
                            );
                        statsByDatabase.set(database, aggregate);
                    }
                    let averageQueryCount = 0;
                    let averageTransactionCount = 0;
                    let weightedQueryTimeMicroseconds = 0;
                    let weightedTransactionTimeMicroseconds = 0;
                    for (const aggregate of statsByDatabase.values()) {
                        averageQueryCount = addCounts(
                            averageQueryCount,
                            aggregate.averageQueryCount
                        );
                        averageTransactionCount = addCounts(
                            averageTransactionCount,
                            aggregate.averageTransactionCount
                        );
                        weightedQueryTimeMicroseconds = addNonnegativeNumbers(
                            weightedQueryTimeMicroseconds,
                            aggregate.weightedQueryTimeMicroseconds
                        );
                        weightedTransactionTimeMicroseconds = addNonnegativeNumbers(
                            weightedTransactionTimeMicroseconds,
                            aggregate.weightedTransactionTimeMicroseconds
                        );
                    }
                    let maxWaitSeconds = 0;
                    let clientConnections = 0;
                    let serverConnections = 0;
                    let waitingClients = 0;
                    for (const row of observedPoolRows) {
                        maxWaitSeconds = Math.max(
                            maxWaitSeconds,
                            nonnegativeNumber(row.maxwait)
                        );
                        const activeClients = addCounts(
                            addCounts(0, row.cl_active),
                            row.cl_active_cancel_req
                        );
                        const waitingClientsForRow = addCounts(
                            addCounts(0, row.cl_waiting),
                            row.cl_waiting_cancel_req
                        );
                        clientConnections = addCounts(clientConnections, activeClients);
                        clientConnections = addCounts(
                            clientConnections,
                            waitingClientsForRow
                        );
                        waitingClients = addCounts(waitingClients, waitingClientsForRow);
                        for (const serverState of [
                            row.sv_active,
                            row.sv_active_cancel,
                            row.sv_being_canceled,
                            row.sv_idle,
                            row.sv_used,
                            row.sv_tested,
                            row.sv_login,
                        ]) {
                            serverConnections = addCounts(serverConnections, serverState);
                        }
                    }
                    return {
                        averageQueryMs: averageDurationMs(
                            weightedQueryTimeMicroseconds,
                            averageQueryCount
                        ),
                        averageTransactionMs: averageDurationMs(
                            weightedTransactionTimeMicroseconds,
                            averageTransactionCount
                        ),
                        clientConnections,
                        maxWaitSeconds,
                        serverConnections,
                        waitingClients,
                        perDatabase: new Map(
                            [
                                ...new Set([
                                    ...poolsByDatabase.keys(),
                                    ...statsByDatabase.keys(),
                                ]),
                            ]
                                .toSorted((left, right) => left.localeCompare(right))
                                .map((database) => {
                                    const pool = poolsByDatabase.get(database) ?? {
                                        activeClients: 0,
                                        activeServers: 0,
                                        idleServers: 0,
                                        usedServers: 0,
                                        waitingClients: 0,
                                    };
                                    const stats = statsByDatabase.get(database);
                                    return [
                                        database,
                                        {
                                            ...pool,
                                            averageQueryMs: averageDurationMs(
                                                stats?.weightedQueryTimeMicroseconds ?? 0,
                                                stats?.averageQueryCount ?? 0
                                            ),
                                            averageTransactionMs: averageDurationMs(
                                                stats?.weightedTransactionTimeMicroseconds ??
                                                    0,
                                                stats?.averageTransactionCount ?? 0
                                            ),
                                            totalQueries: stats?.totalQueries ?? 0,
                                        },
                                    ] as const;
                                })
                        ),
                    };
                })();
                const databasesWithPools = databases.map((database) => ({
                    ...database,
                    detailsState: availableDatabaseNames.has(database.name)
                        ? ("available" as const)
                        : ("unavailable" as const),
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
                const unavailableDatabaseCount =
                    databases.length - availableDatabaseNames.size;
                const assessmentComplete =
                    maintenance.unassessedTableCount === 0 &&
                    unavailableDatabaseCount === 0;
                const requiresMaintenanceReview =
                    requiresBloatReview ||
                    maintenance.highDeadTupleTableCount > 0 ||
                    slowStatementCount > 0;
                let maintenanceStatus: "healthy" | "not-assessed" | "review" =
                    assessmentComplete && catalog.pgStatStatementsEnabled
                        ? "healthy"
                        : "not-assessed";
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
                        unavailableDatabaseCount,
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
