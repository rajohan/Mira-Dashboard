import os from "node:os";
import path from "node:path";

import {
    terminalClientMessageMaximumBytes,
    terminalColumnsMaximum,
    terminalColumnsMinimum,
    type TerminalDimensions,
    terminalRowsMaximum,
    terminalRowsMinimum,
    terminalServerMessageMaximumBytes,
    terminalSessionMaximumDurationMs,
    terminalSocketBufferedMaximumBytes,
} from "../../contracts/terminal.ts";
import { hasNoUnicodeControlOrFormat } from "../../shared/validation.ts";

const systemdRunExecutable = "/usr/bin/systemd-run";
const systemctlExecutable = "/usr/bin/systemctl";
const envExecutable = "/usr/bin/env";
const shellExecutable = "/bin/bash";
const terminalName = "xterm-256color";
const terminalMemoryMaximumBytes = 512 * 1024 * 1024;
const terminalTasksMaximum = 128;
const terminalCpuQuotaPercent = 200;
const systemctlTimeoutMs = 2000;
const fixedPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const sessionIdentifierPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const ptyForceKillDelayMs = 3000;
export const ptyInputMaximumBytes = terminalClientMessageMaximumBytes;
/** Ephemeral input accepted behind Bun.Terminal backpressure; never logged or persisted. */
export const ptyPendingInputMaximumBytes = terminalSocketBufferedMaximumBytes;
/** Caps FIFO metadata even when queued browser frames contain only one byte. */
export const ptyPendingInputMaximumFrames =
    terminalSocketBufferedMaximumBytes / terminalClientMessageMaximumBytes;
export const ptyOutputCallbackMaximumBytes = terminalServerMessageMaximumBytes;

export type PtyOutputDisposition = "accepted" | "backpressured";
export type PtyProcessSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

export interface PtyProcessCallbacks {
    readonly onInputDrain?: () => void;
    readonly onOutput: (data: Uint8Array) => PtyOutputDisposition;
    readonly onOutputBackpressure?: () => void;
}

export interface PtyProcessRequest {
    readonly callbacks: PtyProcessCallbacks;
    readonly dimensions: TerminalDimensions;
    /** A canonical absolute path already realpath-fenced by the reviewed root registry. */
    readonly realpathFencedWorkingDirectory: string;
    readonly sessionId: string;
}

export interface PtyProcessExit {
    readonly exitCode: number;
    readonly signalCode: NodeJS.Signals | null;
}

export type PtyInputWriteResult =
    | Readonly<{ acceptedBytes: number; status: "accepted" }>
    | Readonly<{ acceptedBytes: number; status: "backpressured" }>
    | Readonly<{ acceptedBytes: 0; status: "closed" }>;

export interface PtyProcessHandle {
    readonly exited: Promise<PtyProcessExit>;
    readonly outputBackpressured: boolean;
    resize(dimensions: TerminalDimensions): void;
    sendSignal(signal: PtyProcessSignal): Promise<"closed" | "sent">;
    terminate(): Promise<PtyProcessExit>;
    writeInput(data: Uint8Array): PtyInputWriteResult;
}

export interface PtyTerminalFactoryOptions {
    readonly columns: number;
    readonly onData: (data: Uint8Array) => void;
    readonly onDrain: () => void;
    readonly onExit: (status: number) => void;
    readonly rows: number;
}

export interface PtyTerminalHandle {
    readonly closed: boolean;
    close(): void;
    resize(columns: number, rows: number): void;
    write(data: Uint8Array): number;
}

export interface PtySubprocessHandle {
    readonly exited: Promise<number>;
    readonly signalCode: NodeJS.Signals | null;
}

export interface PtySpawnOptions {
    readonly environment: Readonly<Record<string, string>>;
    readonly terminal: PtyTerminalHandle;
}

export type PtyTerminalFactory = (
    options: PtyTerminalFactoryOptions
) => PtyTerminalHandle;

export type PtyProcessSpawner = (
    argv: readonly string[],
    options: PtySpawnOptions
) => PtySubprocessHandle;

export type PtySystemctlRunner = (
    argv: readonly string[],
    environment: Readonly<Record<string, string>>
) => Promise<number>;

export interface PtyRuntimeUser {
    readonly homeDirectory: string;
    readonly userId: number;
    readonly userName: string;
}

export interface PtyProcessDependencies {
    readonly createTerminal?: PtyTerminalFactory;
    readonly delay?: (delayMs: number) => Promise<void>;
    readonly runtimeUser?: PtyRuntimeUser;
    readonly spawn?: PtyProcessSpawner;
    readonly systemctl?: PtySystemctlRunner;
}

export interface PtyProcessLaunchSpecification {
    readonly argv: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly unitName: string;
}

export class PtyProcessError extends Error {
    public readonly reason:
        | "invalid-input"
        | "invalid-request"
        | "process-failed"
        | "spawn-failed"
        | "systemctl-failed";

    public constructor(reason: PtyProcessError["reason"]) {
        super("PTY process operation failed");
        this.name = "PtyProcessError";
        this.reason = reason;
    }
}

function defaultRuntimeUser(): PtyRuntimeUser {
    const user = os.userInfo();
    return Object.freeze({
        homeDirectory: user.homedir,
        userId: user.uid,
        userName: user.username,
    });
}

function isSafeEnvironmentValue(value: string): boolean {
    return value.length > 0 && value.length <= 4096 && hasNoUnicodeControlOrFormat(value);
}

function validateRuntimeUser(user: PtyRuntimeUser): void {
    if (
        !path.isAbsolute(user.homeDirectory) ||
        path.normalize(user.homeDirectory) !== user.homeDirectory ||
        !isSafeEnvironmentValue(user.homeDirectory) ||
        !Number.isSafeInteger(user.userId) ||
        user.userId < 0 ||
        user.userName.length > 64 ||
        !isSafeEnvironmentValue(user.userName)
    ) {
        throw new PtyProcessError("invalid-request");
    }
}

function validateDimensions(dimensions: TerminalDimensions): void {
    if (
        !Number.isSafeInteger(dimensions.columns) ||
        dimensions.columns < terminalColumnsMinimum ||
        dimensions.columns > terminalColumnsMaximum ||
        !Number.isSafeInteger(dimensions.rows) ||
        dimensions.rows < terminalRowsMinimum ||
        dimensions.rows > terminalRowsMaximum
    ) {
        throw new PtyProcessError("invalid-request");
    }
}

function validateSignal(signal: PtyProcessSignal): void {
    if (signal !== "SIGHUP" && signal !== "SIGINT" && signal !== "SIGTERM") {
        throw new PtyProcessError("invalid-input");
    }
}

function validateRequest(request: PtyProcessRequest): void {
    validateDimensions(request.dimensions);
    if (
        !sessionIdentifierPattern.test(request.sessionId) ||
        !path.isAbsolute(request.realpathFencedWorkingDirectory) ||
        path.normalize(request.realpathFencedWorkingDirectory) !==
            request.realpathFencedWorkingDirectory ||
        !hasNoUnicodeControlOrFormat(request.realpathFencedWorkingDirectory)
    ) {
        throw new PtyProcessError("invalid-request");
    }
}

function launcherEnvironment(user: PtyRuntimeUser): Readonly<Record<string, string>> {
    const runtimeDirectory = `/run/user/${user.userId}`;
    const environment: Record<string, string> = {
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDirectory}/bus`,
        HOME: user.homeDirectory,
        LANG: "C.UTF-8",
        LOGNAME: user.userName,
        PATH: fixedPath,
        SHELL: shellExecutable,
        TERM: terminalName,
        USER: user.userName,
        XDG_RUNTIME_DIR: runtimeDirectory,
    };
    return Object.freeze(environment);
}

function serviceEnvironmentArguments(user: PtyRuntimeUser): readonly string[] {
    return Object.freeze([
        `HOME=${user.homeDirectory}`,
        "LANG=C.UTF-8",
        "LC_ALL=C.UTF-8",
        `LOGNAME=${user.userName}`,
        `PATH=${fixedPath}`,
        String.raw`PS1=\[\e[32m\]\u@\h\[\e[34m\]:\w\[\e[0m\]\$ `,
        `SHELL=${shellExecutable}`,
        `TERM=${terminalName}`,
        `USER=${user.userName}`,
    ]);
}

/**
 * Builds the exact argv-only transient-service specification used for a PTY.
 * @returns An immutable command, fixed launcher environment, and exact unit name.
 */
export function buildPtyProcessLaunchSpecification(
    request: PtyProcessRequest,
    options: Pick<PtyProcessDependencies, "runtimeUser"> = {}
): PtyProcessLaunchSpecification {
    validateRequest(request);
    const runtimeUser = options.runtimeUser ?? defaultRuntimeUser();
    validateRuntimeUser(runtimeUser);
    const environment = launcherEnvironment(runtimeUser);
    const unitName = `mira-dashboard-terminal-${request.sessionId}.service`;
    const runtimeMaximumSeconds = Math.ceil(terminalSessionMaximumDurationMs / 1000);
    const argv = Object.freeze([
        systemdRunExecutable,
        "--user",
        "--collect",
        "--wait",
        "--pty",
        "--quiet",
        "--send-sighup",
        `--unit=${unitName}`,
        `--working-directory=${request.realpathFencedWorkingDirectory}`,
        "--property=Type=exec",
        "--property=KillMode=mixed",
        `--property=RuntimeMaxSec=${runtimeMaximumSeconds}s`,
        `--property=MemoryMax=${terminalMemoryMaximumBytes}`,
        `--property=TasksMax=${terminalTasksMaximum}`,
        `--property=CPUQuota=${terminalCpuQuotaPercent}%`,
        envExecutable,
        "-i",
        ...serviceEnvironmentArguments(runtimeUser),
        shellExecutable,
        "--noprofile",
        "--norc",
        "-i",
    ]);
    return Object.freeze({ argv, environment, unitName });
}

function defaultCreateTerminal(options: PtyTerminalFactoryOptions): PtyTerminalHandle {
    return new Bun.Terminal({
        cols: options.columns,
        data: (_terminal, data) => options.onData(data),
        drain: () => options.onDrain(),
        exit: (_terminal, status) => options.onExit(status),
        name: terminalName,
        rows: options.rows,
    });
}

function defaultSpawn(
    argv: readonly string[],
    options: PtySpawnOptions
): PtySubprocessHandle {
    return Bun.spawn([...argv], {
        env: { ...options.environment },
        terminal: options.terminal as Bun.Terminal,
    });
}

async function defaultSystemctl(
    argv: readonly string[],
    environment: Readonly<Record<string, string>>
): Promise<number> {
    const child = Bun.spawn([...argv], {
        env: { ...environment },
        killSignal: "SIGKILL",
        stderr: "ignore",
        stdin: "ignore",
        stdout: "ignore",
        timeout: systemctlTimeoutMs,
    });
    return child.exited;
}

function defaultDelay(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function systemctlSignalName(signal: PtyProcessSignal | "SIGKILL"): string {
    return signal.slice(3);
}

function systemctlSignalCommand(
    unitName: string,
    signal: PtyProcessSignal | "SIGKILL"
): readonly string[] {
    return Object.freeze([
        systemctlExecutable,
        "--user",
        "--no-ask-password",
        "--no-pager",
        "kill",
        "--kill-whom=all",
        `--signal=${systemctlSignalName(signal)}`,
        unitName,
    ]);
}

function closeTerminal(terminal: PtyTerminalHandle): void {
    if (terminal.closed) return;
    try {
        terminal.close();
    } catch {
        // The subprocess exit remains authoritative even if PTY cleanup is already done.
    }
}

/**
 * Spawns one interactive shell in a fixed, resource-bounded transient user service.
 * Terminal bytes remain raw and ephemeral; callers must synchronously reject output
 * when their own bounded transport cannot accept another fragment.
 * @returns A full-duplex PTY handle whose exit promise is backed only by proc.exited.
 */
export function createPtyProcess(
    request: PtyProcessRequest,
    dependencies: PtyProcessDependencies = {}
): PtyProcessHandle {
    const specification = buildPtyProcessLaunchSpecification(request, dependencies);
    const createTerminal = dependencies.createTerminal ?? defaultCreateTerminal;
    const delay = dependencies.delay ?? defaultDelay;
    const spawn = dependencies.spawn ?? defaultSpawn;
    const systemctl = dependencies.systemctl ?? defaultSystemctl;
    let outputBackpressured = false;
    let hasExited = false;
    let terminationPromise: Promise<PtyProcessExit> | undefined;
    let terminationRequestedBeforeSpawn = false;
    let terminal: PtyTerminalHandle | undefined;
    const pendingInput: Array<{ data: Uint8Array; offset: number }> = [];
    let pendingInputBytes = 0;
    let beginTermination = (): void => {
        terminationRequestedBeforeSpawn = true;
    };

    const clearPendingInput = (): void => {
        pendingInput.length = 0;
        pendingInputBytes = 0;
    };
    const requestTermination = (): void => {
        clearPendingInput();
        beginTermination();
    };
    const bufferInput = (data: Uint8Array, offset: number): boolean => {
        const remainderBytes = data.byteLength - offset;
        if (
            remainderBytes < 1 ||
            pendingInput.length >= ptyPendingInputMaximumFrames ||
            pendingInputBytes + remainderBytes > ptyPendingInputMaximumBytes
        ) {
            return false;
        }
        pendingInput.push({ data: data.slice(offset), offset: 0 });
        pendingInputBytes += remainderBytes;
        return true;
    };
    const flushPendingInput = (): "drained" | "failed" | "pending" => {
        const currentTerminal = terminal;
        if (
            currentTerminal === undefined ||
            currentTerminal.closed ||
            hasExited ||
            terminationPromise !== undefined
        ) {
            requestTermination();
            return "failed";
        }
        while (pendingInput.length > 0) {
            const current = pendingInput[0];
            if (current === undefined) break;
            const remaining = current.data.subarray(current.offset);
            let acceptedBytes: number;
            try {
                acceptedBytes = currentTerminal.write(remaining);
            } catch {
                requestTermination();
                return "failed";
            }
            if (
                !Number.isSafeInteger(acceptedBytes) ||
                acceptedBytes < 0 ||
                acceptedBytes > remaining.byteLength
            ) {
                requestTermination();
                return "failed";
            }
            if (acceptedBytes === 0) return "pending";
            current.offset += acceptedBytes;
            pendingInputBytes -= acceptedBytes;
            if (current.offset === current.data.byteLength) pendingInput.shift();
            if (acceptedBytes < remaining.byteLength) return "pending";
        }
        return "drained";
    };
    const terminalOptions = {
        columns: request.dimensions.columns,
        onData(data) {
            if (outputBackpressured) return;
            for (
                let offset = 0;
                offset < data.byteLength;
                offset += ptyOutputCallbackMaximumBytes
            ) {
                const fragment = data.slice(
                    offset,
                    Math.min(offset + ptyOutputCallbackMaximumBytes, data.byteLength)
                );
                let disposition: PtyOutputDisposition;
                try {
                    disposition = request.callbacks.onOutput(fragment);
                } catch {
                    disposition = "backpressured";
                }
                if (disposition === "accepted") continue;
                outputBackpressured = true;
                try {
                    request.callbacks.onOutputBackpressure?.();
                } catch {
                    // The transport is already rejected; callback failures stay content-free.
                }
                requestTermination();
                break;
            }
        },
        onDrain() {
            const disposition = flushPendingInput();
            if (disposition !== "drained") return;
            try {
                request.callbacks.onInputDrain?.();
            } catch {
                requestTermination();
            }
        },
        onExit(status) {
            if (status !== 0) requestTermination();
        },
        rows: request.dimensions.rows,
    } satisfies PtyTerminalFactoryOptions;
    try {
        terminal = createTerminal(terminalOptions);
    } catch {
        throw new PtyProcessError("spawn-failed");
    }
    if (terminal === undefined) throw new PtyProcessError("spawn-failed");

    let subprocess: PtySubprocessHandle;
    try {
        subprocess = spawn(specification.argv, {
            environment: specification.environment,
            terminal,
        });
    } catch {
        closeTerminal(terminal);
        throw new PtyProcessError("spawn-failed");
    }

    const exited = subprocess.exited.then(
        (exitCode): PtyProcessExit => {
            hasExited = true;
            clearPendingInput();
            closeTerminal(terminal);
            return Object.freeze({
                exitCode,
                signalCode: subprocess.signalCode,
            });
        },
        () => {
            hasExited = true;
            clearPendingInput();
            closeTerminal(terminal);
            throw new PtyProcessError("process-failed");
        }
    );

    const runSignal = async (signal: PtyProcessSignal | "SIGKILL"): Promise<void> => {
        const exitCode = await systemctl(
            systemctlSignalCommand(specification.unitName, signal),
            specification.environment
        );
        if (exitCode !== 0) throw new PtyProcessError("systemctl-failed");
    };

    const terminate = (): Promise<PtyProcessExit> => {
        clearPendingInput();
        if (hasExited) return exited;
        terminationPromise ??= (async () => {
            try {
                await runSignal("SIGTERM");
            } catch {
                // Escalation still runs against the exact unit after the grace window.
            }
            const exitedDuringGrace = await Promise.race([
                exited.then(
                    () => true,
                    () => true
                ),
                delay(ptyForceKillDelayMs).then(() => false),
            ]);
            if (!exitedDuringGrace) {
                try {
                    await runSignal("SIGKILL");
                } catch {
                    // proc.exited remains the only process-exit authority.
                }
            }
            return exited;
        })();
        return terminationPromise;
    };
    beginTermination = () => {
        void terminate().catch(() => {});
    };
    if (terminationRequestedBeforeSpawn) beginTermination();

    const handle: PtyProcessHandle = {
        exited,
        get outputBackpressured() {
            return outputBackpressured;
        },
        resize(dimensions: TerminalDimensions) {
            validateDimensions(dimensions);
            if (hasExited || terminal.closed) {
                throw new PtyProcessError("process-failed");
            }
            try {
                terminal.resize(dimensions.columns, dimensions.rows);
            } catch {
                requestTermination();
                throw new PtyProcessError("process-failed");
            }
        },
        async sendSignal(signal: PtyProcessSignal) {
            validateSignal(signal);
            if (hasExited) return "closed";
            await runSignal(signal);
            return "sent";
        },
        terminate,
        writeInput(data: Uint8Array) {
            if (
                !(data instanceof Uint8Array) ||
                data.byteLength === 0 ||
                data.byteLength > ptyInputMaximumBytes
            ) {
                requestTermination();
                throw new PtyProcessError("invalid-input");
            }
            if (hasExited || terminal.closed || terminationPromise !== undefined) {
                requestTermination();
                return Object.freeze({ acceptedBytes: 0, status: "closed" });
            }
            if (pendingInputBytes > 0) {
                if (!bufferInput(data, 0)) {
                    requestTermination();
                    return Object.freeze({ acceptedBytes: 0, status: "closed" });
                }
                return Object.freeze({
                    acceptedBytes: data.byteLength,
                    status: "backpressured",
                });
            }
            let acceptedBytes: number;
            try {
                acceptedBytes = terminal.write(data);
            } catch {
                requestTermination();
                return Object.freeze({ acceptedBytes: 0, status: "closed" });
            }
            if (
                !Number.isSafeInteger(acceptedBytes) ||
                acceptedBytes < 0 ||
                acceptedBytes > data.byteLength
            ) {
                requestTermination();
                return Object.freeze({ acceptedBytes: 0, status: "closed" });
            }
            if (acceptedBytes < data.byteLength) {
                if (!bufferInput(data, acceptedBytes)) {
                    requestTermination();
                    return Object.freeze({ acceptedBytes: 0, status: "closed" });
                }
                return Object.freeze({
                    acceptedBytes: data.byteLength,
                    status: "backpressured",
                });
            }
            return Object.freeze({
                acceptedBytes: data.byteLength,
                status: "accepted",
            });
        },
    };
    return Object.freeze(handle);
}
