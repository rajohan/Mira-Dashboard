import { Redacted } from "effect";

import { databaseObservabilityObserverRole } from "../../shared/databaseObservabilityPolicy.ts";
import type { DatabaseObservabilityResolvedConnection } from "./bunSqlDatabaseObservabilityCollector.ts";

const dockerExecutable = "/usr/bin/docker";
const maximumOutputBytes = 512 * 1024;
const commandScript = [
    "set -eu",
    "IFS= read -r PGPASSWORD",
    "export PGPASSWORD",
    'exec psql --host=127.0.0.1 --port="$1" --username="$2" --dbname=pgbouncer --no-password --no-psqlrc --csv --command="$3"',
].join("\n");

export interface PgBouncerAdminRows {
    readonly pools: readonly unknown[];
    readonly stats: readonly unknown[];
}

export interface PgBouncerAdminCollector {
    readonly collect: (
        resolved: DatabaseObservabilityResolvedConnection,
        signal: AbortSignal
    ) => Promise<PgBouncerAdminRows>;
}

export interface PgBouncerAdminProcessResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

export type PgBouncerAdminProcess = (
    arguments_: readonly string[],
    stdin: Uint8Array,
    signal: AbortSignal
) => Promise<PgBouncerAdminProcessResult>;

/**
 * Reads one process pipe while enforcing the collector's fixed memory bound.
 * @returns The combined output bytes.
 */
export async function readBoundedPgBouncerOutput(
    stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.byteLength;
            if (length > maximumOutputBytes) throw new Error("PgBouncer output failed");
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

const runProcess: PgBouncerAdminProcess = async (arguments_, stdin, signal) => {
    const child = Bun.spawn([dockerExecutable, ...arguments_], {
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
        signal,
        stderr: "pipe",
        stdin: "pipe",
        stdout: "pipe",
    });
    try {
        await child.stdin.write(stdin);
        await child.stdin.end();
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            readBoundedPgBouncerOutput(child.stdout),
            readBoundedPgBouncerOutput(child.stderr),
        ]);
        return { exitCode, stderr, stdout };
    } catch {
        child.kill();
        await child.exited.catch(() => {});
        throw new Error("PgBouncer collection failed");
    }
};

function parseCsvLine(line: string): readonly string[] {
    const fields: string[] = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index]!;
        if (quoted) {
            if (character === '"' && line[index + 1] === '"') {
                field += '"';
                index += 1;
            } else if (character === '"') quoted = false;
            else field += character;
        } else if (character === ",") {
            fields.push(field);
            field = "";
        } else if (character === '"' && field === "") quoted = true;
        else field += character;
    }
    if (quoted) throw new Error("PgBouncer CSV failed");
    fields.push(field);
    return fields;
}

function parseCsv(output: Uint8Array): readonly Readonly<Record<string, string>>[] {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(output).trim();
    if (text === "") return Object.freeze([]);
    const lines = text.split("\n");
    const headers = parseCsvLine(lines[0]!);
    if (headers.length === 0 || new Set(headers).size !== headers.length) {
        throw new Error("PgBouncer CSV failed");
    }
    return Object.freeze(
        lines.slice(1).map((line) => {
            const fields = parseCsvLine(line.replace(/\r$/u, ""));
            if (fields.length !== headers.length) throw new Error("PgBouncer CSV failed");
            return Object.freeze(
                Object.fromEntries(headers.map((key, index) => [key, fields[index]!]))
            );
        })
    );
}

async function collectRows(
    process: PgBouncerAdminProcess,
    resolved: DatabaseObservabilityResolvedConnection,
    command: "SHOW POOLS" | "SHOW STATS",
    signal: AbortSignal
): Promise<readonly Readonly<Record<string, string>>[]> {
    const password = Redacted.value(resolved.connection.password);
    const result = await process(
        [
            "exec",
            "--interactive",
            resolved.source.containerId,
            "/bin/sh",
            "-c",
            commandScript,
            "sh",
            String(resolved.source.containerPort),
            databaseObservabilityObserverRole,
            command,
        ],
        new TextEncoder().encode(`${password}\n`),
        signal
    );
    if (result.exitCode !== 0 || result.stderr.byteLength > maximumOutputBytes) {
        throw new Error("PgBouncer collection failed");
    }
    return parseCsv(result.stdout);
}

/**
 * Collects PgBouncer's simple-protocol-only admin views through its own psql client.
 * @returns A bounded PgBouncer admin collector.
 */
export function createDockerPgBouncerAdminCollector(
    process: PgBouncerAdminProcess = runProcess
): PgBouncerAdminCollector {
    return Object.freeze({
        async collect(
            resolved: DatabaseObservabilityResolvedConnection,
            signal: AbortSignal
        ) {
            const controller = new AbortController();
            const abort = () => controller.abort(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
            const operations = [
                collectRows(process, resolved, "SHOW POOLS", controller.signal),
                collectRows(process, resolved, "SHOW STATS", controller.signal),
            ] as const;
            try {
                const [pools, stats] = await Promise.all(operations);
                return Object.freeze({ pools, stats });
            } catch (error) {
                controller.abort(error);
                await Promise.allSettled(operations);
                throw error;
            } finally {
                signal.removeEventListener("abort", abort);
            }
        },
    });
}
