import { isIP } from "node:net";

import { runProcess } from "../../lib/processes.ts";

const DOCKER_EXEC_TIMEOUT_MS = 30_000;

/**
 * Parses tab-delimited psql --no-align output into typed row objects; blank/header-only output returns an empty array.
 * @param output Output value.
 * @returns Parsed tab-delimited rows.
 */
export function parseTable<T extends object>(output: string): T[] {
    const trimmed = output.trim();
    if (!trimmed) {
        return [];
    }

    const lines = trimmed.split("\n").filter(Boolean);
    if (lines.length < 2) {
        return [];
    }

    const headerLine = lines[0];
    if (headerLine === undefined) {
        return [];
    }
    const headers = headerLine.split("\t");
    return lines.slice(1).map((line) => {
        const cells = line.split("\t");
        return Object.fromEntries(
            headers.map((header, index) => [header, cells[index] ?? ""])
        ) as T;
    });
}

/**
 * Returns a string value or a fallback using the route's existing falsy-value behavior.
 * @param value Value to process.
 * @param fallback Fallback value.
 * @returns a string value or a fallback using the route's existing falsy-value behavior.
 */
export function stringWithDefault(value: string | undefined, fallback: string): string {
    return value || fallback;
}

/**
 * Converts psql numeric text to a number, preserving the existing falsy-to-zero behavior.
 * @param value Value to process.
 * @returns Converted psql numeric text to a number, preserving the existing falsy-to-zero behavior.
 */
export function numberFrom(value: string | undefined): number {
    return Number(value || 0);
}

/**
 * Runs a command inside a Docker container and returns raw stdout.
 * @param container Container value.
 * @param command Command value.
 * @param environment Environment value.
 * @returns Promise resolving to the run docker exec result.
 */
async function runDockerExec(
    container: string,
    command: string[],
    environment: Record<string, string | undefined> = {}
) {
    const environmentArguments = Object.entries(environment).flatMap(([key, value]) =>
        value === undefined ? [] : ["--env", key]
    );
    const { code, stderr, stdout } = await runProcess(
        "docker",
        ["exec", ...environmentArguments, container, ...command],
        {
            env: { ...process.env, ...environment },
            maxBuffer: 10 * 1024 * 1024,
            timeoutMs: DOCKER_EXEC_TIMEOUT_MS,
        }
    );
    if (code !== 0) {
        throw new Error(
            `docker exec failed with exit code ${code}: ${stderr.trim() || stdout.trim()}`
        );
    }
    return stdout;
}

/**
 * Returns trimmed environment overrides while treating whitespace-only values as missing.
 * @param value Value to process.
 * @returns trimmed environment overrides while treating whitespace-only values as missing.
 */
function trimmedEnvironmentValue(value: string | undefined): string | undefined {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" ? undefined : trimmed;
}

/**
 * Returns a fallback only when the value is absent, preserving intentional blanks.
 * @param value Value to process.
 * @param fallback Fallback value.
 * @returns a fallback only when the value is absent, preserving intentional blanks.
 */
function environmentValueOrDefault(value: string | undefined, fallback: string): string {
    return value === undefined ? fallback : value;
}

/**
 * Returns a safe PostgreSQL hostname for URI construction.
 * @param value Value to process.
 * @param fallback Fallback value.
 * @returns a safe PostgreSQL hostname for URI construction.
 */
function normalizePostgresHost(value: string | undefined, fallback: string): string {
    const host = trimmedEnvironmentValue(value) ?? fallback;
    const isValidIpv4 =
        /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/u.test(host);
    if (!isValidIpv4 && /^(?:\d+\.){3}\d+$/u.test(host)) {
        throw Object.assign(new Error("Invalid PostgreSQL host"), { code: "EINVAL" });
    }
    const validIpv6 =
        host.startsWith("[") && host.endsWith("]") && isIP(host.slice(1, -1)) === 6;
    const isRawIpv6 = isIP(host) === 6;
    if (
        !validIpv6 &&
        !isValidIpv4 &&
        !isRawIpv6 &&
        !/^(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)(?:\.(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?))*$/u.test(
            host
        )
    ) {
        throw Object.assign(new Error("Invalid PostgreSQL host"), { code: "EINVAL" });
    }
    return isRawIpv6 ? `[${host}]` : host;
}

/**
 * Returns a safe PostgreSQL port for URI construction.
 * @param value Value to process.
 * @returns a safe PostgreSQL port for URI construction.
 */
function normalizePostgresPort(value: string | undefined): string {
    const port = trimmedEnvironmentValue(value) ?? "5432";
    if (!/^\d+$/u.test(port)) {
        throw Object.assign(new Error("Invalid PostgreSQL port"), { code: "EINVAL" });
    }
    const portNumber = Number(port);
    if (!Number.isSafeInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
        throw Object.assign(new Error("Invalid PostgreSQL port"), { code: "EINVAL" });
    }
    return String(portNumber);
}

interface PostgresConnection {
    password: string;
    uri: string;
}

/**
 * Builds PostgreSQL connection details from environment defaults for the requested database.
 * @param database Database value.
 * @returns Built PostgreSQL connection details from environment defaults for the requested database.
 */
function buildPostgresConnection(database = "postgres"): PostgresConnection {
    const username = encodeURIComponent(
        environmentValueOrDefault(process.env.DATABASE_USERNAME, "postgres")
    );
    const password = environmentValueOrDefault(process.env.DATABASE_PASSWORD, "postgres");
    const host = normalizePostgresHost(process.env.DATABASE_HOST, "postgres");
    const port = normalizePostgresPort(process.env.DATABASE_PORT);
    const database_ = encodeURIComponent(database);
    return { password, uri: `postgresql://${username}@${host}:${port}/${database_}` };
}

/**
 * Builds PgBouncer admin connection details from environment defaults.
 * @param database Database value.
 * @returns Built PgBouncer admin connection details from environment defaults.
 */
function buildPgBouncerConnection(database = "pgbouncer"): PostgresConnection {
    const username = encodeURIComponent(
        environmentValueOrDefault(process.env.DATABASE_USERNAME, "postgres")
    );
    const password = environmentValueOrDefault(process.env.DATABASE_PASSWORD, "postgres");
    const host = normalizePostgresHost(process.env.PGBOUNCER_HOST, "pgbouncer");
    const port = normalizePostgresPort(process.env.PGBOUNCER_PORT);
    const database_ = encodeURIComponent(database);
    return { password, uri: `postgresql://${username}@${host}:${port}/${database_}` };
}

/**
 * Executes SQL against Postgres through the postgres container and returns tab-delimited stdout.
 * @param sql Sql value.
 * @param database Database value.
 * @returns Promise resolving to the query postgres result.
 */
export async function queryPostgres(sql: string, database = "postgres") {
    const connection = buildPostgresConnection(database);
    return runDockerExec(
        "postgres",
        ["psql", connection.uri, "-P", "footer=off", "-F", "\t", "--no-align", "-c", sql],
        {
            PGPASSWORD: connection.password,
        }
    );
}

/**
 * Executes SQL against the PgBouncer admin database and returns tab-delimited stdout.
 * @param sql Sql value.
 * @returns Promise resolving to the query pg bouncer result.
 */
export async function queryPgBouncer(sql: string) {
    const connection = buildPgBouncerConnection();
    return runDockerExec(
        "postgres",
        ["psql", connection.uri, "-P", "footer=off", "-F", "\t", "--no-align", "-c", sql],
        {
            PGPASSWORD: connection.password,
        }
    );
}

/**
 * Sums numeric values selected from a row collection.
 * @param rows Rows value.
 * @param selector Selector value.
 * @returns Sum by result.
 */
export function sumBy<T>(rows: T[], selector: (row: T) => number): number {
    let total = 0;
    for (const row of rows) {
        total += selector(row);
    }
    return total;
}

/**
 * Runs a SQL query against every connectable non-template database and concatenates parsed rows.
 * @param sql Sql value.
 * @returns Promise resolving to the query all user databases result.
 */
export async function queryAllUserDatabases<T extends object>(
    sql: string
): Promise<Array<T & { database: string }>> {
    const databases = parseTable<{ datname: string }>(
        await queryPostgres(`
            SELECT datname
            FROM pg_database
            WHERE datistemplate = false
              AND datallowconn = true
              AND datname <> 'postgres'
            ORDER BY datname;
        `)
    );

    const results: Array<T & { database: string }> = [];
    for (const database of databases) {
        const rows = parseTable<T>(await queryPostgres(sql, database.datname));
        results.push(...rows.map((row) => ({ ...row, database: database.datname })));
    }

    return results;
}
