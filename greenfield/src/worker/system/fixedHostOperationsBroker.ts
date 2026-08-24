import {
    fixedHostOperationUnits,
    type HostOperationId,
} from "../../shared/hostOperations.ts";

const systemctlDefault = "/usr/bin/systemctl";
const availabilityDeadlineDefaultMs = 5000;
const restartDeadlineDefaultMs = 60_000;
const cleanupDeadlineDefaultMs = 35 * 60_000;
const updateDeadlineDefaultMs = 2 * 60 * 60_000;
const processOutputMaximumBytes = 64 * 1024;

export interface FixedHostOperationProcessResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

export type FixedHostOperationProcess = (
    executable: string,
    arguments_: readonly string[],
    signal: AbortSignal
) => Promise<FixedHostOperationProcessResult>;

export type FixedHostOperationResult =
    | Readonly<{ status: "accepted" }>
    | Readonly<{ status: "completed" }>;

export interface FixedHostOperationsBroker {
    readonly availableOperations: (
        signal?: AbortSignal
    ) => Promise<readonly HostOperationId[]>;
    readonly request: (
        operationId: HostOperationId,
        signal?: AbortSignal
    ) => Promise<FixedHostOperationResult>;
}

function brokerFailure(): Error {
    return new Error("Fixed host operations broker failed");
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
            if (total > processOutputMaximumBytes) throw brokerFailure();
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

const defaultProcess: FixedHostOperationProcess = async (
    executable,
    arguments_,
    signal
) => {
    const child = Bun.spawn([executable, ...arguments_], {
        env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
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
        return { exitCode, stderr, stdout };
    } catch {
        child.kill();
        await child.exited.catch(() => {});
        throw brokerFailure();
    }
};

function operationSignal(
    signal: AbortSignal | undefined,
    deadlineMs: number
): AbortSignal {
    const deadline = AbortSignal.timeout(deadlineMs);
    return signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
}

function requireBoundedSuccess(result: FixedHostOperationProcessResult): void {
    if (
        result.exitCode !== 0 ||
        result.stdout.byteLength > processOutputMaximumBytes ||
        result.stderr.byteLength > processOutputMaximumBytes
    ) {
        throw brokerFailure();
    }
}

function validAbsoluteExecutable(executable: string): boolean {
    return (
        executable.startsWith("/") &&
        !executable.includes("\0") &&
        executable.length <= 4096
    );
}

/**
 * Creates the worker-only client for three exact root-owned host operations.
 * No path, command, systemd unit, environment value, or process output crosses this port.
 * @param options Replaceable process boundary and bounded deadlines for tests/composition.
 * @returns Frozen broker over the reviewed fixed operation inventory.
 */
export function createFixedHostOperationsBroker(
    options: {
        readonly availabilityDeadlineMs?: number;
        readonly cleanupDeadlineMs?: number;
        readonly process?: FixedHostOperationProcess;
        readonly restartDeadlineMs?: number;
        readonly systemctlExecutable?: string;
        readonly updateDeadlineMs?: number;
    } = {}
): FixedHostOperationsBroker {
    const execute = options.process ?? defaultProcess;
    const executable = options.systemctlExecutable ?? systemctlDefault;
    const availabilityDeadlineMs =
        options.availabilityDeadlineMs ?? availabilityDeadlineDefaultMs;
    const cleanupDeadlineMs = options.cleanupDeadlineMs ?? cleanupDeadlineDefaultMs;
    const restartDeadlineMs = options.restartDeadlineMs ?? restartDeadlineDefaultMs;
    const updateDeadlineMs = options.updateDeadlineMs ?? updateDeadlineDefaultMs;
    if (
        !validAbsoluteExecutable(executable) ||
        !Number.isSafeInteger(availabilityDeadlineMs) ||
        availabilityDeadlineMs < 1 ||
        availabilityDeadlineMs > availabilityDeadlineDefaultMs ||
        !Number.isSafeInteger(cleanupDeadlineMs) ||
        cleanupDeadlineMs < 1 ||
        cleanupDeadlineMs > cleanupDeadlineDefaultMs ||
        !Number.isSafeInteger(restartDeadlineMs) ||
        restartDeadlineMs < 1 ||
        restartDeadlineMs > restartDeadlineDefaultMs ||
        !Number.isSafeInteger(updateDeadlineMs) ||
        updateDeadlineMs < 1 ||
        updateDeadlineMs > updateDeadlineDefaultMs
    ) {
        throw brokerFailure();
    }

    const broker: FixedHostOperationsBroker = {
        async availableOperations(signal?: AbortSignal) {
            const available: HostOperationId[] = [];
            for (const operationId of Object.keys(
                fixedHostOperationUnits
            ) as HostOperationId[]) {
                const unit = fixedHostOperationUnits[operationId];
                try {
                    const result = await execute(
                        executable,
                        ["show", "--property=LoadState", "--value", unit],
                        operationSignal(signal, availabilityDeadlineMs)
                    );
                    requireBoundedSuccess(result);
                    if (new TextDecoder().decode(result.stdout).trim() === "loaded") {
                        available.push(operationId);
                    }
                } catch {
                    // Availability is a fixed projection; raw systemd diagnostics stay local.
                }
            }
            return Object.freeze(available);
        },
        async request(operationId: HostOperationId, signal?: AbortSignal) {
            const unit = fixedHostOperationUnits[operationId];
            if (unit === undefined) throw brokerFailure();
            const isRestart = operationId === "system-restart";
            let deadlineMs = updateDeadlineMs;
            if (operationId === "system-cleanup") {
                deadlineMs = cleanupDeadlineMs;
            } else if (isRestart) {
                deadlineMs = restartDeadlineMs;
            }
            try {
                const result = await execute(
                    executable,
                    ["start", isRestart ? "--no-block" : "--wait", unit],
                    operationSignal(signal, deadlineMs)
                );
                requireBoundedSuccess(result);
                return Object.freeze({
                    status: isRestart ? "accepted" : "completed",
                });
            } catch {
                throw brokerFailure();
            }
        },
    };
    return Object.freeze(broker);
}
