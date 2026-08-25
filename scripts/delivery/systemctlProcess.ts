import { secondsToMilliseconds } from "date-fns";

const maximumSystemctlOutputBytes = 64 * 1024;
const systemctlDeadlineMs = secondsToMilliseconds(30);
const maximumSystemctlDeadlineMs = secondsToMilliseconds(120 * 60);

/** Bounded systemctl result retained only for exit-status validation. */
export interface SystemctlProcessResult {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

/** Injectable systemctl process boundary used by delivery tests. */
export type SystemctlExecutor = (
    executable: string,
    arguments_: readonly string[],
    options?: Readonly<{ deadlineMs?: number }>
) => Promise<SystemctlProcessResult>;

function systemctlProcessFailure(): Error {
    return new Error("Systemctl process failed");
}

async function readBoundedStream(
    stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            total += result.value.byteLength;
            if (total > maximumSystemctlOutputBytes) {
                throw systemctlProcessFailure();
            }
            chunks.push(result.value);
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

function systemctlEnvironment(): Record<string, string> {
    const environment: Record<string, string> = { PATH: "/usr/bin:/bin" };
    for (const name of ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"] as const) {
        const value = process.env[name];
        if (value !== undefined) environment[name] = value;
    }
    return environment;
}

/**
 * Executes one bounded non-interactive systemctl command.
 * @param executable Absolute systemctl executable.
 * @param arguments_ Exact caller-owned argument vector.
 * @param options Optional code-owned deadline override for long-running units.
 * @returns Bounded stdout, stderr, and exit code.
 */
export async function executeSystemctlProcess(
    executable: string,
    arguments_: readonly string[],
    options: Readonly<{ deadlineMs?: number }> = {}
): Promise<SystemctlProcessResult> {
    const deadlineMs = options.deadlineMs ?? systemctlDeadlineMs;
    if (
        !executable.startsWith("/") ||
        executable.includes("\0") ||
        executable.length > 4096 ||
        !Number.isSafeInteger(deadlineMs) ||
        deadlineMs < 1 ||
        deadlineMs > maximumSystemctlDeadlineMs
    ) {
        throw systemctlProcessFailure();
    }
    const child = Bun.spawn([executable, ...arguments_], {
        env: systemctlEnvironment(),
        signal: AbortSignal.timeout(deadlineMs),
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            readBoundedStream(child.stdout),
            readBoundedStream(child.stderr),
        ]);
        return Object.freeze({ exitCode, stderr, stdout });
    } catch {
        child.kill();
        await child.exited.catch(() => null);
        throw systemctlProcessFailure();
    }
}

/**
 * Requires an exact successful, bounded systemctl result.
 * @param execute Injectable bounded process executor.
 * @param executable Absolute systemctl executable.
 * @param arguments_ Exact systemctl argument vector.
 * @param options Optional code-owned deadline override for long-running units.
 */
export async function requireSuccessfulSystemctlProcess(
    execute: SystemctlExecutor,
    executable: string,
    arguments_: readonly string[],
    options: Readonly<{ deadlineMs?: number }> = {}
): Promise<void> {
    try {
        const result = await execute(executable, arguments_, options);
        if (
            result.exitCode !== 0 ||
            result.stdout.byteLength > maximumSystemctlOutputBytes ||
            result.stderr.byteLength > maximumSystemctlOutputBytes
        ) {
            throw systemctlProcessFailure();
        }
    } catch {
        throw systemctlProcessFailure();
    }
}

/**
 * Reads one bounded systemd property through an exact caller-owned unit/property pair.
 * @param execute Injectable bounded process executor.
 * @param executable Absolute systemctl executable.
 * @param unit Exact systemd unit name.
 * @param property Exact systemd property name.
 * @returns Fatal-UTF-8 decoded and trimmed property value.
 */
export async function readSystemctlProperty(
    execute: SystemctlExecutor,
    executable: string,
    unit: string,
    property: string
): Promise<string> {
    try {
        const result = await execute(executable, [
            "show",
            `--property=${property}`,
            "--value",
            unit,
        ]);
        if (
            result.exitCode !== 0 ||
            result.stdout.byteLength > maximumSystemctlOutputBytes ||
            result.stderr.byteLength !== 0
        ) {
            throw systemctlProcessFailure();
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout).trim();
    } catch {
        throw systemctlProcessFailure();
    }
}
