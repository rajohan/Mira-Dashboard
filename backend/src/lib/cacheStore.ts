import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { isIP } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const cacheStoreTestState: { dockerBin?: string } = {};

function setDockerBinForTests(value: string | undefined): void {
    cacheStoreTestState.dockerBin = value;
}

function getDockerBinForTests(): string | undefined {
    return cacheStoreTestState.dockerBin;
}

/** Represents one cache entry row. */
export interface CacheEntryRow {
    key: string;
    data: string;
    source: string;
    updated_at: string;
    last_attempt_at: string;
    expires_at: string;
    status: string;
    error_code: string;
    error_message: string;
    consecutive_failures: string;
    meta: string;
}

/** Parses table. */
export function parseTable<T extends object>(output: string): T[] {
    const trimmed = output.trim();
    if (!trimmed) {
        return [];
    }

    const lines = trimmed.split("\n").filter(Boolean);
    if (lines.length < 2) {
        return [];
    }

    const headers = lines[0].split("\t");
    return lines.slice(1).map((line) => {
        const cells = line.split("\t");
        return Object.fromEntries(
            headers.map((header, index) => [header, cells[index] ?? ""])
        ) as T;
    });
}

/** Performs run docker exec. */
async function runDockerExec(container: string, command: string[]) {
    const options: ExecFileOptionsWithStringEncoding = {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
        timeout: 30_000,
        killSignal: "SIGTERM",
    };
    const dockerBin = getDockerBinForTests() || "docker";
    const { stdout } = await execFileAsync(
        dockerBin,
        ["exec", container, ...command],
        options
    );
    return stdout;
}

/** Returns a safe PostgreSQL hostname for URI construction. */
function normalizePostgresHost(value: string | undefined): string {
    const host = value?.trim() || "postgres";
    const validIpv4 =
        /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/u.test(host);
    const validIpv6 =
        host.startsWith("[") && host.endsWith("]") && isIP(host.slice(1, -1)) === 6;
    if (/^(?:\d+\.){3}\d+$/u.test(host) && !validIpv4) {
        throw Object.assign(new Error("Invalid DATABASE_HOST"), { code: "EINVAL" });
    }
    if (
        !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/u.test(
            host
        ) &&
        !validIpv6 &&
        !validIpv4
    ) {
        throw Object.assign(new Error("Invalid DATABASE_HOST"), { code: "EINVAL" });
    }
    return host;
}

/** Returns a safe PostgreSQL port for URI construction. */
function normalizePostgresPort(value: string | undefined): string {
    const port = value?.trim() || "5432";
    if (!/^\d+$/u.test(port)) {
        throw Object.assign(new Error("Invalid DATABASE_PORT"), { code: "EINVAL" });
    }
    const portNumber = Number(port);
    if (!Number.isSafeInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
        throw Object.assign(new Error("Invalid DATABASE_PORT"), { code: "EINVAL" });
    }
    return String(portNumber);
}

/** Builds PostgreSQL uri. */
function buildPostgresUri(database = "n8n") {
    const username = process.env.DATABASE_USERNAME ?? "postgres";
    const password = process.env.DATABASE_PASSWORD ?? "postgres";
    const encodedUsername = encodeURIComponent(username);
    const encodedPassword = encodeURIComponent(password);
    const encodedDatabase = encodeURIComponent(database);
    const host = normalizePostgresHost(process.env.DATABASE_HOST);
    const port = normalizePostgresPort(process.env.DATABASE_PORT);
    return `postgresql://${encodedUsername}:${encodedPassword}@${host}:${port}/${encodedDatabase}`;
}

export const __testing = {
    buildPostgresUri,
    getDockerBinForTests,
    setDockerBinForTests,
};

/** Performs query n8n cache. */
async function queryN8nCache(sql: string) {
    const uri = buildPostgresUri("n8n");
    return runDockerExec("postgres", [
        "psql",
        uri,
        "-P",
        "footer=off",
        "-F",
        "\t",
        "--no-align",
        "-c",
        sql,
    ]);
}

/** Parses JSON field. */
export function parseJsonField<T>(value: string): T | null {
    if (!value) {
        return null;
    }

    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}

/** Returns cache entry. */
export async function getCacheEntry(key: string): Promise<CacheEntryRow | null> {
    const escapedKey = key.replaceAll("'", "''");
    const rows = parseTable<CacheEntryRow>(
        await queryN8nCache(`
        SELECT
            key,
            data::text AS data,
            source,
            updated_at::text AS updated_at,
            last_attempt_at::text AS last_attempt_at,
            expires_at::text AS expires_at,
            status,
            COALESCE(error_code, '') AS error_code,
            COALESCE(error_message, '') AS error_message,
            consecutive_failures::text AS consecutive_failures,
            meta::text AS meta
        FROM cache_entries
        WHERE key = '${escapedKey}'
        LIMIT 1;
    `)
    );

    return rows[0] || null;
}

/** Returns all cache entries. */
export async function getAllCacheEntries(): Promise<CacheEntryRow[]> {
    return parseTable<CacheEntryRow>(
        await queryN8nCache(`
        SELECT
            key,
            data::text AS data,
            source,
            updated_at::text AS updated_at,
            last_attempt_at::text AS last_attempt_at,
            expires_at::text AS expires_at,
            status,
            COALESCE(error_code, '') AS error_code,
            COALESCE(error_message, '') AS error_message,
            consecutive_failures::text AS consecutive_failures,
            meta::text AS meta
        FROM cache_entries
        ORDER BY key ASC;
    `)
    );
}
