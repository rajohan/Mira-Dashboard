interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
}

interface SocketMessage {
    type?: string;
    id?: string;
    ok?: boolean;
    payload?: unknown;
    error?: unknown;
}

interface SocketClientOptions {
    url: string;
    onOpen?: () => void;
    onClose?: () => void;
    onError?: () => void;
    onMessage?: (data: SocketMessage) => void;
}

export interface SocketClient {
    connect: () => void;
    disconnect: () => void;
    request: <T = unknown>(
        method: string,
        params?: Record<string, unknown>
    ) => Promise<T>;
    isOpen: () => boolean;
}

export function createSocketClient(options: SocketClientOptions): SocketClient {
    let ws: WebSocket | null = null;
    let shouldReconnect = true;
    let requestId = 0;
    const pendingRequests = new Map<string, PendingRequest>();

    const connect = () => {
        if (
            ws?.readyState === WebSocket.OPEN ||
            ws?.readyState === WebSocket.CONNECTING
        ) {
            return;
        }

        shouldReconnect = true;
        ws = new WebSocket(options.url);

        ws.addEventListener("open", () => {
            options.onOpen?.();
        });

        ws.addEventListener("message", (event) => {
            try {
                const data = JSON.parse(event.data) as SocketMessage;

                if (data.type === "res" && data.id) {
                    const pending = pendingRequests.get(data.id);
                    if (pending) {
                        pendingRequests.delete(data.id);
                        if (data.ok) {
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

        ws.addEventListener("close", () => {
            options.onClose?.();
            if (shouldReconnect) {
                setTimeout(() => {
                    if (shouldReconnect) {
                        connect();
                    }
                }, 2000);
            }
        });

        ws.addEventListener("error", () => {
            options.onError?.();
        });
    };

    const disconnect = () => {
        shouldReconnect = false;
        ws?.close(1000, "Intentional disconnect");
        ws = null;

        for (const pending of pendingRequests.values()) {
            pending.reject(new Error("WebSocket disconnected"));
        }
        pendingRequests.clear();
    };

    const request = <T = unknown>(
        method: string,
        params?: Record<string, unknown>
    ): Promise<T> => {
        return new Promise((resolve, reject) => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                reject(new Error("WebSocket not connected"));
                return;
            }

            const id = String(++requestId);
            pendingRequests.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject,
            });

            ws.send(
                JSON.stringify({
                    type: "req",
                    id,
                    method,
                    params,
                })
            );

            setTimeout(() => {
                if (pendingRequests.has(id)) {
                    pendingRequests.delete(id);
                    reject(new Error("Request timeout"));
                }
            }, 30_000);
        });
    };

    const isOpen = () => ws?.readyState === WebSocket.OPEN;

    return {
        connect,
        disconnect,
        request,
        isOpen,
    };
}
