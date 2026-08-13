import path from "node:path";

import * as v from "valibot";

import { databaseObservabilityDatabaseMaximum } from "../../shared/databaseObservabilityPolicy.ts";
import {
    DatabaseObservabilityCollectionLeaseError,
    type DatabaseObservabilityApprovedCollectionResult,
    type DatabaseObservabilityReconciliationPort,
    type DatabaseObservabilityReconciliationStatus,
} from "../../shared/databaseObservabilityReconciliation.ts";

const openDeadlineMs = 5 * 60_000;
const closeDeadlineMs = 30_000;
const processOutputMaximumBytes = 4096;
const runnerRelativePath =
    "scripts/delivery/provisioning/database-observability/runProvisioning.ts";
const openMode = "open-approved-collection" as const;
const enableMode = "enable-approved-collection" as const;
const closeMode = "close-approved-collection" as const;
const processSupervisorExecutable = "/usr/bin/setpriv";
const processSupervisorShellExecutable = "/bin/sh";
const processSupervisorScript = `set -u
expected_parent="$1"
shift
if [ "$PPID" != "$expected_parent" ]; then
  exit 125
fi
/usr/bin/setsid --wait "$@" &
workload_pid=$!
cleanup() {
  trap - TERM INT HUP EXIT
  /usr/bin/kill -TERM -- "-$workload_pid" 2>/dev/null || true
  attempts=0
  while /usr/bin/kill -0 -- "-$workload_pid" 2>/dev/null && [ "$attempts" -lt 20 ]; do
    /usr/bin/sleep 0.05
    attempts=$((attempts + 1))
  done
  /usr/bin/kill -KILL -- "-$workload_pid" 2>/dev/null || true
  wait "$workload_pid" 2>/dev/null || true
}
trap 'cleanup; exit 143' TERM INT HUP
trap cleanup EXIT
wait "$workload_pid"
status=$?
trap - TERM INT HUP EXIT
exit "$status"
`;

export const databaseObservabilityReconcilerProcessEnvironment = Object.freeze({
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/local/bin:/usr/bin:/bin",
});

export interface DatabaseObservabilityReconcilerProcessRequest {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly environment: typeof databaseObservabilityReconcilerProcessEnvironment;
    readonly executable: string;
    readonly signal: AbortSignal;
}

export interface DatabaseObservabilityReconcilerProcessResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

export type DatabaseObservabilityReconcilerProcess = (
    request: DatabaseObservabilityReconcilerProcessRequest,
) => Promise<DatabaseObservabilityReconcilerProcessResult>;

const databaseCountSchema = v.pipe(
    v.number("Database observability collection lease result is invalid"),
    v.safeInteger("Database observability collection lease result is invalid"),
    v.minValue(1, "Database observability collection lease result is invalid"),
    v.maxValue(
        databaseObservabilityDatabaseMaximum,
        "Database observability collection lease result is invalid",
    ),
);
const openResultSchema = v.strictObject({
    catalogDigest: v.pipe(
        v.string("Database observability collection lease result is invalid"),
        v.regex(
            /^[0-9a-f]{64}$/u,
            "Database observability collection lease result is invalid",
        ),
    ),
    collectionLeaseToken: v.pipe(
        v.string("Database observability collection lease result is invalid"),
        v.regex(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
            "Database observability collection lease result is invalid",
        ),
    ),
    databaseCount: databaseCountSchema,
    mode: v.literal(
        openMode,
        "Database observability collection lease result is invalid",
    ),
    status: v.picklist(
        ["RECONCILED", "UNCHANGED"],
        "Database observability collection lease result is invalid",
    ),
});
const enableResultSchema = v.strictObject({
    databaseCount: databaseCountSchema,
    mode: v.literal(
        enableMode,
        "Database observability collection lease result is invalid",
    ),
    status: v.literal(
        "OPENED",
        "Database observability collection lease result is invalid",
    ),
});
const closeResultSchema = v.strictObject({
    databaseCount: v.literal(
        0,
        "Database observability collection lease result is invalid",
    ),
    mode: v.literal(
        closeMode,
        "Database observability collection lease result is invalid",
    ),
    status: v.literal(
        "CLOSED",
        "Database observability collection lease result is invalid",
    ),
});

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > processOutputMaximumBytes) {
                throw new DatabaseObservabilityCollectionLeaseError();
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

const defaultProcess: DatabaseObservabilityReconcilerProcess = async (request) => {
    const child = Bun.spawn(
        [
            processSupervisorExecutable,
            "--pdeathsig=TERM",
            processSupervisorShellExecutable,
            "-ceu",
            processSupervisorScript,
            "mira-dashboard-database-observability-supervisor",
            String(process.pid),
            request.executable,
            ...request.argv,
        ],
        {
            cwd: request.cwd,
            env: request.environment,
            stderr: "pipe",
            stdin: "ignore",
            stdout: "pipe",
        },
    );
    const abort = () => child.kill("SIGTERM");
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            readBounded(child.stdout),
            readBounded(child.stderr),
        ]);
        return { exitCode, stderr, stdout };
    } catch {
        child.kill("SIGTERM");
        await child.exited.catch(() => {});
        throw new DatabaseObservabilityCollectionLeaseError();
    } finally {
        request.signal.removeEventListener("abort", abort);
    }
};

function normalizedAbsolutePath(value: string): boolean {
    return (
        path.isAbsolute(value) &&
        !value.includes("\0") &&
        value.length <= 4096 &&
        path.resolve(value) === value
    );
}

function boundedSignal(deadlineMs: number, signal?: AbortSignal): AbortSignal {
    const deadline = AbortSignal.timeout(deadlineMs);
    return signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
}

function parseExactResult<T>(
    result: DatabaseObservabilityReconcilerProcessResult,
    schema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>,
): T {
    if (
        result.exitCode !== 0 ||
        result.stderr.byteLength !== 0 ||
        result.stdout.byteLength === 0 ||
        result.stdout.byteLength > processOutputMaximumBytes
    ) {
        throw new DatabaseObservabilityCollectionLeaseError();
    }
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
        if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
            throw new DatabaseObservabilityCollectionLeaseError();
        }
        return v.parse(schema, JSON.parse(text.slice(0, -1)));
    } catch {
        throw new DatabaseObservabilityCollectionLeaseError();
    }
}

/**
 * Creates the fixed worker adapter for one short approval-bound collection lease.
 * Close uses an independent deadline, so cancellation cannot strand observer LOGIN.
 * @param options Immutable release/runtime paths and injectable process boundary.
 * @returns A worker-only collection lease adapter with mandatory cleanup.
 */
export function createFixedDatabaseObservabilityReconciler(options: {
    readonly bunExecutable: string;
    readonly process?: DatabaseObservabilityReconcilerProcess;
    readonly releaseRoot: string;
}): DatabaseObservabilityReconciliationPort {
    const { bunExecutable, releaseRoot } = options;
    const runnerPath = path.join(releaseRoot, runnerRelativePath);
    if (
        !normalizedAbsolutePath(bunExecutable) ||
        !normalizedAbsolutePath(releaseRoot) ||
        !normalizedAbsolutePath(runnerPath) ||
        !runnerPath.startsWith(`${releaseRoot}${path.sep}`)
    ) {
        throw new TypeError("Database observability reconciler paths are invalid");
    }
    const execute = options.process ?? defaultProcess;
    const run = async (
        mode: typeof closeMode | typeof enableMode | typeof openMode,
        signal: AbortSignal,
        additionalArguments: readonly string[] = [],
    ): Promise<DatabaseObservabilityReconcilerProcessResult> => {
        try {
            return await execute({
                argv: Object.freeze([
                    runnerPath,
                    mode,
                    "--approved",
                    ...additionalArguments,
                ]),
                cwd: releaseRoot,
                environment: databaseObservabilityReconcilerProcessEnvironment,
                executable: bunExecutable,
                signal,
            });
        } catch {
            throw new DatabaseObservabilityCollectionLeaseError();
        }
    };
    return Object.freeze({
        async withApprovedCollection<T>(
            operation: (
                reconciliationStatus: DatabaseObservabilityReconciliationStatus,
                signal: AbortSignal,
            ) => Promise<T>,
            signal?: AbortSignal,
        ): Promise<DatabaseObservabilityApprovedCollectionResult<T>> {
            const collectionSignal = signal ?? new AbortController().signal;
            let reconciliationStatus: DatabaseObservabilityReconciliationStatus =
                "unavailable";
            let value: T | undefined;
            let completed = false;
            try {
                const opened = parseExactResult(
                    await run(openMode, boundedSignal(openDeadlineMs, signal)),
                    openResultSchema,
                );
                const enabled = parseExactResult(
                    await run(enableMode, boundedSignal(closeDeadlineMs, signal), [
                        "--collection-lease-token",
                        opened.collectionLeaseToken,
                        "--catalog-digest",
                        opened.catalogDigest,
                    ]),
                    enableResultSchema,
                );
                if (enabled.databaseCount !== opened.databaseCount) {
                    throw new DatabaseObservabilityCollectionLeaseError();
                }
                reconciliationStatus =
                    opened.status === "UNCHANGED" ? "unchanged" : "reconciled";
                value = await operation(reconciliationStatus, collectionSignal);
                completed = true;
            } finally {
                parseExactResult(
                    await run(closeMode, boundedSignal(closeDeadlineMs)),
                    closeResultSchema,
                );
            }
            if (!completed) {
                throw new DatabaseObservabilityCollectionLeaseError();
            }
            return Object.freeze({ reconciliationStatus, value });
        },
    });
}

export const databaseObservabilityReconciliationDeadlines = Object.freeze({
    closeMs: closeDeadlineMs,
    openMs: openDeadlineMs,
});
