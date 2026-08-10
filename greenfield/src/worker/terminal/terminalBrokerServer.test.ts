import { describe, expect, test } from "bun:test";

import {
    encodeTerminalBrokerControl,
    encodeTerminalBrokerInput,
    TerminalBrokerFrameDecoder,
} from "../../shared/terminalBrokerProtocol.ts";
import {
    startTerminalBrokerServer,
    type TerminalBrokerByteConnection,
    type TerminalBrokerIpcLifecycle,
    type TerminalBrokerServerScheduler,
    type TerminalBrokerSocketMetadata,
    type TerminalBrokerSocketPathOperations,
    TerminalBrokerSocketSecurityError,
} from "./terminalBrokerServer.ts";
import {
    createWorkerTerminalSessionBroker,
    type WorkerPtyRequest,
    type WorkerTerminalAttachment,
    type WorkerTerminalRelaySink,
    type WorkerTerminalSessionBroker,
} from "./terminalSessionBroker.ts";

const projectDirectory = "/srv/mira/state/terminal";
const socketPath = `${projectDirectory}/broker.sock`;
const sessionId = "019fe7a8-03fe-7000-8ea2-874b1ea1b40e";
const owner = Object.freeze({ authenticatorId: "auth-1", id: "user-1" });
const summary = Object.freeze({
    dimensions: { columns: 100, rows: 30 },
    expiresAtMs: 1_800_001_800_000,
    idleExpiresAtMs: 1_800_000_600_000,
    location: { path: "/", rootId: "dashboard" },
    nextSequence: 1,
    replayAvailableFromSequence: 1,
    sessionId,
    startedAtMs: 1_800_000_000_000,
    state: "connected" as const,
});

class FakeSocketOperations implements TerminalBrokerSocketPathOperations {
    public readonly metadata = new Map<string, TerminalBrokerSocketMetadata>();
    public readonly removed: string[] = [];
    public probeResult: "active" | "stale" = "stale";

    public chmod(targetPath: string, mode: number): Promise<void> {
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

    public realpath(targetPath: string): Promise<string> {
        return Promise.resolve(targetPath);
    }

    public remove(targetPath: string): Promise<void> {
        this.removed.push(targetPath);
        this.metadata.delete(targetPath);
        return Promise.resolve();
    }
}

class FakeConnection implements TerminalBrokerByteConnection {
    public handlers:
        | {
              readonly onClose: () => void;
              readonly onData: (data: Uint8Array) => void;
              readonly onDrain: () => void;
          }
        | undefined;
    public readonly sent: Uint8Array[] = [];
    public closeCalls = 0;
    public disposition: "accepted" | "backpressured" | "closed" = "accepted";
    public onSend: ((data: Uint8Array) => void) | undefined;
    public readonly pending: Uint8Array[] = [];
    public peerClosed = false;

    public close(): void {
        this.closeCalls += 1;
        this.peerClosed = true;
        this.pending.length = 0;
    }

    public emit(data: Uint8Array): void {
        this.handlers?.onData(data);
    }

    public emitClose(): void {
        this.peerClosed = true;
        this.handlers?.onClose();
    }

    public emitDrain(): void {
        if (this.peerClosed) return;
        this.sent.push(...this.pending.splice(0));
        this.handlers?.onDrain();
    }

    public send(data: Uint8Array) {
        if (this.peerClosed) return "closed" as const;
        this.onSend?.(data);
        if (this.peerClosed) return "closed" as const;
        if (this.disposition === "backpressured") {
            this.pending.push(new Uint8Array(data));
            return this.disposition;
        }
        if (this.disposition === "closed") {
            this.peerClosed = true;
            return this.disposition;
        }
        this.sent.push(new Uint8Array(data));
        return this.disposition;
    }

    public setHandlers(handlers: NonNullable<FakeConnection["handlers"]>): void {
        this.handlers = handlers;
    }
}

class ManualCloseScheduler implements TerminalBrokerServerScheduler {
    public readonly entries: Array<{
        readonly callback: () => void;
        cancelled: boolean;
        readonly delayMs: number;
    }> = [];

    public schedule(callback: () => void, delayMs: number) {
        const entry = { callback, cancelled: false, delayMs };
        this.entries.push(entry);
        return {
            cancel() {
                entry.cancelled = true;
            },
        };
    }
}

class FakeLifecycle implements TerminalBrokerIpcLifecycle {
    public readonly operations: FakeSocketOperations;
    public closeCalls = 0;
    public listenCalls = 0;
    public onConnection: ((connection: TerminalBrokerByteConnection) => void) | undefined;

    public constructor(operations: FakeSocketOperations) {
        this.operations = operations;
    }

    public listen(input: {
        readonly onConnection: (connection: TerminalBrokerByteConnection) => void;
        readonly socketPath: string;
    }) {
        this.listenCalls += 1;
        this.onConnection = input.onConnection;
        this.operations.metadata.set(input.socketPath, {
            kind: "socket",
            linkCount: 1,
            mode: 0o777,
            ownerUserId: 1000,
        });
        return Promise.resolve({
            close: () => {
                this.closeCalls += 1;
                return Promise.resolve();
            },
        });
    }
}

function fakeBroker() {
    let attachedSink: WorkerTerminalRelaySink | undefined;
    let detachCalls = 0;
    let drainDuringInput = false;
    let inputBytes: Uint8Array | undefined;
    let resizeCalls = 0;
    let resumeCalls = 0;
    let shutdownCalls = 0;
    const attachment: WorkerTerminalAttachment = {
        detach() {
            detachCalls += 1;
        },
        input(data) {
            inputBytes = new Uint8Array(data);
            if (drainDuringInput) {
                attachedSink?.sendControl({ type: "input-drain" });
                return { acceptedBytes: data.byteLength, status: "backpressured" };
            }
            return { acceptedBytes: data.byteLength, status: "accepted" };
        },
        ping() {},
        resize() {
            resizeCalls += 1;
        },
        resumeOutput() {
            resumeCalls += 1;
        },
        signal: () => Promise.resolve("sent"),
        terminate: () => Promise.resolve(),
    };
    const broker: WorkerTerminalSessionBroker = {
        attach(input) {
            attachedSink = input.sink;
            input.sink.sendControl({
                replayAvailableFromSequence: 1,
                resumed: false,
                session: summary,
                type: "ready",
            });
            return Promise.resolve(attachment);
        },
        getActive: () => Promise.resolve(summary),
        prepareResume: () => Promise.resolve(summary),
        reserve: () => Promise.resolve(summary),
        shutdown() {
            shutdownCalls += 1;
            return Promise.resolve();
        },
        terminate: () => Promise.resolve(),
    };
    return {
        broker,
        get attachedSink() {
            return attachedSink;
        },
        get detachCalls() {
            return detachCalls;
        },
        set drainDuringInput(value: boolean) {
            drainDuringInput = value;
        },
        get inputBytes() {
            return inputBytes;
        },
        get resizeCalls() {
            return resizeCalls;
        },
        get resumeCalls() {
            return resumeCalls;
        },
        get shutdownCalls() {
            return shutdownCalls;
        },
    };
}

function safeOptions() {
    const operations = new FakeSocketOperations();
    operations.metadata.set(projectDirectory, {
        kind: "directory",
        linkCount: 2,
        mode: 0o700,
        ownerUserId: 1000,
    });
    const lifecycle = new FakeLifecycle(operations);
    const broker = fakeBroker();
    return {
        broker,
        lifecycle,
        operations,
        options: {
            broker: broker.broker,
            expectedUserId: 1000,
            lifecycle,
            projectLocalDirectory: projectDirectory,
            socketPath,
            socketPathOperations: operations,
        },
    };
}

function decodeControl(frame: Uint8Array) {
    const decoded = new TerminalBrokerFrameDecoder().push(frame)[0];
    if (decoded?.kind !== "control") throw new Error("Expected control frame");
    return decoded.message;
}

function realBrokerHarness() {
    const nowMs = 1_800_000_000_000;
    const exit = Promise.withResolvers<{
        exitCode: number;
        signalCode: NodeJS.Signals | null;
    }>();
    let ptyRequest: WorkerPtyRequest | undefined;
    let terminateCalls = 0;
    const broker = createWorkerTerminalSessionBroker({
        nowMs: () => nowMs,
        pty(request) {
            ptyRequest = request;
            return {
                exited: exit.promise,
                resize() {},
                sendSignal: () => Promise.resolve("sent"),
                terminate() {
                    terminateCalls += 1;
                    const result = {
                        exitCode: 143,
                        signalCode: "SIGTERM" as const,
                    };
                    exit.resolve(result);
                    return Promise.resolve(result);
                },
                writeInput(data) {
                    return { acceptedBytes: data.byteLength, status: "accepted" };
                },
            };
        },
        scheduler: {
            schedule() {
                return { cancel() {} };
            },
        },
    });
    const prefix = "1".padStart(32, "0");
    const validator = "11".padStart(64, "0");
    const validatorHash = new Bun.CryptoHasher("sha256")
        .update(`mira-dashboard:terminal:v1:${prefix}:${validator}`)
        .digest("hex");
    return {
        broker,
        emitExit(result: { exitCode: number; signalCode: NodeJS.Signals | null }) {
            exit.resolve(result);
        },
        emitOutput(data: Uint8Array) {
            return ptyRequest?.callbacks.onOutput(data);
        },
        get terminateCalls() {
            return terminateCalls;
        },
        rawToken: `${prefix}.${validator}`,
        reserve: () =>
            broker.reserve({
                absoluteStartingDirectory: "/",
                dimensions: { columns: 100, rows: 30 },
                location: { path: "/", rootId: "dashboard" },
                owner,
                sessionId,
                ticket: {
                    afterSequence: 0,
                    expiresAtMs: nowMs + 60_000,
                    prefix,
                    validatorHash,
                },
            }),
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

describe("terminal broker Unix IPC server", () => {
    test("removes only a verified stale socket and locks the listening socket to 0600", async () => {
        const harness = safeOptions();
        harness.operations.metadata.set(socketPath, {
            kind: "socket",
            linkCount: 1,
            mode: 0o600,
            ownerUserId: 1000,
        });

        const server = await startTerminalBrokerServer(harness.options);
        expect(harness.operations.removed).toEqual([socketPath]);
        expect(harness.lifecycle.listenCalls).toBe(1);
        expect(harness.operations.metadata.get(socketPath)).toMatchObject({
            kind: "socket",
            linkCount: 1,
            mode: 0o600,
            ownerUserId: 1000,
        });
        await server.close();
        expect(harness.lifecycle.closeCalls).toBe(1);
        expect(harness.broker.shutdownCalls).toBe(1);
        expect(harness.operations.removed).toEqual([socketPath, socketPath]);
    });

    test("fails closed for an active socket or unsafe project-local directory", async () => {
        const active = safeOptions();
        active.operations.metadata.set(socketPath, {
            kind: "socket",
            linkCount: 1,
            mode: 0o600,
            ownerUserId: 1000,
        });
        active.operations.probeResult = "active";
        expect(
            await captureFailure(() => startTerminalBrokerServer(active.options))
        ).toBeInstanceOf(TerminalBrokerSocketSecurityError);
        expect(active.lifecycle.listenCalls).toBe(0);

        const unsafe = safeOptions();
        unsafe.operations.metadata.set(projectDirectory, {
            kind: "directory",
            linkCount: 2,
            mode: 0o770,
            ownerUserId: 1000,
        });
        expect(
            await captureFailure(() => startTerminalBrokerServer(unsafe.options))
        ).toBeInstanceOf(TerminalBrokerSocketSecurityError);
        expect(unsafe.lifecycle.listenCalls).toBe(0);
    });

    test("routes bounded lifecycle and attached raw frames over one injected connection", async () => {
        const harness = safeOptions();
        const server = await startTerminalBrokerServer(harness.options);
        const lifecycleConnection = new FakeConnection();
        harness.lifecycle.onConnection?.(lifecycleConnection);
        lifecycleConnection.emit(
            encodeTerminalBrokerControl({
                owner,
                requestId: "request-1",
                type: "get-active",
            })
        );
        await flush();
        expect(decodeControl(lifecycleConnection.sent[0] ?? new Uint8Array())).toEqual({
            requestId: "request-1",
            type: "result",
            value: summary,
        });
        expect(lifecycleConnection.closeCalls).toBe(1);

        const attachedConnection = new FakeConnection();
        harness.lifecycle.onConnection?.(attachedConnection);
        const rawToken = `${"a".repeat(32)}.${"b".repeat(64)}`;
        attachedConnection.emit(
            encodeTerminalBrokerControl({ owner, rawToken, sessionId, type: "attach" })
        );
        await flush();
        expect(
            decodeControl(attachedConnection.sent[0] ?? new Uint8Array())
        ).toMatchObject({
            replayAvailableFromSequence: 1,
            type: "ready",
        });
        attachedConnection.emit(encodeTerminalBrokerInput(new Uint8Array([0, 4, 27])));
        attachedConnection.emit(
            encodeTerminalBrokerControl({
                dimensions: { columns: 120, rows: 40 },
                type: "resize",
            })
        );
        await flush();
        expect(harness.broker.inputBytes).toEqual(new Uint8Array([0, 4, 27]));
        expect(decodeControl(attachedConnection.sent[1] ?? new Uint8Array())).toEqual({
            acceptedBytes: 3,
            status: "accepted",
            type: "input-status",
        });
        expect(harness.broker.resizeCalls).toBe(1);

        harness.broker.drainDuringInput = true;
        attachedConnection.emit(encodeTerminalBrokerInput(new Uint8Array([5])));
        await flush();
        expect(decodeControl(attachedConnection.sent[2] ?? new Uint8Array())).toEqual({
            acceptedBytes: 1,
            status: "backpressured",
            type: "input-status",
        });
        expect(decodeControl(attachedConnection.sent[3] ?? new Uint8Array())).toEqual({
            type: "input-drain",
        });

        attachedConnection.disposition = "backpressured";
        expect(
            harness.broker.attachedSink?.sendOutput(3, new Uint8Array([27, 91, 109]))
        ).toBe("backpressured");
        attachedConnection.emitDrain();
        expect(harness.broker.resumeCalls).toBe(1);
        attachedConnection.emitClose();
        expect(harness.broker.detachCalls).toBe(1);
        await server.close();
    });

    test("detaches a late attachment when its connection closes before attach resolves", async () => {
        const harness = safeOptions();
        const attachStarted = Promise.withResolvers<void>();
        const delayedAttachment = Promise.withResolvers<WorkerTerminalAttachment>();
        let attachCalls = 0;
        let detachCalls = 0;
        const broker: WorkerTerminalSessionBroker = {
            ...harness.broker.broker,
            attach() {
                attachCalls += 1;
                attachStarted.resolve();
                return delayedAttachment.promise;
            },
        };
        const server = await startTerminalBrokerServer({
            ...harness.options,
            broker,
        });
        const attachFrame = encodeTerminalBrokerControl({
            owner,
            rawToken: `${"a".repeat(32)}.${"b".repeat(64)}`,
            sessionId,
            type: "attach",
        });
        const preClosedConnection = new FakeConnection();
        harness.lifecycle.onConnection?.(preClosedConnection);
        preClosedConnection.emit(attachFrame);
        preClosedConnection.emitClose();
        await flush();
        expect(attachCalls).toBe(0);

        const connection = new FakeConnection();
        harness.lifecycle.onConnection?.(connection);
        connection.emit(attachFrame);
        await attachStarted.promise;

        connection.emitClose();
        delayedAttachment.resolve({
            detach() {
                detachCalls += 1;
            },
            input(data) {
                return { acceptedBytes: data.byteLength, status: "accepted" };
            },
            ping() {},
            resize() {},
            resumeOutput() {},
            signal: () => Promise.resolve("sent"),
            terminate: () => Promise.resolve(),
        });
        await flush();

        expect(attachCalls).toBe(1);
        expect(detachCalls).toBe(1);
        expect(connection.closeCalls).toBe(1);
        expect(connection.sent).toHaveLength(0);
        connection.emitClose();
        await flush();
        expect(detachCalls).toBe(1);
        await server.close();
    });

    test("preserves a real PTY when the peer closes while broker attachment is pending", async () => {
        const harness = safeOptions();
        const realBroker = realBrokerHarness();
        await realBroker.reserve();
        const server = await startTerminalBrokerServer({
            ...harness.options,
            broker: realBroker.broker,
        });
        const connection = new FakeConnection();
        connection.onSend = (data) => {
            if (decodeControl(data).type === "ready") connection.emitClose();
        };
        harness.lifecycle.onConnection?.(connection);

        connection.emit(
            encodeTerminalBrokerControl({
                owner,
                rawToken: realBroker.rawToken,
                sessionId,
                type: "attach",
            })
        );
        await flush();

        expect(connection.sent).toHaveLength(0);
        expect(connection.closeCalls).toBe(1);
        expect(realBroker.terminateCalls).toBe(0);
        expect(await realBroker.broker.getActive(owner)).toMatchObject({
            state: "awaiting-reconnect",
        });
        await server.close();
    });

    test("preserves replay when an established IPC send reports closed", async () => {
        const harness = safeOptions();
        const realBroker = realBrokerHarness();
        await realBroker.reserve();
        const server = await startTerminalBrokerServer({
            ...harness.options,
            broker: realBroker.broker,
        });
        const connection = new FakeConnection();
        harness.lifecycle.onConnection?.(connection);
        connection.emit(
            encodeTerminalBrokerControl({
                owner,
                rawToken: realBroker.rawToken,
                sessionId,
                type: "attach",
            })
        );
        await flush();
        connection.disposition = "closed";

        expect(realBroker.emitOutput(new Uint8Array([4, 5, 6]))).toBe("accepted");
        await flush();

        expect(connection.closeCalls).toBe(1);
        expect(realBroker.terminateCalls).toBe(0);
        expect(await realBroker.broker.getActive(owner)).toMatchObject({
            nextSequence: 2,
            replayAvailableFromSequence: 1,
            state: "awaiting-reconnect",
        });
        await server.close();
    });

    test("flushes backpressured PTY output and exit before closing worker IPC", async () => {
        const harness = safeOptions();
        const realBroker = realBrokerHarness();
        const closeScheduler = new ManualCloseScheduler();
        await realBroker.reserve();
        const server = await startTerminalBrokerServer({
            ...harness.options,
            broker: realBroker.broker,
            scheduler: closeScheduler,
        });
        const connection = new FakeConnection();
        harness.lifecycle.onConnection?.(connection);
        connection.emit(
            encodeTerminalBrokerControl({
                owner,
                rawToken: realBroker.rawToken,
                sessionId,
                type: "attach",
            })
        );
        await flush();
        expect(decodeControl(connection.sent[0] ?? new Uint8Array()).type).toBe("ready");
        connection.disposition = "backpressured";

        expect(realBroker.emitOutput(new Uint8Array([7, 8, 9]))).toBe("accepted");
        realBroker.emitExit({ exitCode: 0, signalCode: null });
        await flush();

        expect(connection.sent).toHaveLength(1);
        expect(connection.pending).toHaveLength(2);
        expect(connection.closeCalls).toBe(0);
        expect(closeScheduler.entries).toHaveLength(1);
        expect(closeScheduler.entries[0]?.delayMs).toBe(5000);

        connection.emitDrain();

        const outputDecoder = new TerminalBrokerFrameDecoder();
        expect(outputDecoder.push(connection.sent[1] ?? new Uint8Array())).toEqual([
            { data: new Uint8Array([7, 8, 9]), kind: "output", sequence: 1 },
        ]);
        expect(decodeControl(connection.sent[2] ?? new Uint8Array())).toMatchObject({
            exitCode: 0,
            type: "exit",
        });
        expect(connection.closeCalls).toBe(1);
        expect(closeScheduler.entries[0]?.cancelled).toBeTrue();
        closeScheduler.entries[0]?.callback();
        connection.emitClose();
        expect(connection.closeCalls).toBe(1);
        await server.close();
    });

    test("fails closed once when terminal completion cannot drain before timeout", async () => {
        const harness = safeOptions();
        const realBroker = realBrokerHarness();
        const closeScheduler = new ManualCloseScheduler();
        await realBroker.reserve();
        const server = await startTerminalBrokerServer({
            ...harness.options,
            broker: realBroker.broker,
            scheduler: closeScheduler,
        });
        const connection = new FakeConnection();
        harness.lifecycle.onConnection?.(connection);
        connection.emit(
            encodeTerminalBrokerControl({
                owner,
                rawToken: realBroker.rawToken,
                sessionId,
                type: "attach",
            })
        );
        await flush();
        connection.disposition = "backpressured";
        expect(realBroker.emitOutput(new Uint8Array([1]))).toBe("accepted");
        realBroker.emitExit({ exitCode: 0, signalCode: null });
        await flush();
        const timeout = closeScheduler.entries[0];
        expect(timeout?.delayMs).toBe(5000);

        timeout?.callback();
        connection.handlers?.onDrain();
        connection.emitClose();

        expect(timeout?.cancelled).toBeTrue();
        expect(connection.pending).toHaveLength(0);
        expect(connection.closeCalls).toBe(1);
        await server.close();
    });
});
