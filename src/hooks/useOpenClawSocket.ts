import { useSelector } from "@tanstack/react-store";
import {
    createContext,
    createElement,
    type ReactNode,
    useContext,
    useEffect,
    useRef,
    useState,
} from "react";

import { replaceSessionsFromWebSocket } from "../collections/sessions";
import {
    createSocketClient,
    type SocketClient,
    type SocketRequestOptions,
} from "../lib/socket/socketClient";
import { handleSocketMessage } from "../lib/socket/socketMessageRouter";
import { authStore } from "../stores/authStore";
import { isSocketEnvelope, readSessionsResponsePayload } from "../types/socket";
import { getWebSocketUrl } from "../utils/websocket";

/** Represents OpenClaw socket context value. */
interface OpenClawSocketContextValue {
    isConnected: boolean;
    hasConfirmedSessionList: boolean;
    error: string | undefined;
    connectionId: number;
    connect: () => void;
    disconnect: () => void;
    request: <T = unknown>(
        method: string,
        parameters?: Record<string, unknown>,
        options?: SocketRequestOptions
    ) => Promise<T>;
    subscribe: (listener: (data: unknown) => void) => () => void;
}

const OpenClawSocketContext = createContext<OpenClawSocketContextValue | undefined>(
    undefined
);

/** Provides OpenClaw socket state. */
export function OpenClawSocketProvider({ children }: { children: ReactNode }) {
    const isAuthenticated = useSelector(authStore, (state) => state.isAuthenticated);
    const clientReference = useRef<SocketClient | undefined>(undefined);
    const listenersReference = useRef(new Set<(data: unknown) => void>());

    const [isConnected, setIsConnected] = useState(false);
    const [hasConfirmedSessionList, setHasConfirmedSessionList] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const [connectionId, setConnectionId] = useState(0);

    /** Applies only the result of a request known to be sessions.list. */
    const applySessionsListResponse = (client: SocketClient, payload: unknown) => {
        if (clientReference.current !== client) {
            return;
        }
        const sessions = readSessionsResponsePayload(payload);
        if (sessions === undefined) {
            return;
        }
        replaceSessionsFromWebSocket(sessions);
        setHasConfirmedSessionList(true);
    };

    /** Performs connect. */
    const connect = () => {
        if (!isAuthenticated) {
            setError("Not authenticated");
            return;
        }

        if (!clientReference.current) {
            clientReference.current = createSocketClient({
                url: getWebSocketUrl(),
                onOpen: () => {
                    setIsConnected(true);
                    setHasConfirmedSessionList(false);
                    setError(undefined);
                    setConnectionId((wasPrevious) => wasPrevious + 1);
                    const client = clientReference.current;
                    if (!client) {
                        return;
                    }
                    void (async () => {
                        try {
                            const payload = await client.request("sessions.list");
                            applySessionsListResponse(client, payload);
                        } catch {
                            // Best-effort socket resync.
                        }
                    })();
                },
                onClose: () => {
                    setIsConnected(false);
                    setHasConfirmedSessionList(false);
                },
                onError: () => {
                    setError("WebSocket connection failed");
                },
                onMessage: (data) => {
                    try {
                        const connectionState = handleSocketMessage(data);
                        const envelope = isSocketEnvelope(data) ? data : undefined;
                        const hasSessionList = Boolean(
                            envelope &&
                            envelope.type === "sessions" &&
                            Array.isArray(envelope.sessions)
                        );
                        if (
                            connectionState === false ||
                            envelope?.type === "connected" ||
                            envelope?.type === "disconnected"
                        ) {
                            setHasConfirmedSessionList(false);
                        } else if (hasSessionList) {
                            setHasConfirmedSessionList(true);
                        }
                        if (connectionState !== undefined) {
                            setIsConnected(connectionState);
                        }
                        for (const listener of listenersReference.current) {
                            listener(data);
                        }
                    } catch (error_) {
                        console.error("[WebSocket] Failed to process message:", error_);
                    }
                },
            });
        }

        clientReference.current.connect();
    };

    /** Performs disconnect. */
    const disconnect = () => {
        clientReference.current?.disconnect();
        clientReference.current = undefined;
        setIsConnected(false);
        setHasConfirmedSessionList(false);
    };

    /** Performs request. */
    const request = <T = unknown>(
        method: string,
        parameters?: Record<string, unknown>,
        options?: SocketRequestOptions
    ): Promise<T> => {
        if (!clientReference.current) {
            return Promise.reject(new Error("WebSocket not connected"));
        }

        return clientReference.current.request<T>(method, parameters, options);
    };

    useEffect(() => {
        if (isAuthenticated) {
            connect();
        } else {
            disconnect();
            setError(undefined);
        }
    }, [isAuthenticated]);

    useEffect(() => {
        if (!isConnected) {
            return;
        }

        const interval = setInterval(() => {
            if (!clientReference.current?.isOpen()) {
                return;
            }

            const client = clientReference.current;
            void (async () => {
                try {
                    const payload = await client.request("sessions.list");
                    applySessionsListResponse(client, payload);
                } catch {
                    if (clientReference.current !== client) {
                        return;
                    }

                    setIsConnected(false);
                    client.disconnect();
                    client.connect();
                }
            })();
        }, 10_000);

        return () => clearInterval(interval);
    }, [isConnected, connectionId]);

    useEffect(() => {
        if (!isAuthenticated) {
            return;
        }

        /** Performs resync visible socket. */
        const resyncVisibleSocket = () => {
            if (document.visibilityState === "hidden") {
                return;
            }

            if (!clientReference.current?.isOpen()) {
                connect();
                return;
            }

            void (async () => {
                try {
                    const client = clientReference.current;
                    if (!client) {
                        return;
                    }
                    const payload = await client.request("sessions.list");
                    applySessionsListResponse(client, payload);
                } catch {
                    // Best-effort socket resync.
                }
            })();
        };

        document.addEventListener("visibilitychange", resyncVisibleSocket);
        window.addEventListener("focus", resyncVisibleSocket);
        addEventListener("online", resyncVisibleSocket);

        return () => {
            document.removeEventListener("visibilitychange", resyncVisibleSocket);
            window.removeEventListener("focus", resyncVisibleSocket);
            removeEventListener("online", resyncVisibleSocket);
        };
    }, [isAuthenticated]);

    useEffect(() => {
        return () => {
            clientReference.current?.disconnect();
            clientReference.current = undefined;
        };
    }, []);

    /** Performs subscribe. */
    const subscribe = (listener: (data: unknown) => void) => {
        listenersReference.current.add(listener);
        return () => {
            listenersReference.current.delete(listener);
        };
    };

    return createElement(
        OpenClawSocketContext.Provider,
        {
            value: {
                isConnected,
                hasConfirmedSessionList,
                error,
                connectionId,
                connect,
                disconnect,
                request,
                subscribe,
            },
        },
        children
    );
}

/** Represents use OpenClaw socket options. */
interface UseOpenClawSocketOptions {
    onConnect?: () => void;
    onDisconnect?: () => void;
}

/** Provides OpenClaw socket. */
export function useOpenClawSocket(options?: UseOpenClawSocketOptions) {
    const context = useContext(OpenClawSocketContext);

    if (!context) {
        throw new Error("useOpenClawSocket must be used within OpenClawSocketProvider");
    }

    const { onConnect, onDisconnect } = options || {};

    useEffect(() => {
        if (context.isConnected) {
            onConnect?.();
        }
    }, [context.isConnected, onConnect]);

    useEffect(() => {
        if (!context.isConnected) {
            onDisconnect?.();
        }
    }, [context.isConnected, onDisconnect]);

    return context;
}
