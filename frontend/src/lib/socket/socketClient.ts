import {
    type DashboardSocketRequest,
    parseSocketEnvelope,
    type SocketEnvelope,
} from "../../../../contracts/socket";
import { recoverOrHandleUnauthorizedSession } from "../authBoundary";
import { isBrowserPollingAllowed, refreshPolicy } from "../refreshPolicy";
import {
    dispatchSecurityVerificationRequired,
    isSecurityVerificationCode,
    SecurityVerificationCancelledError,
    waitForSecurityVerificationOutcome,
} from "../securityVerification";
import { hasRecentUserActivity } from "../userActivity";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.2;

/**
 * Returns bounded exponential reconnect delay with symmetric jitter.
 * @param attempt Attempt value.
 * @param random Random value.
 * @returns bounded exponential reconnect delay with symmetric jitter.
 */
export function socketReconnectDelayMs(
    attempt: number,
    random: () => number = Math.random
): number {
    const normalizedAttempt = Math.max(0, Math.min(10, Math.trunc(attempt)));
    const exponentialDelay = Math.min(
        refreshPolicy.live * 2 ** normalizedAttempt,
        MAX_RECONNECT_DELAY_MS
    );
    const randomValue = Math.min(1, Math.max(0, random()));
    const jitterMultiplier =
        1 - RECONNECT_JITTER_RATIO + randomValue * RECONNECT_JITTER_RATIO * 2;
    return Math.min(
        MAX_RECONNECT_DELAY_MS,
        Math.max(250, Math.round(exponentialDelay * jitterMultiplier))
    );
}

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
    requestOptions?: SocketRequestOptions;
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

/**
 * Creates socket client.
 * @returns Created socket client.
 */
export function createSocketClient(options: SocketClientOptions): SocketClient {
    let ws: WebSocket | undefined;
    let shouldReconnect = true;
    let isRecoveringAuthorization = false;
    let requestId = 0;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const pendingRequests = new Map<string, PendingRequest>();
    const connectionWaiters = new Set<{
        reject: (reason: Error) => void;
        resolve: () => void;
        timeout?: ReturnType<typeof setTimeout>;
    }>();

    const resolveConnectionWaiters = () => {
        for (const waiter of connectionWaiters) {
            if (waiter.timeout !== undefined) {
                clearTimeout(waiter.timeout);
            }
            waiter.resolve();
        }
        connectionWaiters.clear();
    };

    const rejectConnectionWaiters = (message: string) => {
        for (const waiter of connectionWaiters) {
            if (waiter.timeout !== undefined) {
                clearTimeout(waiter.timeout);
            }
            waiter.reject(new Error(message));
        }
        connectionWaiters.clear();
    };

    const clearReconnectTimer = () => {
        if (reconnectTimer === undefined) return;
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
    };

    const scheduleReconnect = () => {
        if (
            !shouldReconnect ||
            reconnectTimer !== undefined ||
            !isBrowserPollingAllowed()
        ) {
            return;
        }
        const delayMs = socketReconnectDelayMs(reconnectAttempt);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            if (shouldReconnect && isBrowserPollingAllowed()) connect();
        }, delayMs);
    };

    const waitForOpenSocket = (requestOptions?: SocketRequestOptions): Promise<void> => {
        if (ws?.readyState === WebSocket.OPEN) {
            return Promise.resolve();
        }
        if (!shouldReconnect && !isRecoveringAuthorization) {
            return Promise.reject(new Error("WebSocket authorization failed"));
        }
        if (shouldReconnect && (!ws || ws.readyState !== WebSocket.CONNECTING)) {
            connect();
        }
        if (
            !isRecoveringAuthorization &&
            (!ws || ws.readyState !== WebSocket.CONNECTING)
        ) {
            return Promise.reject(new Error("WebSocket not connected"));
        }
        const reconnectTimeoutMs =
            requestOptions?.shouldWaitIndefinitely === true
                ? undefined
                : normalizedRequestTimeoutMs(requestOptions?.timeoutMs);
        return new Promise((resolve, reject) => {
            const waiter: {
                reject: (reason: Error) => void;
                resolve: () => void;
                timeout?: ReturnType<typeof setTimeout>;
            } = {
                reject,
                resolve,
            };
            if (reconnectTimeoutMs !== undefined) {
                waiter.timeout = setTimeout(() => {
                    connectionWaiters.delete(waiter);
                    reject(new Error("WebSocket reconnect timeout"));
                }, reconnectTimeoutMs);
            }
            connectionWaiters.add(waiter);
        });
    };

    /**
     * Removes one pending request and releases its local deadline.
     * @param id Resource identifier.
     * @returns Take pending request result.
     */
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
        isRecoveringAuthorization = false;
        if (!isBrowserPollingAllowed()) return;
        clearReconnectTimer();
        const socket = new WebSocket(options.url);
        ws = socket;

        socket.addEventListener("open", () => {
            if (ws !== socket) {
                return;
            }
            reconnectAttempt = 0;
            clearReconnectTimer();
            resolveConnectionWaiters();
            options.onOpen?.();
        });

        socket.addEventListener("message", (event) => {
            if (ws !== socket) {
                return;
            }
            try {
                const messageData: unknown = event.data;
                if (typeof messageData !== "string") {
                    throw new TypeError("Dashboard WebSocket messages must be text");
                }
                const parsedMessage: unknown = JSON.parse(messageData);
                const data = parseSocketEnvelope(parsedMessage);

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
                                    const verificationOutcome =
                                        await waitForSecurityVerificationOutcome(
                                            verificationCode
                                        );
                                    if (verificationOutcome !== "verified") {
                                        pending.reject(
                                            verificationOutcome === "cancelled"
                                                ? new SecurityVerificationCancelledError(
                                                      verificationCode
                                                  )
                                                : data.error
                                        );
                                        return;
                                    }
                                    try {
                                        await waitForOpenSocket(pending.requestOptions);
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
            options.onClose?.();
            if (event.code === 4401) {
                shouldReconnect = false;
                isRecoveringAuthorization = true;
                void (async () => {
                    const isRecovered = await recoverOrHandleUnauthorizedSession();
                    if (ws !== socket) {
                        return;
                    }
                    isRecoveringAuthorization = false;
                    if (!isRecovered) {
                        rejectConnectionWaiters("WebSocket authorization failed");
                        return;
                    }
                    shouldReconnect = true;
                    connect();
                })();
                return;
            }
            scheduleReconnect();
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
        isRecoveringAuthorization = false;
        reconnectAttempt = 0;
        clearReconnectTimer();
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
                requestOptions,
                ...(canRetryAfterVerification && {
                    retryAfterVerification: () =>
                        requestAttempt(method, parameters, requestOptions, false),
                }),
                socket,
                timeout,
            });

            try {
                const frame = {
                    type: "req",
                    id,
                    method,
                    params: parameters,
                    timeoutMs: requestTimeoutMs,
                    userActivity: hasRecentUserActivity(),
                } satisfies DashboardSocketRequest;
                socket.send(JSON.stringify(frame));
            } catch (error) {
                takePendingRequest(id)?.reject(error);
            }
        });
    }

    /**
     * Performs request.
     * @param method Method value.
     * @param parameters Parameters value.
     * @param requestOptions Request options value.
     * @returns Request result.
     */
    const request = <T = unknown>(
        method: string,
        parameters?: Record<string, unknown>,
        requestOptions?: SocketRequestOptions
    ): Promise<T> => requestAttempt<T>(method, parameters, requestOptions);

    /**
     * Returns whether open.
     * @returns Whether open.
     */
    const isOpen = () => ws?.readyState === WebSocket.OPEN;

    return {
        connect,
        disconnect,
        reconnect,
        request,
        isOpen,
    };
}
