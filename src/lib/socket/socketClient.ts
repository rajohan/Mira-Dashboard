import type { SocketEnvelope } from "../../types/socket";

/** Represents pending request. */
interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    socket: WebSocket;
    timeout: ReturnType<typeof setTimeout>;
}

/** Represents socket client options. */
interface SocketClientOptions {
    url: string;
    onOpen?: () => void;
    onClose?: () => void;
    onError?: () => void;
    onMessage?: (data: SocketEnvelope) => void;
}

/** Configures one socket request without changing the client-wide defaults. */
export interface SocketRequestOptions {
    timeoutMs?: number;
}

/** Represents socket client. */
export interface SocketClient {
    connect: () => void;
    disconnect: () => void;
    request: <T = unknown>(
        method: string,
        parameters?: Record<string, unknown>,
        options?: SocketRequestOptions
    ) => Promise<T>;
    isOpen: () => boolean;
}

/** Creates socket client. */
export function createSocketClient(options: SocketClientOptions): SocketClient {
    let ws: WebSocket | undefined;
    let shouldReconnect = true;
    let requestId = 0;
    const pendingRequests = new Map<string, PendingRequest>();

    /** Rejects requests that cannot complete after the active socket closes. */
    const rejectPendingRequests = (socket?: WebSocket) => {
        for (const [id, pending] of pendingRequests) {
            if (socket && pending.socket !== socket) {
                continue;
            }
            pendingRequests.delete(id);
            clearTimeout(pending.timeout);
            pending.reject(new Error("WebSocket disconnected"));
        }
    };

    /** Performs connect. */
    const connect = () => {
        if (
            ws?.readyState === WebSocket.OPEN ||
            ws?.readyState === WebSocket.CONNECTING
        ) {
            return;
        }

        shouldReconnect = true;
        const socket = new WebSocket(options.url);
        ws = socket;

        socket.addEventListener("open", () => {
            options.onOpen?.();
        });

        socket.addEventListener("message", (event) => {
            try {
                const data = JSON.parse(event.data) as SocketEnvelope;

                if (data.type === "response" && data.id) {
                    const pending = pendingRequests.get(data.id);
                    if (pending) {
                        pendingRequests.delete(data.id);
                        clearTimeout(pending.timeout);
                        if (data.isOk) {
                            pending.resolve(data.payload);
                        } else {
                            pending.reject(data.error);
                        }
                    }
                }

                options.onMessage?.(data);
            } catch (error_) {
                console.error("[WebSocket] Failed to parse message:", error_);
            }
        });

        socket.addEventListener("close", () => {
            rejectPendingRequests(socket);
            if (ws !== socket) {
                return;
            }
            options.onClose?.();
            if (shouldReconnect) {
                setTimeout(() => {
                    if (shouldReconnect) {
                        connect();
                    }
                }, 2000);
            }
        });

        socket.addEventListener("error", () => {
            if (ws !== socket) {
                return;
            }
            options.onError?.();
        });
    };

    /** Performs disconnect. */
    const disconnect = () => {
        shouldReconnect = false;
        const socket = ws;
        ws = undefined;
        rejectPendingRequests();
        socket?.close(1000, "Intentional disconnect");
        options.onClose?.();
    };

    /** Performs request. */
    const request = <T = unknown>(
        method: string,
        parameters?: Record<string, unknown>,
        requestOptions?: SocketRequestOptions
    ): Promise<T> => {
        return new Promise((resolve, reject) => {
            const socket = ws;
            if (!socket || socket.readyState !== WebSocket.OPEN) {
                reject(new Error("WebSocket not connected"));
                return;
            }

            const id = String(++requestId);
            const timeout = setTimeout(() => {
                if (!pendingRequests.has(id)) {
                    return;
                }

                pendingRequests.delete(id);
                reject(new Error("Request timeout"));
            }, requestOptions?.timeoutMs ?? 30_000);
            pendingRequests.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject,
                socket,
                timeout,
            });

            socket.send(
                JSON.stringify({
                    type: "req",
                    id,
                    method,
                    params: parameters,
                    timeoutMs: requestOptions?.timeoutMs,
                })
            );
        });
    };

    /** Returns whether open. */
    const isOpen = () => ws?.readyState === WebSocket.OPEN;

    return {
        connect,
        disconnect,
        request,
        isOpen,
    };
}
