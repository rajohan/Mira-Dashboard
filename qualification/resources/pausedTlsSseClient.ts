import {
    hasConnectedSseFrame,
    maximumPausedTlsSseHandshakeBytes,
} from "./pausedTlsSseHandshake.ts";

export { hasConnectedSseFrame } from "./pausedTlsSseHandshake.ts";

interface PausedClientState {
    close: ReturnType<typeof Promise.withResolvers<void>>;
    closeSettled: boolean;
    handshakeBytes: Buffer;
    ready: ReturnType<typeof Promise.withResolvers<void>>;
    readySettled: boolean;
    request: Buffer;
    requestOffset: number;
    socket?: Bun.Socket<PausedClientState>;
}

/** Controlled native TLS client that stops reading after the first SSE frame. */
export interface PausedTlsSseClient {
    close(): Promise<void>;
}

function failClient(socket: Bun.Socket<PausedClientState>, error: Error): void {
    socket.data.socket = socket;
    if (!socket.data.readySettled) {
        socket.data.readySettled = true;
        socket.data.ready.reject(error);
    }
    socket.terminate();
}

function requestTarget(url: URL): string {
    return `${url.pathname}${url.search}`;
}

function writePendingRequest(socket: Bun.Socket<PausedClientState>): void {
    const state = socket.data;
    while (state.requestOffset < state.request.byteLength) {
        const bytesWritten = socket.write(
            state.request,
            state.requestOffset,
            state.request.byteLength - state.requestOffset
        );
        if (bytesWritten < 0) {
            failClient(socket, new Error("Paused SSE client request socket closed"));
            return;
        }
        if (bytesWritten === 0) return;
        state.requestOffset += bytesWritten;
    }
    socket.flush();
}

async function closeSocketBeforeDeadline(
    socket: Bun.Socket<PausedClientState>,
    timeoutMs: number
): Promise<void> {
    if (!socket.data.closeSettled) socket.terminate();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
            () =>
                reject(
                    new Error(`Paused SSE client did not close within ${timeoutMs} ms`)
                ),
            timeoutMs
        );
    });
    try {
        await Promise.race([socket.data.close.promise, deadline]);
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Opens a CA-verified TLS socket and pauses reads immediately after tRPC connects.
 * @param publicUrl Stable HTTPS proxy URL.
 * @param certificateAuthority PEM certificate trusted only for this client.
 * @param cookie Qualification cookie required by the upstream server.
 * @param timeoutMs Maximum handshake and connected-frame wait.
 * @returns Paused native socket controlled by the caller.
 */
export async function openPausedTlsSseClient(
    publicUrl: URL,
    certificateAuthority: string,
    cookie: string,
    timeoutMs: number
): Promise<PausedTlsSseClient> {
    if (publicUrl.protocol !== "https:" || publicUrl.port.length === 0) {
        throw new TypeError("Paused SSE client requires an explicit HTTPS port");
    }
    if (/[\r\n]/u.test(cookie)) {
        throw new TypeError("Paused SSE client cookie must not contain CR or LF");
    }
    const endpoint = new URL("/trpc/events.stream", publicUrl);
    endpoint.searchParams.set("input", JSON.stringify({}));
    const request = Buffer.from(
        [
            `GET ${requestTarget(endpoint)} HTTP/1.1`,
            `Host: ${publicUrl.host}`,
            "Accept: text/event-stream",
            "Accept-Encoding: identity",
            `Cookie: ${cookie}`,
            "Connection: keep-alive",
            "",
            "",
        ].join("\r\n"),
        "utf8"
    );
    const ready = Promise.withResolvers<void>();
    const state: PausedClientState = {
        close: Promise.withResolvers<void>(),
        closeSettled: false,
        handshakeBytes: Buffer.alloc(0),
        ready,
        readySettled: false,
        request,
        requestOffset: 0,
    };
    let socket: Bun.Socket<PausedClientState> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abandoned = false;

    try {
        timeout = setTimeout(() => {
            if (state.readySettled) return;
            state.readySettled = true;
            state.ready.reject(
                new Error(`Paused SSE client did not connect within ${timeoutMs} ms`)
            );
            state.socket?.terminate();
        }, timeoutMs);
        const connectPromise = Bun.connect({
            data: state,
            hostname: publicUrl.hostname,
            port: Number(publicUrl.port),
            socket: {
                binaryType: "buffer",
                close(closedSocket, error) {
                    closedSocket.data.socket = closedSocket;
                    if (!closedSocket.data.closeSettled) {
                        closedSocket.data.closeSettled = true;
                        closedSocket.data.close.resolve();
                    }
                    if (!closedSocket.data.readySettled) {
                        closedSocket.data.readySettled = true;
                        closedSocket.data.ready.reject(
                            error ??
                                new Error(
                                    "Paused SSE client closed before its connected frame"
                                )
                        );
                    }
                },
                connectError(connectedSocket, error) {
                    failClient(connectedSocket, error);
                },
                data(connectedSocket, data) {
                    connectedSocket.data.socket = connectedSocket;
                    if (connectedSocket.data.readySettled) return;
                    const handshakeBytes = connectedSocket.data.handshakeBytes;
                    const remainingBytes =
                        maximumPausedTlsSseHandshakeBytes - handshakeBytes.byteLength;
                    const boundedData = data.subarray(
                        0,
                        Math.min(data.byteLength, remainingBytes)
                    );
                    connectedSocket.data.handshakeBytes = Buffer.concat(
                        [handshakeBytes, boundedData],
                        handshakeBytes.byteLength + boundedData.byteLength
                    );
                    try {
                        if (hasConnectedSseFrame(connectedSocket.data.handshakeBytes)) {
                            connectedSocket.pause();
                            connectedSocket.data.readySettled = true;
                            connectedSocket.data.ready.resolve();
                            return;
                        }
                        if (data.byteLength > boundedData.byteLength) {
                            throw new Error(
                                "Paused SSE client handshake exceeded its byte budget"
                            );
                        }
                    } catch (error) {
                        failClient(
                            connectedSocket,
                            error instanceof Error
                                ? error
                                : new Error("Paused SSE client parse failed", {
                                      cause: error,
                                  })
                        );
                    }
                },
                error(connectedSocket, error) {
                    failClient(connectedSocket, error);
                },
                drain(connectedSocket) {
                    connectedSocket.data.socket = connectedSocket;
                    writePendingRequest(connectedSocket);
                },
                open(connectedSocket) {
                    connectedSocket.data.socket = connectedSocket;
                    if (connectedSocket.data.readySettled || abandoned) {
                        connectedSocket.terminate();
                        return;
                    }
                    if (!connectedSocket.authorized) {
                        failClient(
                            connectedSocket,
                            connectedSocket.getAuthorizationError() ??
                                new Error("Paused SSE client TLS authorization failed")
                        );
                        return;
                    }
                    writePendingRequest(connectedSocket);
                },
                timeout(connectedSocket) {
                    failClient(
                        connectedSocket,
                        new Error(`Paused SSE client timed out after ${timeoutMs} ms`)
                    );
                },
            },
            tls: {
                ca: certificateAuthority,
                rejectUnauthorized: true,
                serverName: publicUrl.hostname,
            },
        });
        void connectPromise.then(
            (connectedSocket) => {
                if (abandoned) connectedSocket.terminate();
                return connectedSocket;
            },
            () => null
        );
        socket = await Promise.race([
            connectPromise,
            ready.promise.then(() => {
                if (state.socket === undefined) {
                    throw new Error("Paused SSE client connected without a socket");
                }
                return state.socket;
            }),
        ]);
        await ready.promise;
        const connectedSocket = socket;
        let closed = false;
        return {
            async close(): Promise<void> {
                if (closed) return;
                closed = true;
                await closeSocketBeforeDeadline(connectedSocket, timeoutMs);
            },
        };
    } catch (error) {
        abandoned = true;
        socket?.terminate();
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}
