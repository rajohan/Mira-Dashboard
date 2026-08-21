import path from "node:path";

import * as v from "valibot";

import {
    type SqliteMaintenanceExecutionPort,
    type SqliteMaintenanceJobResult,
    sqliteMaintenanceJobResultSchema,
} from "../../contracts/database.ts";
import { fullCommitShaSchema } from "../../shared/validation.ts";

const maintenanceFailureMessage = "SQLite maintenance process failed";
const maintenanceTimeoutMs = 15 * 60_000;
const maintenanceOutputMaximumBytes = 64 * 1024;
const maintenanceEnvelopeSchema = v.strictObject({
    processStatus: v.literal("SQLITE_MAINTENANCE"),
    result: sqliteMaintenanceJobResultSchema,
});

export interface SqliteMaintenanceProcessOutput {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

export interface FixedSqliteLifecycleMaintenanceOptions {
    readonly executable?: string;
    readonly migrationsDirectory: string;
    readonly process?: (
        argv: readonly string[],
        cwd: string,
        signal: AbortSignal
    ) => Promise<SqliteMaintenanceProcessOutput>;
    readonly releaseId: string;
    readonly releaseRoot: string;
    readonly scriptPath?: string;
    readonly stateDirectory: string;
    readonly timeoutMs?: number;
}

function requiredAbsoluteDirectory(value: string): string {
    if (
        process.platform !== "linux" ||
        !path.isAbsolute(value) ||
        value === path.parse(value).root ||
        path.resolve(value) !== value ||
        value.includes("\0")
    ) {
        throw new TypeError(maintenanceFailureMessage);
    }
    return value;
}

function requiredTimeout(value: number | undefined): number {
    const timeoutMs = value ?? maintenanceTimeoutMs;
    if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 60_000 ||
        timeoutMs > 30 * 60_000
    ) {
        throw new RangeError(maintenanceFailureMessage);
    }
    return timeoutMs;
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > maintenanceOutputMaximumBytes) {
                throw new Error(maintenanceFailureMessage);
            }
            chunks.push(next.value);
        }
    } finally {
        reader.releaseLock();
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

const defaultProcess = async (
    argv: readonly string[],
    cwd: string,
    signal: AbortSignal
): Promise<SqliteMaintenanceProcessOutput> => {
    const child = Bun.spawn([...argv], {
        cwd,
        env: { NODE_ENV: "production", PATH: "/usr/bin:/bin" },
        killSignal: "SIGKILL",
        signal,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            readBounded(child.stdout),
            readBounded(child.stderr),
        ]);
        return Object.freeze({ exitCode, stderr, stdout });
    } catch {
        child.kill();
        await child.exited.catch(() => null);
        throw new Error(maintenanceFailureMessage);
    }
};

function decodeResult(output: Uint8Array): SqliteMaintenanceJobResult {
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(output);
        if (!text.endsWith("\n") || text.trim().split("\n").length !== 1) {
            throw new Error(maintenanceFailureMessage);
        }
        return v.parse(maintenanceEnvelopeSchema, JSON.parse(text) as unknown).result;
    } catch {
        throw new Error(maintenanceFailureMessage);
    }
}

/**
 * Creates the worker-only fixed child-process boundary for online SQLite maintenance.
 * Every path and argument is composition-owned; no payload, shell, ambient secret, or
 * child output crosses into the durable result.
 * @param options Fixed release, runtime, migration, and state identities.
 * @returns Worker-only maintenance execution port.
 */
export function createFixedSqliteLifecycleMaintenance(
    options: FixedSqliteLifecycleMaintenanceOptions
): SqliteMaintenanceExecutionPort {
    const releaseRoot = requiredAbsoluteDirectory(options.releaseRoot);
    const migrationsDirectory = requiredAbsoluteDirectory(options.migrationsDirectory);
    const stateDirectory = requiredAbsoluteDirectory(options.stateDirectory);
    const executable = requiredAbsoluteDirectory(options.executable ?? process.execPath);
    const releaseId = v.parse(
        fullCommitShaSchema(maintenanceFailureMessage),
        options.releaseId
    );
    if (migrationsDirectory !== path.join(releaseRoot, "migrations")) {
        throw new TypeError(maintenanceFailureMessage);
    }
    const productionScript = path.join(releaseRoot, "server", "databaseMaintenance.js");
    const developmentScript = path.join(
        releaseRoot,
        "src",
        "app",
        "databaseMaintenance.ts"
    );
    const script = requiredAbsoluteDirectory(options.scriptPath ?? productionScript);
    if (script !== productionScript && script !== developmentScript) {
        throw new TypeError(maintenanceFailureMessage);
    }
    const execute = options.process ?? defaultProcess;
    const timeoutMs = requiredTimeout(options.timeoutMs);

    return Object.freeze({
        async run(signal?: AbortSignal): Promise<SqliteMaintenanceJobResult> {
            const deadline = AbortSignal.timeout(timeoutMs);
            const operationSignal =
                signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
            const transitionId = Bun.randomUUIDv7();
            const argv = Object.freeze([
                executable,
                script,
                "--operation=sqlite-maintenance",
                `--migrations=${migrationsDirectory}`,
                `--release=${releaseId}`,
                `--state=${stateDirectory}`,
                `--transition=${transitionId}`,
            ]);
            let output: SqliteMaintenanceProcessOutput;
            try {
                output = await execute(argv, releaseRoot, operationSignal);
            } catch {
                throw new Error(maintenanceFailureMessage);
            }
            if (
                output.exitCode !== 0 ||
                output.stderr.byteLength !== 0 ||
                output.stdout.byteLength > maintenanceOutputMaximumBytes
            ) {
                throw new Error(maintenanceFailureMessage);
            }
            const result = decodeResult(output.stdout);
            if (
                result.backupCreatedAtMs !==
                Number.parseInt(transitionId.slice(0, 8) + transitionId.slice(9, 13), 16)
            ) {
                throw new Error(maintenanceFailureMessage);
            }
            return result;
        },
    });
}
