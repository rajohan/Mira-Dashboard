import { useRef, useState } from "react";

import { getWebSocketUrl } from "../utils/websocket";
import { writeLogFromWebSocket } from "../collections/logs";
import { writeSessionsFromWebSocket } from "../collections/sessions";
import { writeAgentsFromWebSocket } from "../collections/agents";

interface OpenClawMessage {
    type:
        | "req"
        | "res"
        | "event"
        | "state"
        | "connected"
        | "disconnected"
        | "sessions"
        | "log"
        | "log_history_complete"
        | "log_file";
    id?: string;
    method?: string;
    params?: Record<string, unknown>;
    event?: string;
    payload?: Record<string, unknown>;
    ok?: boolean;
    error?: string;
    sessions?: Record<string, unknown>[];
    gatewayConnected?: boolean;
    line?: string;
    file?: string;
    count?: number;
}

interface UseOpenClawSocketOptions {
    token: string | null;
    onConnect?: () => void;
    onDisconnect?: () => void;
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
}

export function useOpenClawSocket({
    token,
    onConnect,
    onDisconnect,
}: UseOpenClawSocketOptions) {
    const wsRef = useRef<WebSocket | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const requestIdRef = useRef(0);
    const pendingRequestsRef = useRef<Map<string, PendingRequest>>(new Map());
    const shouldReconnectRef = useRef(true);

    const connect = () => {
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
                onConnect?.();

                const req = JSON.stringify({
                    type: "req",
                    method: "sessions.list",
                    id: Date.now().toString(),
                });

                ws.send(req);
            });

            ws.onmessage = (event) => {
                try {
                    const data: OpenClawMessage = JSON.parse(event.data);

                    if (data.type === "state") {
                        setIsConnected(data.gatewayConnected ?? true);
                        if (data.sessions) {
                            writeSessionsFromWebSocket(
                                data.sessions as unknown as Array<{
                                    key: string;
                                    id: string;
                                    type: string;
                                    agentType: string;
                                    hookName: string;
                                    kind: string;
                                    model: string;
                                    tokenCount: number;
                                    maxTokens: number;
                                    createdAt: string | null;
                                    updatedAt: number | null;
                                    displayName: string;
                                    label: string;
                                    displayLabel: string;
                                    channel: string;
                                }>
                            );
                        }
                    }

                    if (data.type === "connected") {
                        setIsConnected(data.gatewayConnected ?? true);
                    }

                    if (data.type === "disconnected") {
                        setIsConnected(false);
                        onDisconnect?.();
                    }

                    if (data.type === "sessions" && data.sessions) {
                        writeSessionsFromWebSocket(
                            data.sessions as unknown as Array<{
                                key: string;
                                id: string;
                                type: string;
                                agentType: string;
                                hookName: string;
                                kind: string;
                                model: string;
                                tokenCount: number;
                                maxTokens: number;
                                createdAt: string | null;
                                updatedAt: number | null;
                                displayName: string;
                                label: string;
                                displayLabel: string;
                                channel: string;
                            }>
                        );
                    }

                    if (data.type === "event" && data.event) {
                        if (data.event === "agents" || data.event === "agents.list") {
                            const agents = data.payload as unknown as Array<{
                                id: string;
                                name: string;
                                model?: string;
                                status?: string;
                            }>;
                            writeAgentsFromWebSocket(agents);
                        }
                    }

                    if (data.type === "log" && data.line) {
                        writeLogFromWebSocket(data.line as string);
                    }

                    if (data.type === "res" && data.id) {
                        const pending = pendingRequestsRef.current.get(data.id);
                        if (pending) {
                            pendingRequestsRef.current.delete(data.id);
                            if (data.ok) {
                                pending.resolve(data.payload);
                            } else {
                                pending.reject(data.error);
                            }
                        }
                    }
                } catch (error_) {
                    console.error("[WebSocket] Failed to parse message:", error_);
                }
            };

            ws.addEventListener("close", () => {
                setIsConnected(false);
                onDisconnect?.();

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
        } catch (error_) {
            setError("Failed to create WebSocket");
        }
    };

    const disconnect = () => {
        shouldReconnectRef.current = false;
        wsRef.current?.close(1000, "Intentional disconnect");
        wsRef.current = null;
        setIsConnected(false);
    };

    const request = <T = unknown>(
        method: string,
        params?: Record<string, unknown>
    ): Promise<T> => {
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
    };

    return {
        isConnected,
        error,
        connect,
        disconnect,
        request,
    };
}
