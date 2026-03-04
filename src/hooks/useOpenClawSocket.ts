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
import { useAuthToken } from "../stores/authStore";
import { getWebSocketUrl } from "../utils/websocket";

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
}

const OpenClawSocketContext = createContext<OpenClawSocketContextValue | null>(null);

export function OpenClawSocketProvider({ children }: { children: ReactNode }) {
    const token = useAuthToken();
    const clientRef = useRef<SocketClient | null>(null);

    const [isConnected, setIsConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [connectionId, setConnectionId] = useState(0);

    const connect = () => {
        if (!token) {
            setError("No token provided");
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
                    } catch (error_) {
                        console.error("[WebSocket] Failed to process message:", error_);
                    }
                },
            });
        }

        clientRef.current.connect();
    };

    const disconnect = () => {
        clientRef.current?.disconnect();
        clientRef.current = null;
        setIsConnected(false);
    };

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
        if (token) {
            connect();
        } else {
            disconnect();
            setError(null);
        }
    }, [token]);

    useEffect(() => {
        if (!isConnected) {
            return;
        }

        const interval = setInterval(() => {
            if (!clientRef.current?.isOpen()) {
                return;
            }

            void clientRef.current.request("sessions.list").catch(() => {});
        }, 10_000);

        return () => clearInterval(interval);
    }, [isConnected, connectionId]);

    useEffect(() => {
        return () => {
            if (import.meta.env.PROD) {
                disconnect();
            }
        };
    }, []);

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
            },
        },
        children
    );
}

interface UseOpenClawSocketOptions {
    onConnect?: () => void;
    onDisconnect?: () => void;
}

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
