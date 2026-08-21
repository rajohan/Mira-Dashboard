import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { terminalBrokerReadChunkMaximumBytes } from "../../../shared/terminalBrokerProtocol.ts";
import type {
    TerminalBrokerClientChannel,
    TerminalBrokerClientTransport,
} from "./terminalBrokerClient.ts";

const defaultConnectTimeoutMs = 3000;
const outboundBufferMaximumBytes = 1024 * 1024;

export interface BunUnixTerminalBrokerTransportOptions {
    readonly connectTimeoutMs?: number;
    readonly expectedUserId?: number;
    readonly projectLocalDirectory: string;
    readonly socketPath: string;
}

export interface BunUnixTerminalBrokerSocketConnector {
    connect(input: {
        readonly onClose: () => void;
        readonly onData: (data: Uint8Array) => void;
        readonly onDrain: () => void;
        readonly socketPath: string;
    }): Promise<Bun.Socket<unknown>>;
}

function transportFailure(cause?: unknown): Error {
    return new Error(
        "Terminal broker transport failed",
        cause === undefined ? {} : { cause }
    );
}

function validateOptions(options: BunUnixTerminalBrokerTransportOptions): {
    readonly connectTimeoutMs: number;
    readonly expectedUserId: number;
} {
    const expectedUserId =
        options.expectedUserId ??
        (typeof process.getuid === "function" ? process.getuid() : -1);
    const connectTimeoutMs = options.connectTimeoutMs ?? defaultConnectTimeoutMs;
    if (
        !path.isAbsolute(options.projectLocalDirectory) ||
        !path.isAbsolute(options.socketPath) ||
        path.dirname(options.socketPath) !== options.projectLocalDirectory ||
        !Number.isSafeInteger(expectedUserId) ||
        expectedUserId < 0 ||
        !Number.isSafeInteger(connectTimeoutMs) ||
        connectTimeoutMs < 1 ||
        connectTimeoutMs > 30_000
    ) {
        throw transportFailure();
    }
    return { connectTimeoutMs, expectedUserId };
}

async function assertSocketSecurity(
    options: BunUnixTerminalBrokerTransportOptions,
    expectedUserId: number
): Promise<void> {
    try {
        const [directoryPath, directory, socket] = await Promise.all([
            realpath(options.projectLocalDirectory),
            lstat(options.projectLocalDirectory),
            lstat(options.socketPath),
        ]);
        if (
            directoryPath !== options.projectLocalDirectory ||
            !directory.isDirectory() ||
            directory.isSymbolicLink() ||
            directory.uid !== expectedUserId ||
            (directory.mode & 0o077) !== 0 ||
            !socket.isSocket() ||
            socket.isSymbolicLink() ||
            socket.uid !== expectedUserId ||
            socket.nlink !== 1 ||
            (socket.mode & 0o777) !== 0o600
        ) {
            throw transportFailure();
        }
    } catch (error) {
        throw transportFailure(error);
    }
}

export class BunTerminalBrokerClientChannel implements TerminalBrokerClientChannel {
    readonly #socket: Bun.Socket<unknown>;
    #closed = false;
    #handlers: Parameters<TerminalBrokerClientChannel["setHandlers"]>[0] = {
        onClose: () => {},
        onData: () => {},
        onDrain: () => {},
    };
    #pending = new Uint8Array();

    public constructor(socket: Bun.Socket<unknown>) {
        this.#socket = socket;
    }

    public close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#pending = new Uint8Array();
        try {
            this.#socket.close();
        } finally {
            this.#handlers.onClose();
        }
    }

    public notifyClose(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#pending = new Uint8Array();
        this.#handlers.onClose();
    }

    public notifyData(data: Uint8Array): void {
        if (!this.#closed) this.#handlers.onData(new Uint8Array(data));
    }

    public notifyDrain(): void {
        if (this.#closed) return;
        this.#flushPending();
        if (!this.#closed && this.#pending.byteLength === 0) this.#handlers.onDrain();
    }

    public pause(): void {
        if (!this.#closed) this.#socket.pause();
    }

    public resume(): void {
        if (!this.#closed) this.#socket.resume();
    }

    public send(data: Uint8Array): "accepted" | "backpressured" | "closed" {
        if (this.#closed) return "closed";
        if (this.#pending.byteLength > 0) {
            if (this.#pending.byteLength + data.byteLength > outboundBufferMaximumBytes) {
                this.close();
                return "closed";
            }
            const buffered = new Uint8Array(this.#pending.byteLength + data.byteLength);
            buffered.set(this.#pending);
            buffered.set(data, this.#pending.byteLength);
            this.#pending = buffered;
            return "backpressured";
        }
        const written = this.#socket.write(data);
        if (written < 0) {
            this.close();
            return "closed";
        }
        if (written === data.byteLength) return "accepted";
        this.#pending = data.slice(written);
        return "backpressured";
    }

    public setHandlers(
        handlers: Parameters<TerminalBrokerClientChannel["setHandlers"]>[0]
    ): void {
        this.#handlers = handlers;
    }

    #flushPending(): void {
        while (!this.#closed && this.#pending.byteLength > 0) {
            const written = this.#socket.write(this.#pending);
            if (written < 0) {
                this.close();
                return;
            }
            if (written === 0) return;
            this.#pending = this.#pending.slice(written);
        }
    }
}

const defaultSocketConnector: BunUnixTerminalBrokerSocketConnector = Object.freeze({
    connect(input: Parameters<BunUnixTerminalBrokerSocketConnector["connect"]>[0]) {
        return Bun.connect<{ readonly marker: "terminal-broker" }>({
            data: { marker: "terminal-broker" },
            socket: {
                binaryType: "uint8array",
                close: input.onClose,
                data(_socket, data) {
                    input.onData(data);
                },
                drain: input.onDrain,
                error: input.onClose,
            },
            unix: input.socketPath,
        });
    },
});

export async function connectBunTerminalBrokerChannel(
    socketPath: string,
    timeoutMs: number,
    connector: BunUnixTerminalBrokerSocketConnector = defaultSocketConnector,
    signal?: AbortSignal
): Promise<BunTerminalBrokerClientChannel> {
    if (signal?.aborted) throw transportFailure(signal.reason);
    let channel: BunTerminalBrokerClientChannel | undefined;
    let connection: Promise<Bun.Socket<unknown>> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
        connection = connector.connect({
            onClose: () => channel?.notifyClose(),
            onData: (data) => channel?.notifyData(data),
            onDrain: () => channel?.notifyDrain(),
            socketPath,
        });
        const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(transportFailure()), timeoutMs);
        });
        const aborted = new Promise<never>((_resolve, reject) => {
            if (signal === undefined) return;
            abort = () => reject(transportFailure(signal.reason));
            signal.addEventListener("abort", abort, { once: true });
        });
        const socket = await Promise.race([connection, deadline, aborted]);
        channel = new BunTerminalBrokerClientChannel(socket);
        return channel;
    } catch (error) {
        if (channel === undefined && connection !== undefined) {
            void connection.then(
                (socket) => {
                    try {
                        socket.close();
                    } catch {
                        // The abandoned connection has no remaining authority to retain.
                    }
                    return true;
                },
                () => false
            );
        } else {
            channel?.close();
        }
        throw transportFailure(error);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (abort !== undefined) signal?.removeEventListener("abort", abort);
    }
}

export async function requestBunTerminalBrokerResponse(
    channel: TerminalBrokerClientChannel,
    frame: Uint8Array
): Promise<readonly Uint8Array[]> {
    const chunks: Uint8Array[] = [];
    let settled = false;
    let total = 0;
    const closeChannel = (): void => {
        try {
            channel.close();
        } catch {
            // The transport failure remains authoritative over cleanup errors.
        }
    };
    try {
        const response = new Promise<readonly Uint8Array[]>((resolve, reject) => {
            channel.setHandlers({
                onClose() {
                    if (settled) return;
                    settled = true;
                    resolve(Object.freeze([...chunks]));
                },
                onData(data) {
                    if (settled) return;
                    if (data.byteLength > terminalBrokerReadChunkMaximumBytes - total) {
                        settled = true;
                        reject(transportFailure());
                        closeChannel();
                        return;
                    }
                    total += data.byteLength;
                    chunks.push(new Uint8Array(data));
                },
                onDrain: () => {},
            });
        });
        if (channel.send(frame) === "closed") throw transportFailure();
        return await response;
    } catch (error) {
        settled = true;
        throw transportFailure(error);
    } finally {
        closeChannel();
    }
}

/**
 * Creates the web-process Unix transport with owner/mode checks before every connect.
 * @returns A bounded client transport for the worker-owned terminal broker.
 */
export function createBunUnixTerminalBrokerTransport(
    options: BunUnixTerminalBrokerTransportOptions
): TerminalBrokerClientTransport {
    const { connectTimeoutMs, expectedUserId } = validateOptions(options);

    async function connect(signal?: AbortSignal) {
        await assertSocketSecurity(options, expectedUserId);
        return connectBunTerminalBrokerChannel(
            options.socketPath,
            connectTimeoutMs,
            defaultSocketConnector,
            signal
        );
    }

    return Object.freeze({
        connect,
        async request(frame: Uint8Array, signal?: AbortSignal) {
            const channel = await connect(signal);
            return requestBunTerminalBrokerResponse(channel, frame);
        },
    });
}
