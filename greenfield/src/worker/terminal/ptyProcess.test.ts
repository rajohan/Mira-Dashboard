import { describe, expect, test } from "bun:test";

import {
    buildPtyProcessLaunchSpecification,
    createPtyProcess,
    ptyForceKillDelayMs,
    ptyInputMaximumBytes,
    ptyPendingInputMaximumBytes,
    ptyPendingInputMaximumFrames,
    ptyOutputCallbackMaximumBytes,
    PtyProcessError,
    type PtyProcessCallbacks,
    type PtyProcessHandle,
    type PtyProcessRequest,
    type PtySpawnOptions,
    type PtySubprocessHandle,
    type PtyTerminalFactoryOptions,
    type PtyTerminalHandle,
} from "./ptyProcess.ts";

const sessionId = "019fe7a8-03fe-7000-8ea2-874b1ea1b40e";
const workingDirectory = "/home/ubuntu/projects/mira-dashboard";

interface Deferred<T> {
    readonly promise: Promise<T>;
    readonly reject: (error: unknown) => void;
    readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let rejectPromise: ((error: unknown) => void) | undefined;
    let resolvePromise: ((value: T) => void) | undefined;
    const promise = new Promise<T>((resolve, reject) => {
        rejectPromise = reject;
        resolvePromise = resolve;
    });
    return {
        promise,
        reject(error) {
            rejectPromise?.(error);
        },
        resolve(value) {
            resolvePromise?.(value);
        },
    };
}

class FakeTerminal implements PtyTerminalHandle {
    public readonly options: PtyTerminalFactoryOptions;
    public readonly resizeCalls: { columns: number; rows: number }[] = [];
    public readonly writes: Uint8Array[] = [];
    public closeCalls = 0;
    public closed = false;
    public nextWriteResult: number | undefined;

    public constructor(options: PtyTerminalFactoryOptions) {
        this.options = options;
    }

    public close(): void {
        this.closeCalls += 1;
        this.closed = true;
    }

    public emitData(data: Uint8Array): void {
        this.options.onData(data);
    }

    public emitDrain(): void {
        this.options.onDrain();
    }

    public emitExit(status: number): void {
        this.options.onExit(status);
    }

    public resize(columns: number, rows: number): void {
        this.resizeCalls.push({ columns, rows });
    }

    public write(data: Uint8Array): number {
        this.writes.push(new Uint8Array(data));
        return this.nextWriteResult ?? data.byteLength;
    }
}

interface PtyHarness {
    readonly exit: Deferred<number>;
    readonly handle: PtyProcessHandle;
    readonly spawnCalls: {
        argv: readonly string[];
        options: PtySpawnOptions;
    }[];
    readonly systemctlCalls: {
        argv: readonly string[];
        environment: Readonly<Record<string, string>>;
    }[];
    readonly terminal: FakeTerminal;
}

function processRequest(callbacks: PtyProcessCallbacks): PtyProcessRequest {
    return {
        callbacks,
        dimensions: { columns: 100, rows: 30 },
        realpathFencedWorkingDirectory: workingDirectory,
        sessionId,
    };
}

function createHarness(
    callbacks: PtyProcessCallbacks,
    options: {
        readonly delay?: (delayMs: number) => Promise<void>;
        readonly systemctlExitCode?: number;
    } = {}
): PtyHarness {
    const exit = deferred<number>();
    const spawnCalls: PtyHarness["spawnCalls"] = [];
    const systemctlCalls: PtyHarness["systemctlCalls"] = [];
    let terminal: FakeTerminal | undefined;
    const child: PtySubprocessHandle = {
        exited: exit.promise,
        signalCode: null,
    };
    const handle = createPtyProcess(processRequest(callbacks), {
        createTerminal(factoryOptions) {
            terminal = new FakeTerminal(factoryOptions);
            return terminal;
        },
        delay: options.delay,
        runtimeUser: {
            homeDirectory: "/home/ubuntu",
            userId: 1000,
            userName: "ubuntu",
        },
        spawn(argv, spawnOptions) {
            spawnCalls.push({ argv, options: spawnOptions });
            return child;
        },
        systemctl(argv, environment) {
            systemctlCalls.push({ argv, environment });
            return Promise.resolve(options.systemctlExitCode ?? 0);
        },
    });
    if (terminal === undefined) throw new Error("Expected fake terminal creation");
    return { exit, handle, spawnCalls, systemctlCalls, terminal };
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
    const output = new Uint8Array(
        chunks.reduce((bytes, chunk) => bytes + chunk.byteLength, 0)
    );
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

describe("worker systemd PTY process adapter", () => {
    test("builds one exact capped transient service with a secret-free environment", async () => {
        const request = processRequest({ onOutput: () => "accepted" });
        const specification = buildPtyProcessLaunchSpecification(request, {
            runtimeUser: {
                homeDirectory: "/home/ubuntu",
                userId: 1000,
                userName: "ubuntu",
            },
        });
        const unitName = `mira-dashboard-terminal-${sessionId}.service`;

        expect(specification).toEqual({
            argv: [
                "/usr/bin/systemd-run",
                "--user",
                "--collect",
                "--wait",
                "--pty",
                "--quiet",
                "--send-sighup",
                `--unit=${unitName}`,
                `--working-directory=${workingDirectory}`,
                "--property=Type=exec",
                "--property=KillMode=mixed",
                "--property=RuntimeMaxSec=1800s",
                "--property=MemoryMax=536870912",
                "--property=TasksMax=128",
                "--property=CPUQuota=200%",
                "/usr/bin/env",
                "-i",
                "HOME=/home/ubuntu",
                "LANG=C.UTF-8",
                "LC_ALL=C.UTF-8",
                "LOGNAME=ubuntu",
                "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "SHELL=/bin/bash",
                "TERM=xterm-256color",
                "USER=ubuntu",
                "/bin/bash",
                "--noprofile",
                "--norc",
                "-i",
            ],
            environment: {
                DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
                HOME: "/home/ubuntu",
                LANG: "C.UTF-8",
                LOGNAME: "ubuntu",
                PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                SHELL: "/bin/bash",
                TERM: "xterm-256color",
                USER: "ubuntu",
                XDG_RUNTIME_DIR: "/run/user/1000",
            },
            unitName,
        });
        expect(JSON.stringify(specification)).not.toContain("TOKEN");

        const harness = createHarness(request.callbacks);
        expect(harness.spawnCalls).toHaveLength(1);
        expect(harness.spawnCalls[0]?.argv).toEqual(specification.argv);
        expect(harness.spawnCalls[0]?.options.terminal).toBe(harness.terminal);
        expect(harness.terminal.options).toMatchObject({ columns: 100, rows: 30 });
        expect(harness.terminal.closed).toBeFalse();

        harness.exit.resolve(0);
        expect(await harness.handle.exited).toEqual({ exitCode: 0, signalCode: null });
        expect(harness.terminal.closeCalls).toBe(1);
        expect(harness.systemctlCalls).toHaveLength(0);
    });

    test("preserves raw ANSI and invalid UTF-8 bytes in bounded output callbacks", async () => {
        const fragments: Uint8Array[] = [];
        const harness = createHarness({
            onOutput(data) {
                fragments.push(data);
                return "accepted";
            },
        });
        const output = new Uint8Array(ptyOutputCallbackMaximumBytes * 2 + 7);
        output.fill(165);
        output.set([27, 91, 51, 49, 109, 255, 0]);

        harness.terminal.emitData(output);
        output.fill(0);

        expect(fragments.map(({ byteLength }) => byteLength)).toEqual([
            ptyOutputCallbackMaximumBytes,
            ptyOutputCallbackMaximumBytes,
            7,
        ]);
        expect(fragments.every(({ byteLength }) => byteLength <= 32_768)).toBeTrue();
        const received = concatenate(fragments);
        expect(received.slice(0, 7)).toEqual(
            new Uint8Array([27, 91, 51, 49, 109, 255, 0])
        );
        expect(received.at(-1)).toBe(165);

        harness.exit.resolve(0);
        await harness.handle.exited;
    });

    test("models input backpressure, drain, resize, and message bounds explicitly", async () => {
        let drainCalls = 0;
        const harness = createHarness({
            onInputDrain() {
                drainCalls += 1;
            },
            onOutput: () => "accepted",
        });
        const first = new Uint8Array([27, 91, 65]);
        expect(harness.handle.writeInput(first)).toEqual({
            acceptedBytes: 3,
            status: "accepted",
        });
        const partial = new Uint8Array([1, 2, 3]);
        harness.terminal.nextWriteResult = 1;
        expect(harness.handle.writeInput(partial)).toEqual({
            acceptedBytes: 3,
            status: "backpressured",
        });
        const queued = new Uint8Array([4, 5]);
        expect(harness.handle.writeInput(queued)).toEqual({
            acceptedBytes: 2,
            status: "backpressured",
        });
        partial.fill(9);
        queued.fill(9);
        harness.terminal.emitDrain();
        expect(drainCalls).toBe(0);
        harness.terminal.emitDrain();
        expect(drainCalls).toBe(0);
        harness.terminal.nextWriteResult = undefined;
        harness.terminal.emitDrain();
        expect(drainCalls).toBe(1);
        expect(harness.terminal.writes).toEqual([
            new Uint8Array([27, 91, 65]),
            new Uint8Array([1, 2, 3]),
            new Uint8Array([2, 3]),
            new Uint8Array([3]),
            new Uint8Array([4, 5]),
            new Uint8Array([5]),
        ]);
        harness.handle.resize({ columns: 140, rows: 42 });
        expect(harness.terminal.resizeCalls).toEqual([{ columns: 140, rows: 42 }]);
        expect(() => harness.handle.resize({ columns: 401, rows: 42 })).toThrow(
            PtyProcessError
        );

        harness.exit.resolve(0);
        await harness.handle.exited;
        expect(harness.handle.writeInput(new Uint8Array([1]))).toEqual({
            acceptedBytes: 0,
            status: "closed",
        });
        expect(await harness.handle.sendSignal("SIGINT")).toBe("closed");
    });

    test("bounds queued input bytes and frame metadata, then terminates fail closed", async () => {
        const grace = deferred<void>();
        const harness = createHarness(
            { onOutput: () => "accepted" },
            { delay: () => grace.promise }
        );
        harness.terminal.nextWriteResult = 0;
        const frame = new Uint8Array(ptyInputMaximumBytes);
        frame.fill(37);
        const frameCapacity = ptyPendingInputMaximumBytes / ptyInputMaximumBytes;
        expect(Number.isSafeInteger(frameCapacity)).toBeTrue();
        for (let index = 0; index < frameCapacity; index += 1) {
            expect(harness.handle.writeInput(frame)).toEqual({
                acceptedBytes: ptyInputMaximumBytes,
                status: "backpressured",
            });
        }
        expect(harness.terminal.writes).toHaveLength(1);
        expect(harness.handle.writeInput(frame)).toEqual({
            acceptedBytes: 0,
            status: "closed",
        });
        await flushMicrotasks();
        expect(harness.systemctlCalls.map(({ argv }) => argv.at(-2))).toEqual([
            "--signal=TERM",
        ]);
        harness.terminal.nextWriteResult = undefined;
        harness.terminal.emitDrain();
        expect(harness.terminal.writes).toHaveLength(1);

        harness.exit.resolve(137);
        expect(await harness.handle.exited).toEqual({
            exitCode: 137,
            signalCode: null,
        });
        grace.resolve();

        const frameBoundGrace = deferred<void>();
        const frameBound = createHarness(
            { onOutput: () => "accepted" },
            { delay: () => frameBoundGrace.promise }
        );
        frameBound.terminal.nextWriteResult = 0;
        for (let index = 0; index < ptyPendingInputMaximumFrames; index += 1) {
            expect(frameBound.handle.writeInput(new Uint8Array([index]))).toEqual({
                acceptedBytes: 1,
                status: "backpressured",
            });
        }
        expect(frameBound.handle.writeInput(new Uint8Array([255]))).toEqual({
            acceptedBytes: 0,
            status: "closed",
        });
        await flushMicrotasks();
        expect(frameBound.systemctlCalls.map(({ argv }) => argv.at(-2))).toEqual([
            "--signal=TERM",
        ]);
        frameBound.exit.resolve(137);
        await frameBound.handle.exited;
        frameBoundGrace.resolve();
    });

    test("clears pending input on explicit termination and invalid terminal writes", async () => {
        const grace = deferred<void>();
        const terminated = createHarness(
            { onOutput: () => "accepted" },
            { delay: () => grace.promise }
        );
        terminated.terminal.nextWriteResult = 1;
        expect(terminated.handle.writeInput(new Uint8Array([1, 2, 3]))).toEqual({
            acceptedBytes: 3,
            status: "backpressured",
        });
        const termination = terminated.handle.terminate();
        terminated.terminal.nextWriteResult = undefined;
        terminated.terminal.emitDrain();
        expect(terminated.terminal.writes).toEqual([new Uint8Array([1, 2, 3])]);
        terminated.exit.resolve(143);
        await termination;
        grace.resolve();

        const invalidGrace = deferred<void>();
        const invalid = createHarness(
            { onOutput: () => "accepted" },
            { delay: () => invalidGrace.promise }
        );
        invalid.terminal.nextWriteResult = Number.NaN;
        expect(invalid.handle.writeInput(new Uint8Array([1]))).toEqual({
            acceptedBytes: 0,
            status: "closed",
        });
        await flushMicrotasks();
        expect(invalid.systemctlCalls.map(({ argv }) => argv.at(-2))).toEqual([
            "--signal=TERM",
        ]);
        invalidGrace.resolve();
        await flushMicrotasks();
        expect(invalid.systemctlCalls.map(({ argv }) => argv.at(-2))).toEqual([
            "--signal=TERM",
            "--signal=KILL",
        ]);
        invalid.exit.resolve(137);
        await invalid.handle.exited;

        const oversizedGrace = deferred<void>();
        const oversized = createHarness(
            { onOutput: () => "accepted" },
            { delay: () => oversizedGrace.promise }
        );
        expect(() =>
            oversized.handle.writeInput(new Uint8Array(ptyInputMaximumBytes + 1))
        ).toThrow(PtyProcessError);
        await flushMicrotasks();
        expect(oversized.systemctlCalls).toHaveLength(1);
        oversizedGrace.resolve();
        await flushMicrotasks();
        expect(oversized.systemctlCalls).toHaveLength(2);
        oversized.exit.resolve(137);
        await oversized.handle.exited;
    });

    test("terminates backpressured output with TERM then KILL and waits for proc.exited", async () => {
        const grace = deferred<void>();
        const observedDelays: number[] = [];
        let backpressureCalls = 0;
        const harness = createHarness(
            {
                onOutput: () => "backpressured",
                onOutputBackpressure() {
                    backpressureCalls += 1;
                },
            },
            {
                delay(delayMs) {
                    observedDelays.push(delayMs);
                    return grace.promise;
                },
            }
        );

        harness.terminal.emitData(new Uint8Array([27, 91, 109]));
        harness.terminal.emitData(new Uint8Array([1, 2, 3]));
        await flushMicrotasks();
        expect(harness.handle.outputBackpressured).toBeTrue();
        expect(backpressureCalls).toBe(1);
        expect(observedDelays).toEqual([ptyForceKillDelayMs]);
        expect(harness.systemctlCalls.map(({ argv }) => argv.at(-2))).toEqual([
            "--signal=TERM",
        ]);

        const termination = harness.handle.terminate();
        expect(harness.handle.terminate()).toBe(termination);
        let terminationSettled = false;
        void termination.finally(() => {
            terminationSettled = true;
        });
        grace.resolve();
        await flushMicrotasks();
        expect(harness.systemctlCalls.map(({ argv }) => argv.at(-2))).toEqual([
            "--signal=TERM",
            "--signal=KILL",
        ]);
        expect(terminationSettled).toBeFalse();

        harness.exit.resolve(137);
        expect(await termination).toEqual({ exitCode: 137, signalCode: null });
        expect(terminationSettled).toBeTrue();
        expect(harness.terminal.closed).toBeTrue();
    });

    test("does not escalate when the authoritative process exit wins the grace race", async () => {
        const grace = deferred<void>();
        const harness = createHarness(
            { onOutput: () => "accepted" },
            { delay: () => grace.promise }
        );

        const termination = harness.handle.terminate();
        await flushMicrotasks();
        expect(harness.systemctlCalls.map(({ argv }) => argv.at(-2))).toEqual([
            "--signal=TERM",
        ]);
        harness.exit.resolve(0);
        expect(await termination).toEqual({ exitCode: 0, signalCode: null });
        expect(harness.systemctlCalls.map(({ argv }) => argv.at(-2))).toEqual([
            "--signal=TERM",
        ]);
        grace.resolve();
    });

    test("sends only reviewed signals to the exact cgroup unit", async () => {
        const harness = createHarness({ onOutput: () => "accepted" });
        expect(await harness.handle.sendSignal("SIGINT")).toBe("sent");
        expect(await harness.handle.sendSignal("SIGHUP")).toBe("sent");
        expect(harness.systemctlCalls.map(({ argv }) => argv)).toEqual([
            [
                "/usr/bin/systemctl",
                "--user",
                "--no-ask-password",
                "--no-pager",
                "kill",
                "--kill-whom=all",
                "--signal=INT",
                `mira-dashboard-terminal-${sessionId}.service`,
            ],
            [
                "/usr/bin/systemctl",
                "--user",
                "--no-ask-password",
                "--no-pager",
                "kill",
                "--kill-whom=all",
                "--signal=HUP",
                `mira-dashboard-terminal-${sessionId}.service`,
            ],
        ]);
        let invalidSignalFailure: unknown;
        try {
            await harness.handle.sendSignal("SIGKILL" as "SIGINT");
        } catch (error) {
            invalidSignalFailure = error;
        }
        expect(invalidSignalFailure).toMatchObject({ reason: "invalid-input" });

        harness.exit.resolve(0);
        await harness.handle.exited;
    });

    test("treats PTY lifecycle status as non-authoritative and sanitizes spawn failures", async () => {
        const grace = deferred<void>();
        const harness = createHarness(
            { onOutput: () => "accepted" },
            { delay: () => grace.promise }
        );
        let exited = false;
        void harness.handle.exited.then(() => {
            exited = true;
            return exited;
        });

        harness.terminal.emitExit(0);
        await flushMicrotasks();
        expect(exited).toBeFalse();
        expect(harness.systemctlCalls).toHaveLength(0);
        harness.terminal.emitExit(1);
        await flushMicrotasks();
        expect(exited).toBeFalse();
        expect(harness.systemctlCalls.map(({ argv }) => argv.at(-2))).toEqual([
            "--signal=TERM",
        ]);

        harness.exit.resolve(1);
        expect(await harness.handle.exited).toEqual({ exitCode: 1, signalCode: null });
        grace.resolve();

        let failedTerminal: FakeTerminal | undefined;
        expect(() =>
            createPtyProcess(processRequest({ onOutput: () => "accepted" }), {
                createTerminal(options) {
                    failedTerminal = new FakeTerminal(options);
                    return failedTerminal;
                },
                runtimeUser: {
                    homeDirectory: "/home/ubuntu",
                    userId: 1000,
                    userName: "ubuntu",
                },
                spawn() {
                    throw new Error("private spawn failure /home/ubuntu");
                },
            })
        ).toThrow(new PtyProcessError("spawn-failed"));
        expect(failedTerminal?.closed).toBeTrue();
    });

    test("rejects unreviewed unit identities and non-canonical working directories", () => {
        const request = processRequest({ onOutput: () => "accepted" });
        expect(() =>
            buildPtyProcessLaunchSpecification({
                ...request,
                sessionId: "../../escape",
            })
        ).toThrow(new PtyProcessError("invalid-request"));
        expect(() =>
            buildPtyProcessLaunchSpecification({
                ...request,
                realpathFencedWorkingDirectory: "/home/ubuntu/../root",
            })
        ).toThrow(new PtyProcessError("invalid-request"));
        expect(() =>
            buildPtyProcessLaunchSpecification({
                ...request,
                realpathFencedWorkingDirectory: "/home/ubuntu\nprivate",
            })
        ).toThrow(new PtyProcessError("invalid-request"));
    });
});
