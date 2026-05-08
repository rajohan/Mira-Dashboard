import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

async function runDockerExec(container: string, command: string) {
    const options: ExecFileOptionsWithStringEncoding = {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
    };
    const { stdout } = await execFileAsync(
        "docker",
        ["exec", container, "bash", "-lc", command],
        options
    );
    return stdout;
}

function buildPostgresUri(database = "n8n") {
    const username = process.env.DATABASE_USERNAME || "postgres";
    const password = process.env.DATABASE_PASSWORD || "postgres";
    const host = process.env.DATABASE_HOST || "postgres";
    const port = process.env.DATABASE_PORT || "5432";
    return `postgresql://${username}:${password}@${host}:${port}/${database}`;
}

async function queryN8nCache(sql: string) {
    const uri = buildPostgresUri("n8n");
    const escapedSql = sql.replaceAll('"', String.raw`\"`);
    return runDockerExec(
        "postgres",
        String.raw`psql "${uri}" -P footer=off -F $'\t' --no-align -c "${escapedSql}"`
    );
}

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
