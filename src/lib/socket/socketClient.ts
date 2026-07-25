import type { SocketEnvelope } from "../../types/socket";
import { handleUnauthorizedSession } from "../authBoundary";
import {
    dispatchSecurityVerificationRequired,
    isSecurityVerificationCode,
    waitForSecurityVerification,
} from "../securityVerification";
import { hasRecentUserActivity } from "../userActivity";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function normalizedRequestTimeoutMs(requestedTimeoutMs: number | undefined): number {
    return typeof requestedTimeoutMs === "number" &&
        Number.isFinite(requestedTimeoutMs) &&
        requestedTimeoutMs > 0
        ? Math.min(Math.max(Math.trunc(requestedTimeoutMs), 1), MAX_TIMER_DELAY_MS)
        : DEFAULT_REQUEST_TIMEOUT_MS;
}

/** Represents pending request. */
interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    retryAfterVerification?: () => Promise<unknown>;
    socket: WebSocket;
    timeout?: ReturnType<typeof setTimeout>;
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
    /** Leaves completion timing to the remote operation lifecycle. */
    shouldWaitIndefinitely?: boolean;
}

/** Represents socket client. */
export interface SocketClient {
    connect: () => void;
    disconnect: () => void;
    reconnect: () => void;
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
    const connectionWaiters = new Set<{
        reject: (reason: Error) => void;
        resolve: () => void;
        timeout: ReturnType<typeof setTimeout>;
    }>();

    const resolveConnectionWaiters = () => {
        for (const waiter of connectionWaiters) {
            clearTimeout(waiter.timeout);
            waiter.resolve();
        }
        connectionWaiters.clear();
    };

    const rejectConnectionWaiters = (message: string) => {
        for (const waiter of connectionWaiters) {
            clearTimeout(waiter.timeout);
            waiter.reject(new Error(message));
        }
        connectionWaiters.clear();
    };

    const waitForOpenSocket = (): Promise<void> => {
        if (ws?.readyState === WebSocket.OPEN) {
            return Promise.resolve();
        }
        if (!ws || ws.readyState !== WebSocket.CONNECTING) {
            connect();
        }
        if (!ws || ws.readyState !== WebSocket.CONNECTING) {
            return Promise.reject(new Error("WebSocket not connected"));
        }
        return new Promise((resolve, reject) => {
            const waiter = {
                reject,
                resolve,
                timeout: setTimeout(() => {
                    connectionWaiters.delete(waiter);
                    reject(new Error("WebSocket reconnect timeout"));
                }, DEFAULT_REQUEST_TIMEOUT_MS),
            };
            connectionWaiters.add(waiter);
        });
    };

    /** Removes one pending request and releases its local deadline. */
    const takePendingRequest = (id: string): PendingRequest | undefined => {
        const pending = pendingRequests.get(id);
        if (!pending) {
            return undefined;
        }
        pendingRequests.delete(id);
        if (pending.timeout !== undefined) {
            clearTimeout(pending.timeout);
        }
        return pending;
    };

    /** Rejects requests that cannot complete after the active socket closes. */
    const rejectPendingRequests = (socket?: WebSocket) => {
        for (const [id, pending] of pendingRequests) {
            if (socket && pending.socket !== socket) {
                continue;
            }
            takePendingRequest(id);
            pending.reject(new Error("WebSocket disconnected"));
        }
    };

    /** Performs connect. */
    function connect(): void {
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
            if (ws !== socket) {
                return;
            }
            resolveConnectionWaiters();
            options.onOpen?.();
        });

        socket.addEventListener("message", (event) => {
            try {
                const data = JSON.parse(event.data) as SocketEnvelope;

                if (data.type === "response" && data.id) {
                    const pending = takePendingRequest(data.id);
                    if (pending) {
                        if (data.isOk) {
                            pending.resolve(data.payload);
                        } else {
                            const verificationCode = data.code;
                            if (
                                isSecurityVerificationCode(verificationCode) &&
                                pending.retryAfterVerification
                            ) {
                                void (async () => {
                                    if (
                                        !(await waitForSecurityVerification(
                                            verificationCode
                                        ))
                                    ) {
                                        pending.reject(data.error);
                                        return;
                                    }
                                    try {
                                        await waitForOpenSocket();
                                        pending.resolve(
                                            await pending.retryAfterVerification?.()
                                        );
                                    } catch (error) {
                                        pending.reject(error);
                                    }
                                })();
                            } else {
                                if (isSecurityVerificationCode(verificationCode)) {
                                    dispatchSecurityVerificationRequired(
                                        verificationCode
                                    );
                                }
                                pending.reject(data.error);
                            }
                        }
                    }
                }

                options.onMessage?.(data);
            } catch (error_) {
                console.error("[WebSocket] Failed to parse message:", error_);
            }
        });

        socket.addEventListener("close", (event) => {
            rejectPendingRequests(socket);
            if (ws !== socket) {
                return;
            }
            if (event.code === 4401) {
                shouldReconnect = false;
                rejectConnectionWaiters("WebSocket authorization failed");
                handleUnauthorizedSession();
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
    }

    /** Performs disconnect. */
    const disconnect = () => {
        shouldReconnect = false;
        const socket = ws;
        ws = undefined;
        rejectPendingRequests();
        rejectConnectionWaiters("WebSocket disconnected");
        socket?.close(1000, "Intentional disconnect");
        options.onClose?.();
    };

    /** Reconnects so a rotated browser session cookie reaches the WebSocket handshake. */
    const reconnect = () => {
        disconnect();
        connect();
    };

    function requestAttempt<T>(
        method: string,
        parameters?: Record<string, unknown>,
        requestOptions?: SocketRequestOptions,
        canRetryAfterVerification = true
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            const socket = ws;
            if (!socket || socket.readyState !== WebSocket.OPEN) {
                reject(new Error("WebSocket not connected"));
                return;
            }

            const id = String(++requestId);
            const shouldWaitIndefinitely =
                requestOptions?.shouldWaitIndefinitely === true;
            const requestTimeoutMs = shouldWaitIndefinitely
                ? undefined
                : normalizedRequestTimeoutMs(requestOptions?.timeoutMs);
            const timeout =
                requestTimeoutMs === undefined
                    ? undefined
                    : setTimeout(() => {
                          const pending = takePendingRequest(id);
                          if (!pending) {
                              return;
                          }
                          pending.reject(new Error("Request timeout"));
                      }, requestTimeoutMs);
            pendingRequests.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject,
                ...(canRetryAfterVerification && {
                    retryAfterVerification: () =>
                        requestAttempt(method, parameters, requestOptions, false),
                }),
                socket,
                timeout,
            });

            try {
                socket.send(
                    JSON.stringify({
                        type: "req",
                        id,
                        method,
                        params: parameters,
                        timeoutMs: requestTimeoutMs,
                        userActivity: hasRecentUserActivity(),
                    })
                );
            } catch (error) {
                takePendingRequest(id)?.reject(error);
            }
        });
    }

    /** Performs request. */
    const request = <T = unknown>(
        method: string,
        parameters?: Record<string, unknown>,
        requestOptions?: SocketRequestOptions
    ): Promise<T> => requestAttempt<T>(method, parameters, requestOptions);

    /** Returns whether open. */
    const isOpen = () => ws?.readyState === WebSocket.OPEN;

    return {
        connect,
        disconnect,
        reconnect,
        request,
        isOpen,
    };
}
