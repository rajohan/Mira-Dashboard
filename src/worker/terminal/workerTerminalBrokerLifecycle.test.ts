import { describe, expect, test } from "bun:test";

import {
    type TerminalBrokerByteConnection,
    type TerminalBrokerIpcLifecycle,
    type TerminalBrokerSocketMetadata,
    type TerminalBrokerSocketPathOperations,
} from "./terminalBrokerServer.ts";
import {
    createWorkerTerminalSessionBroker,
    type WorkerPtyHandle,
    type WorkerTerminalRelaySink,
    type WorkerTerminalSessionBroker,
    type WorkerTerminalSessionBrokerDependencies,
} from "./terminalSessionBroker.ts";
import {
    startWorkerTerminalBrokerLifecycle,
    WorkerTerminalBrokerLifecycleError,
    type WorkerTerminalBrokerLifecycle,
    type WorkerTerminalBrokerLifecycleDependencies,
} from "./workerTerminalBrokerLifecycle.ts";

const projectRoot = "/srv/mira-dashboard";
const socketDirectory = `${projectRoot}/production/state/terminal-broker`;
const socketPath = `${socketDirectory}/terminal.sock`;
const expectedUserId = 1000;
const nowMs = 1_800_000_000_000;
const sessionId = "019fe7a8-03fe-7000-8ea2-874b1ea1b40e";
const owner = Object.freeze({ authenticatorId: "auth-1", id: "user-1" });

interface Deferred<T> {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolvePromise: ((value: T) => void) | undefined;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve(value) {
            resolvePromise?.(value);
        },
    };
}

async function flush(): Promise<void> {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

async function captureFailure(action: () => Promise<unknown>): Promise<unknown> {
    try {
        await action();
        return null;
    } catch (error) {
        return error;
    }
}

class FakeSocketOperations implements TerminalBrokerSocketPathOperations {
    public readonly metadata = new Map<string, TerminalBrokerSocketMetadata>();
    public readonly removed: string[] = [];
    public chmodFails = false;
    public probeResult: "active" | "stale" = "stale";
    public realDirectory = socketDirectory;

    public chmod(targetPath: string, mode: number): Promise<void> {
        if (this.chmodFails) return Promise.reject(new Error("chmod failed"));
        const current = this.metadata.get(targetPath);
        if (current !== undefined) this.metadata.set(targetPath, { ...current, mode });
        return Promise.resolve();
    }

    public inspect(
        targetPath: string
    ): Promise<TerminalBrokerSocketMetadata | undefined> {
        return Promise.resolve(this.metadata.get(targetPath));
    }

    public probe(): Promise<"active" | "stale"> {
        return Promise.resolve(this.probeResult);
    }

    public realpath(): Promise<string> {
        return Promise.resolve(this.realDirectory);
    }

    public remove(targetPath: string): Promise<void> {
        this.removed.push(targetPath);
        this.metadata.delete(targetPath);
        return Promise.resolve();
    }
}

class FakeConnection implements TerminalBrokerByteConnection {
    public closeCalls = 0;

    public close(): void {
        this.closeCalls += 1;
    }

    public send(): "accepted" {
        return "accepted";
    }

    public setHandlers(): void {}
}

class FakeIpcLifecycle implements TerminalBrokerIpcLifecycle {
    public readonly events: string[];
    public readonly operations: FakeSocketOperations;
    public closeCalls = 0;
    public closeFails = false;
    public listenCalls = 0;
    public listenedPath: string | undefined;
    public onConnection: ((connection: TerminalBrokerByteConnection) => void) | undefined;

    public constructor(operations: FakeSocketOperations, events: string[]) {
        this.operations = operations;
        this.events = events;
    }

    public listen(input: {
        readonly onConnection: (connection: TerminalBrokerByteConnection) => void;
        readonly socketPath: string;
    }) {
        this.listenCalls += 1;
        this.listenedPath = input.socketPath;
        this.onConnection = input.onConnection;
        this.operations.metadata.set(input.socketPath, {
            kind: "socket",
            linkCount: 1,
            mode: 0o777,
            ownerUserId: expectedUserId,
        });
        return Promise.resolve({
            close: () => {
                this.closeCalls += 1;
                this.events.push("listener-close");
                return this.closeFails
                    ? Promise.reject(new Error("listener close failed"))
                    : Promise.resolve();
            },
        });
    }
}

interface Harness {
    readonly dependencies: WorkerTerminalBrokerLifecycleDependencies;
    readonly events: string[];
    readonly exit: Deferred<{
        readonly exitCode: number;
        readonly signalCode: NodeJS.Signals | null;
    }>;
    readonly ipc: FakeIpcLifecycle;
    readonly operations: FakeSocketOperations;
    readonly sessionBrokerDependencies: WorkerTerminalSessionBrokerDependencies;
    readonly terminateCalls: () => number;
}

function createHarness(): Harness {
    const events: string[] = [];
    const operations = new FakeSocketOperations();
    operations.metadata.set(socketDirectory, {
        kind: "directory",
        linkCount: 2,
        mode: 0o700,
        ownerUserId: expectedUserId,
    });
    const ipc = new FakeIpcLifecycle(operations, events);
    const exit = deferred<{
        readonly exitCode: number;
        readonly signalCode: NodeJS.Signals | null;
    }>();
    let terminateCalls = 0;
    const sessionBrokerDependencies: WorkerTerminalSessionBrokerDependencies = {
        nowMs: () => nowMs,
        pty: (): WorkerPtyHandle => ({
            exited: exit.promise,
            resize() {},
            sendSignal: () => Promise.resolve("sent"),
            terminate() {
                terminateCalls += 1;
                events.push("pty-terminate");
                return exit.promise;
            },
            writeInput(data) {
                return { acceptedBytes: data.byteLength, status: "accepted" };
            },
        }),
        scheduler: {
            schedule() {
                return Object.freeze({ cancel() {} });
            },
        },
    };
    const dependencies: WorkerTerminalBrokerLifecycleDependencies = {
        createIpcLifecycle: () => ipc,
        createSessionBroker: (
            brokerDependencies: WorkerTerminalSessionBrokerDependencies
        ) => createWorkerTerminalSessionBroker(brokerDependencies),
        createSocketPathOperations: () => operations,
        getUserId: () => expectedUserId,
        platform: "linux",
    };
    return {
        dependencies,
        events,
        exit,
        ipc,
        operations,
        sessionBrokerDependencies,
        terminateCalls: () => terminateCalls,
    };
}

async function startHarness(harness: Harness): Promise<WorkerTerminalBrokerLifecycle> {
    return startWorkerTerminalBrokerLifecycle(
        {
            projectRoot,
            sessionBrokerDependencies: harness.sessionBrokerDependencies,
        },
        harness.dependencies
    );
}

function terminalTicket(): {
    readonly rawToken: string;
    readonly ticket: {
        readonly afterSequence: number;
        readonly expiresAtMs: number;
        readonly prefix: string;
        readonly validatorHash: string;
    };
} {
    const prefix = "a".repeat(32);
    const validator = "b".repeat(64);
    return {
        rawToken: `${prefix}.${validator}`,
        ticket: {
            afterSequence: 0,
            expiresAtMs: nowMs + 30_000,
            prefix,
            validatorHash: new Bun.CryptoHasher("sha256")
                .update(`mira-dashboard:terminal:v1:${prefix}:${validator}`)
                .digest("hex"),
        },
    };
}

async function startPty(broker: WorkerTerminalSessionBroker): Promise<void> {
    const { rawToken, ticket } = terminalTicket();
    await broker.reserve({
        absoluteStartingDirectory: "/srv/mira-dashboard/production/checkout",
        dimensions: { columns: 100, rows: 30 },
        location: { path: "/", rootId: "dashboard" },
        owner,
        sessionId,
        ticket,
    });
    const sink: WorkerTerminalRelaySink = {
        close() {},
        sendControl: () => "accepted",
        sendOutput: () => "accepted",
    };
    await broker.attach({ owner, rawToken, sessionId, sink });
}

describe("worker Terminal broker lifecycle composition", () => {
    test("derives the exact socket and stops listener, PTYs, then socket idempotently", async () => {
        const harness = createHarness();
        const lifecycle = await startHarness(harness);
        expect(lifecycle.socketPath).toBe(socketPath);
        expect(harness.ipc.listenedPath).toBe(socketPath);
        expect(harness.operations.metadata.get(socketPath)?.mode).toBe(0o600);
        await startPty(lifecycle.broker);

        const firstStop = lifecycle.stop();
        const secondStop = lifecycle.stop();
        expect(secondStop).toBe(firstStop);
        await flush();
        expect(harness.events).toEqual(["listener-close", "pty-terminate"]);
        expect(harness.operations.removed).toEqual([]);

        harness.exit.resolve({ exitCode: 143, signalCode: null });
        await firstStop;
        expect(harness.terminateCalls()).toBe(1);
        expect(harness.operations.removed).toEqual([socketPath]);
        expect(harness.operations.metadata.has(socketPath)).toBeFalse();
    });

    test("rejects a non-canonical root, runtime uid mismatch, and non-0700 directory before listen", async () => {
        const invalidRoot = createHarness();
        const rootFailure = await captureFailure(() =>
            startWorkerTerminalBrokerLifecycle(
                { projectRoot: `${projectRoot}/../mira-dashboard` },
                invalidRoot.dependencies
            )
        );
        expect(rootFailure).toMatchObject({ reason: "invalid-runtime" });
        expect(invalidRoot.ipc.listenCalls).toBe(0);

        const wrongOwner = createHarness();
        wrongOwner.operations.metadata.set(socketDirectory, {
            kind: "directory",
            linkCount: 2,
            mode: 0o700,
            ownerUserId: expectedUserId + 1,
        });
        expect(await captureFailure(() => startHarness(wrongOwner))).toBeInstanceOf(
            WorkerTerminalBrokerLifecycleError
        );
        expect(wrongOwner.ipc.listenCalls).toBe(0);

        const wrongMode = createHarness();
        wrongMode.operations.metadata.set(socketDirectory, {
            kind: "directory",
            linkCount: 2,
            mode: 0o750,
            ownerUserId: expectedUserId,
        });
        const modeFailure = await captureFailure(() => startHarness(wrongMode));
        expect(modeFailure).toMatchObject({ reason: "invalid-runtime" });
        expect(wrongMode.ipc.listenCalls).toBe(0);
    });

    test("preserves an active pre-existing socket and fails before binding", async () => {
        const harness = createHarness();
        harness.operations.metadata.set(socketPath, {
            kind: "socket",
            linkCount: 1,
            mode: 0o600,
            ownerUserId: expectedUserId,
        });
        harness.operations.probeResult = "active";

        const failure = await captureFailure(() => startHarness(harness));
        expect(failure).toMatchObject({ reason: "start-failed" });
        expect(harness.ipc.listenCalls).toBe(0);
        expect(harness.operations.removed).toEqual([]);
        expect(harness.operations.metadata.has(socketPath)).toBeTrue();
    });

    test("closes and removes its socket when post-bind verification fails", async () => {
        const harness = createHarness();
        harness.operations.chmodFails = true;

        const failure = await captureFailure(() => startHarness(harness));
        expect(failure).toMatchObject({ reason: "start-failed" });
        expect(harness.ipc.closeCalls).toBe(1);
        expect(harness.operations.removed).toEqual([socketPath]);
        expect(harness.operations.metadata.has(socketPath)).toBeFalse();
    });

    test("terminates PTYs and unlinks the socket even when listener close fails", async () => {
        const harness = createHarness();
        harness.ipc.closeFails = true;
        const lifecycle = await startHarness(harness);
        await startPty(lifecycle.broker);

        const stop = lifecycle.stop();
        const sameStop = lifecycle.stop();
        expect(sameStop).toBe(stop);
        await flush();
        expect(harness.events).toEqual(["listener-close", "pty-terminate"]);
        const lateConnection = new FakeConnection();
        harness.ipc.onConnection?.(lateConnection);
        expect(lateConnection.closeCalls).toBe(1);
        expect(harness.operations.removed).toEqual([]);

        harness.exit.resolve({ exitCode: 143, signalCode: null });
        const failure = await captureFailure(() => stop);
        expect(failure).toMatchObject({ reason: "stop-failed" });
        expect(harness.terminateCalls()).toBe(1);
        expect(harness.ipc.closeCalls).toBe(1);
        expect(harness.operations.removed).toEqual([socketPath]);
    });
});
