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

import {
    createSocketClient,
    type SocketClient,
    type SocketRequestOptions,
} from "../lib/socket/socketClient";
import { handleSocketMessage } from "../lib/socket/socketMessageRouter";
import { authStore } from "../stores/authStore";
import { getWebSocketUrl } from "../utils/websocket";

/** Represents OpenClaw socket context value. */
interface OpenClawSocketContextValue {
    isConnected: boolean;
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
    const [error, setError] = useState<string | undefined>(undefined);
    const [connectionId, setConnectionId] = useState(0);

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
                    setError(undefined);
                    setConnectionId((wasPrevious) => wasPrevious + 1);
                    void (async () => {
                        try {
                            await clientReference.current?.request("sessions.list");
                        } catch {
                            // Best-effort socket resync.
                        }
                    })();
                },
                onClose: () => {
                    setIsConnected(false);
                },
                onError: () => {
                    setError("WebSocket connection failed");
                },
                onMessage: (data) => {
                    try {
                        const connectionState = handleSocketMessage(data);
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
                    await client.request("sessions.list");
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
                    await clientReference.current?.request("sessions.list");
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
