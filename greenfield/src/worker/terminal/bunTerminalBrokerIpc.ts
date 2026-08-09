import type { Stats } from "node:fs";
import { chmod, lstat, realpath, unlink } from "node:fs/promises";

import type {
    TerminalBrokerByteConnection,
    TerminalBrokerIpcLifecycle,
    TerminalBrokerSocketMetadata,
    TerminalBrokerSocketPathOperations,
} from "./terminalBrokerServer.ts";

const outboundBufferMaximumBytes = 1024 * 1024;
const staleProbeTimeoutMs = 500;

interface BunTerminalBrokerSocketData {
    connection?: BunTerminalBrokerByteConnection;
    marker: "terminal-broker";
}

class BunTerminalBrokerByteConnection implements TerminalBrokerByteConnection {
    readonly #socket: Bun.Socket<unknown>;
    #closed = false;
    #handlers: Parameters<TerminalBrokerByteConnection["setHandlers"]>[0] = {
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
        this.#socket.close();
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
        while (this.#pending.byteLength > 0) {
            const written = this.#socket.write(this.#pending);
            if (written < 0) {
                this.close();
                return;
            }
            if (written === 0) return;
            this.#pending = this.#pending.slice(written);
        }
        this.#handlers.onDrain();
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
        handlers: Parameters<TerminalBrokerByteConnection["setHandlers"]>[0]
    ): void {
        this.#handlers = handlers;
    }
}

/**
 * Creates the Bun Unix listener adapter retained exclusively by the worker process.
 * @returns Worker-owned terminal broker IPC lifecycle.
 */
export function createBunTerminalBrokerIpcLifecycle(): TerminalBrokerIpcLifecycle {
    return Object.freeze({
        listen({
            onConnection,
            socketPath,
        }: Parameters<TerminalBrokerIpcLifecycle["listen"]>[0]) {
            const listener = Bun.listen<BunTerminalBrokerSocketData>({
                data: { marker: "terminal-broker" },
                socket: {
                    binaryType: "uint8array",
                    close(socket) {
                        socket.data.connection?.notifyClose();
                    },
                    data(socket, data) {
                        socket.data.connection?.notifyData(data);
                    },
                    drain(socket) {
                        socket.data.connection?.notifyDrain();
                    },
                    open(socket) {
                        const connection = new BunTerminalBrokerByteConnection(socket);
                        socket.data.connection = connection;
                        onConnection(connection);
                    },
                },
                unix: socketPath,
            });
            return Promise.resolve(
                Object.freeze({
                    close() {
                        listener.stop(true);
                        return Promise.resolve();
                    },
                })
            );
        },
    });
}

function socketKind(status: Stats): TerminalBrokerSocketMetadata["kind"] {
    if (status.isDirectory()) return "directory";
    if (status.isSocket()) return "socket";
    return "other";
}

function socketMetadata(status: Stats): TerminalBrokerSocketMetadata {
    return {
        kind: socketKind(status),
        linkCount: status.nlink,
        mode: status.mode & 0o777,
        ownerUserId: status.uid,
    };
}

function errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

async function probeSocket(socketPath: string): Promise<"active" | "stale"> {
    let socket: Bun.Socket<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error("probe timeout")),
                staleProbeTimeoutMs
            );
        });
        socket = await Promise.race([
            Bun.connect({ socket: { data() {} }, unix: socketPath }),
            timeout,
        ]);
        return "active";
    } catch (error) {
        const code = errorCode(error);
        return code === "ECONNREFUSED" || code === "ENOENT" ? "stale" : "active";
    } finally {
        if (timer !== undefined) clearTimeout(timer);
        socket?.close();
    }
}

/**
 * Creates rootless filesystem operations for the worker's fail-closed socket lifecycle.
 * @returns Concrete socket path operations.
 */
export function createTerminalBrokerSocketPathOperations(): TerminalBrokerSocketPathOperations {
    return Object.freeze({
        chmod,
        async inspect(targetPath: string) {
            try {
                return socketMetadata(await lstat(targetPath));
            } catch (error) {
                if (errorCode(error) === "ENOENT") return;
                throw error;
            }
        },
        probe: probeSocket,
        realpath,
        remove: unlink,
    });
}
