import type { LogMaintenancePolicyId } from "../../contracts/logs.ts";
import { fixedSystemLogrotateUnits as sharedSystemLogrotateUnits } from "../../shared/logMaintenanceUnits.ts";

export type HostLogrotatePolicyId = Exclude<LogMaintenancePolicyId, "docker-managed">;

export { fixedSystemLogrotateUnits } from "../../shared/logMaintenanceUnits.ts";
const reviewedSystemLogrotateUnits: Readonly<Record<HostLogrotatePolicyId, string>> =
    sharedSystemLogrotateUnits;

const systemctlDefault = "/usr/bin/systemctl";
const processDeadlineMs = 5 * 60_000;
const processOutputMaximumBytes = 64 * 1024;

export interface FixedSystemLogrotateProcessResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

export type FixedSystemLogrotateProcess = (
    executable: string,
    arguments_: readonly string[],
    signal: AbortSignal
) => Promise<FixedSystemLogrotateProcessResult>;

export interface FixedSystemLogrotateBroker {
    readonly availablePolicies: (
        signal?: AbortSignal
    ) => Promise<readonly HostLogrotatePolicyId[]>;
    readonly run: (
        policyId: HostLogrotatePolicyId,
        signal?: AbortSignal
    ) => Promise<void>;
}

function brokerFailure(): Error {
    return new Error("Fixed system logrotate broker failed");
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

const defaultProcess: FixedSystemLogrotateProcess = async (
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

function operationSignal(signal: AbortSignal | undefined): AbortSignal {
    const deadline = AbortSignal.timeout(processDeadlineMs);
    return signal === undefined ? deadline : AbortSignal.any([deadline, signal]);
}

function requireBoundedSuccess(result: FixedSystemLogrotateProcessResult): void {
    if (
        result.exitCode !== 0 ||
        result.stdout.byteLength > processOutputMaximumBytes ||
        result.stderr.byteLength > processOutputMaximumBytes
    ) {
        throw brokerFailure();
    }
}

/**
 * Worker-only client for four exact root-owned Ubuntu logrotate policies.
 * @param options Replaceable process boundary and fixed executable for tests/composition.
 * @returns A broker that never accepts paths or arbitrary systemd units.
 */
export function createFixedSystemLogrotateBroker(
    options: {
        readonly process?: FixedSystemLogrotateProcess;
        readonly systemctlExecutable?: string;
    } = {}
): FixedSystemLogrotateBroker {
    const execute = options.process ?? defaultProcess;
    const executable = options.systemctlExecutable ?? systemctlDefault;
    if (
        !executable.startsWith("/") ||
        executable.includes("\0") ||
        executable.length > 4096
    ) {
        throw brokerFailure();
    }

    const broker: FixedSystemLogrotateBroker = {
        async availablePolicies(signal?: AbortSignal) {
            const available: HostLogrotatePolicyId[] = [];
            for (const [policyId, unit] of Object.entries(
                reviewedSystemLogrotateUnits
            ) as [HostLogrotatePolicyId, string][]) {
                try {
                    const result = await execute(
                        executable,
                        ["show", "--property=LoadState", "--value", unit],
                        operationSignal(signal)
                    );
                    requireBoundedSuccess(result);
                    if (new TextDecoder().decode(result.stdout).trim() === "loaded") {
                        available.push(policyId);
                    }
                } catch {
                    // Availability is an allowlisted projection, never raw systemd diagnostics.
                }
            }
            return available;
        },
        async run(policyId: HostLogrotatePolicyId, signal?: AbortSignal) {
            const unit = reviewedSystemLogrotateUnits[policyId];
            if (unit === undefined) throw brokerFailure();
            try {
                const result = await execute(
                    executable,
                    ["start", "--wait", unit],
                    operationSignal(signal)
                );
                requireBoundedSuccess(result);
            } catch {
                throw brokerFailure();
            }
        },
    };
    return Object.freeze(broker);
}
