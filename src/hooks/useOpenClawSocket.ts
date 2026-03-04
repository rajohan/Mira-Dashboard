import {
    createContext,
    createElement,
    type ReactNode,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";

import { writeAgentsFromWebSocket } from "../collections/agents";
import { writeLogFromWebSocket } from "../collections/logs";
import { writeSessionsFromWebSocket } from "../collections/sessions";
import { useAuthToken } from "../stores/authStore";
import type { AgentInfo, Session } from "../types/session";
import { getWebSocketUrl } from "../utils/websocket";

interface WsStateMessage {
    type: "state";
    gatewayConnected?: boolean;
    sessions?: Session[];
}

interface WsConnectedMessage {
    type: "connected";
    gatewayConnected?: boolean;
}

interface WsDisconnectedMessage {
    type: "disconnected";
}

interface WsSessionsMessage {
    type: "sessions";
    sessions?: Session[];
}

interface WsEventMessage {
    type: "event";
    event?: string;
    payload?: unknown;
}

interface WsLogMessage {
    type: "log";
    line?: string;
}

interface WsResponseMessage {
    type: "res";
    id?: string;
    ok?: boolean;
    payload?: unknown;
    error?: string;
}

type OpenClawMessage =
    | WsStateMessage
    | WsConnectedMessage
    | WsDisconnectedMessage
    | WsSessionsMessage
    | WsEventMessage
    | WsLogMessage
    | WsResponseMessage;

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
}

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

function parseOpenClawMessage(rawData: unknown): OpenClawMessage | null {
    if (typeof rawData !== "string") {
        return null;
    }

    const parsed = JSON.parse(rawData) as { type?: string } & Record<string, unknown>;
    if (!parsed.type) {
        return null;
    }

    return parsed as OpenClawMessage;
}

export function OpenClawSocketProvider({ children }: { children: ReactNode }) {
    const token = useAuthToken();
    const wsRef = useRef<WebSocket | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [connectionId, setConnectionId] = useState(0);
    const requestIdRef = useRef(0);
    const pendingRequestsRef = useRef<Map<string, PendingRequest>>(new Map());
    const shouldReconnectRef = useRef(true);

    const connect = useCallback(() => {
        if (
            wsRef.current?.readyState === WebSocket.OPEN ||
            wsRef.current?.readyState === WebSocket.CONNECTING
        ) {
            return;
        }

        if (!token) {
            setError("No token provided");
            return;
        }

        shouldReconnectRef.current = true;
        const wsUrl = getWebSocketUrl();

        try {
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;

            ws.addEventListener("open", () => {
                setIsConnected(true);
                setError(null);
                setConnectionId((previous) => previous + 1);

                ws.send(
                    JSON.stringify({
                        type: "req",
                        method: "sessions.list",
                        id: Date.now().toString(),
                    })
                );
            });

            ws.onmessage = (event) => {
                try {
                    const data = parseOpenClawMessage(event.data);
                    if (!data) {
                        return;
                    }

                    switch (data.type) {
                        case "state": {
                            setIsConnected(data.gatewayConnected ?? true);
                            if (data.sessions) {
                                writeSessionsFromWebSocket(data.sessions);
                            }
                            break;
                        }
                        case "connected": {
                            setIsConnected(data.gatewayConnected ?? true);
                            break;
                        }
                        case "disconnected": {
                            setIsConnected(false);
                            break;
                        }
                        case "sessions": {
                            if (data.sessions) {
                                writeSessionsFromWebSocket(data.sessions);
                            }
                            break;
                        }
                        case "event": {
                            if (
                                (data.event === "agents" ||
                                    data.event === "agents.list") &&
                                Array.isArray(data.payload)
                            ) {
                                writeAgentsFromWebSocket(data.payload as AgentInfo[]);
                            }
                            break;
                        }
                        case "log": {
                            if (data.line) {
                                writeLogFromWebSocket(data.line);
                            }
                            break;
                        }
                        case "res": {
                            if (!data.id) {
                                break;
                            }

                            const pending = pendingRequestsRef.current.get(data.id);
                            if (!pending) {
                                break;
                            }

                            pendingRequestsRef.current.delete(data.id);
                            if (data.ok) {
                                pending.resolve(data.payload);
                            } else {
                                pending.reject(data.error);
                            }
                            break;
                        }
                        default: {
                            break;
                        }
                    }
                } catch (error_) {
                    console.error("[WebSocket] Failed to parse message:", error_);
                }
            };

            ws.addEventListener("close", () => {
                setIsConnected(false);

                if (shouldReconnectRef.current) {
                    setTimeout(() => {
                        if (shouldReconnectRef.current) {
                            connect();
                        }
                    }, 2000);
                }
            });

            ws.onerror = () => {
                setError("WebSocket connection failed");
            };
        } catch {
            setError("Failed to create WebSocket");
        }
    }, [token]);

    const disconnect = useCallback(() => {
        shouldReconnectRef.current = false;
        wsRef.current?.close(1000, "Intentional disconnect");
        wsRef.current = null;
        setIsConnected(false);

        for (const pending of pendingRequestsRef.current.values()) {
            pending.reject(new Error("WebSocket disconnected"));
        }
        pendingRequestsRef.current.clear();
    }, []);

    const request = useCallback(
        <T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> => {
            return new Promise((resolve, reject) => {
                if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
                    reject(new Error("WebSocket not connected"));
                    return;
                }

                const id = String(++requestIdRef.current);
                pendingRequestsRef.current.set(id, {
                    resolve: resolve as (value: unknown) => void,
                    reject,
                });

                wsRef.current.send(
                    JSON.stringify({
                        type: "req",
                        id,
                        method,
                        params,
                    })
                );

                setTimeout(() => {
                    if (pendingRequestsRef.current.has(id)) {
                        pendingRequestsRef.current.delete(id);
                        reject(new Error("Request timeout"));
                    }
                }, 30_000);
            });
        },
        []
    );

    useEffect(() => {
        if (token) {
            connect();
        } else {
            disconnect();
            setError(null);
        }
    }, [token, connect, disconnect]);

    useEffect(() => disconnect, [disconnect]);

    const value = useMemo(
        () => ({
            isConnected,
            error,
            connectionId,
            connect,
            disconnect,
            request,
        }),
        [isConnected, error, connectionId, connect, disconnect, request]
    );

    return createElement(OpenClawSocketContext.Provider, { value }, children);
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
