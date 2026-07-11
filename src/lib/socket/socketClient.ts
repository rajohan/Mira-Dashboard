import type { SocketEnvelope } from "../../types/socket";

/** Represents pending request. */
interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
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

/** Represents socket client. */
export interface SocketClient {
    connect: () => void;
    disconnect: () => void;
    request: <T = unknown>(
        method: string,
        parameters?: Record<string, unknown>
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
    const rejectPendingRequests = () => {
        for (const pending of pendingRequests.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error("WebSocket disconnected"));
        }
        pendingRequests.clear();
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
            if (ws !== socket) {
                return;
            }
            rejectPendingRequests();
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
        parameters?: Record<string, unknown>
    ): Promise<T> => {
        return new Promise((resolve, reject) => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
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
            }, 30_000);
            pendingRequests.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject,
                timeout,
            });

            ws.send(
                JSON.stringify({
                    type: "req",
                    id,
                    method,
                    params: parameters,
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
