import {
    createContext,
    createElement,
    type ReactNode,
    useContext,
    useEffect,
    useRef,
    useState,
} from "react";

import { createSocketClient, type SocketClient } from "../lib/socket/socketClient";
import { handleSocketMessage } from "../lib/socket/socketMessageRouter";
import { useIsAuthenticated } from "../stores/authStore";
import { getWebSocketUrl } from "../utils/websocket";

/** Represents OpenClaw socket context value. */
interface OpenClawSocketContextValue {
    isConnected: boolean;
    error: string | null;
    connectionId: number;
    connect: () => void;
    disconnect: () => void;
    request: <T = unknown>(
        method: string,
        params?: Record<string, unknown>
    ) => Promise<T>;
    subscribe: (listener: (data: unknown) => void) => () => void;
}

const OpenClawSocketContext = createContext<OpenClawSocketContextValue | null>(null);

/** Performs OpenClaw socket provIDer. */
export function OpenClawSocketProvider({ children }: { children: ReactNode }) {
    const isAuthenticated = useIsAuthenticated();
    const clientRef = useRef<SocketClient | null>(null);
    const listenersRef = useRef(new Set<(data: unknown) => void>());

    const [isConnected, setIsConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [connectionId, setConnectionId] = useState(0);

    /** Performs connect. */
    const connect = () => {
        if (!isAuthenticated) {
            setError("Not authenticated");
            return;
        }

        if (!clientRef.current) {
            clientRef.current = createSocketClient({
                url: getWebSocketUrl(),
                onOpen: () => {
                    setIsConnected(true);
                    setError(null);
                    setConnectionId((previous) => previous + 1);
                    void clientRef.current?.request("sessions.list").catch(() => {});
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
                        if (connectionState !== null) {
                            setIsConnected(connectionState);
                        }
                        for (const listener of listenersRef.current) {
                            listener(data);
                        }
                    } catch (error_) {
                        console.error("[WebSocket] Failed to process message:", error_);
                    }
                },
            });
        }

        clientRef.current.connect();
    };

    /** Performs disconnect. */
    const disconnect = () => {
        clientRef.current?.disconnect();
        clientRef.current = null;
        setIsConnected(false);
    };

    /** Performs request. */
    const request = <T = unknown>(
        method: string,
        params?: Record<string, unknown>
    ): Promise<T> => {
        if (!clientRef.current) {
            return Promise.reject(new Error("WebSocket not connected"));
        }

        return clientRef.current.request<T>(method, params);
    };

    useEffect(() => {
        if (isAuthenticated) {
            connect();
        } else {
            disconnect();
            setError(null);
        }
    }, [isAuthenticated]);

    useEffect(() => {
        if (!isConnected) {
            return;
        }

        const interval = setInterval(() => {
            if (!clientRef.current?.isOpen()) {
                return;
            }

            const client = clientRef.current;
            void client.request("sessions.list").catch(() => {
                if (clientRef.current !== client) {
                    return;
                }

                setIsConnected(false);
                client.disconnect();
                client.connect();
            });
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

            if (!clientRef.current?.isOpen()) {
                connect();
                return;
            }

            void clientRef.current.request("sessions.list").catch(() => {});
        };

        document.addEventListener("visibilitychange", resyncVisibleSocket);
        window.addEventListener("focus", resyncVisibleSocket);
        window.addEventListener("online", resyncVisibleSocket);

        return () => {
            document.removeEventListener("visibilitychange", resyncVisibleSocket);
            window.removeEventListener("focus", resyncVisibleSocket);
            window.removeEventListener("online", resyncVisibleSocket);
        };
    }, [isAuthenticated]);

    useEffect(() => {
        return () => {
            clientRef.current?.disconnect();
            clientRef.current = null;
        };
    }, []);

    /** Performs subscribe. */
    const subscribe = (listener: (data: unknown) => void) => {
        listenersRef.current.add(listener);
        return () => {
            listenersRef.current.delete(listener);
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
