import { useRef, useState, useCallback } from "react";

// Connect to our Gateway Mirror backend, not directly to OpenClaw
// This avoids CORS and WebSocket issues

const getBackendUrl = () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.hostname;
    const port = window.location.port || "5173";
    return protocol + "//" + host + ":" + (port === "5173" ? "3100" : port) + "/ws";
};

interface OpenClawMessage {
    type: "req" | "res" | "event" | "state" | "connected" | "disconnected" | "sessions";
    id?: string;
    method?: string;
    params?: any;
    event?: string;
    payload?: any;
    ok?: boolean;
    error?: any;
    sessions?: any[];
    gatewayConnected?: boolean;
}

interface UseOpenClawSocketOptions {
    token: string;
    onMessage?: (method: string, params: any) => void;
    onConnect?: () => void;
    onDisconnect?: () => void;
    onSessions?: (sessions: any[]) => void;
}

export function useOpenClawSocket({ token, onMessage, onConnect, onDisconnect, onSessions }: UseOpenClawSocketOptions) {
    const wsRef = useRef<WebSocket | null>(null);
    const [isConnected, setIsConnected] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const requestIdRef = useRef(0);
    const pendingRequestsRef = useRef<Map<string, { resolve: Function; reject: Function }>>(new Map());
    const shouldReconnectRef = useRef(true);

    const connect = useCallback(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
            return;
        }

        if (!token) {
            setError("No token provided");
            return;
        }

        shouldReconnectRef.current = true;
        const wsUrl = getBackendUrl();
        
        console.log("[WebSocket] Connecting to backend:", wsUrl);

        try {
            const ws = new WebSocket(wsUrl);
            wsRef.current = ws;

            ws.onopen = () => {
                console.log("[WebSocket] Connected to backend");
                setIsConnected(true);
                setError(null);
                onConnect?.();
                
                // Request session list
                ws.send(JSON.stringify({
                    type: "req",
                    method: "sessions.list",
                    id: Date.now().toString(),
                }));
            };

            ws.onmessage = (event) => {
                try {
                    const data: OpenClawMessage = JSON.parse(event.data);
                    console.log("[WebSocket] Received:", data.type, data.sessions?.length || "");
                    
                    // Handle initial state
                    if (data.type === "state") {
                        setIsConnected(data.gatewayConnected ?? true);
                        if (data.sessions) {
                            onSessions?.(data.sessions);
                        }
                    }
                    
                    // Handle connection status
                    if (data.type === "connected") {
                        setIsConnected(data.gatewayConnected ?? true);
                    }
                    
                    if (data.type === "disconnected") {
                        setIsConnected(false);
                        onDisconnect?.();
                    }
                    
                    // Handle session updates from backend
                    if (data.type === "sessions" && data.sessions) {
                        console.log("[WebSocket] Sessions update:", data.sessions.length);
                        onSessions?.(data.sessions);
                    }
                    
                    // Handle events
                    if (data.type === "event" && data.event) {
                        onMessage?.(data.event, data.payload);
                    }
                    
                    // Handle request responses
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
                } catch (e) {
                    console.error("[WebSocket] Failed to parse message:", e);
                }
            };

            ws.onclose = (event) => {
                console.log("[WebSocket] Disconnected:", event.code);
                setIsConnected(false);
                onDisconnect?.();
                
                if (shouldReconnectRef.current) {
                    setTimeout(() => {
                        if (shouldReconnectRef.current) {
                            connect();
                        }
                    }, 5000);
                }
            };

            ws.onerror = () => {
                console.error("[WebSocket] Error");
                setError("WebSocket connection failed");
            };
        } catch (e) {
            console.error("[WebSocket] Failed to create:", e);
            setError("Failed to create WebSocket");
        }
    }, [token, onMessage, onConnect, onDisconnect, onSessions]);

    const disconnect = useCallback(() => {
        shouldReconnectRef.current = false;
        wsRef.current?.close(1000, "Intentional disconnect");
        wsRef.current = null;
        setIsConnected(false);
    }, []);

    const request = useCallback(<T = any>(method: string, params?: any): Promise<T> => {
        return new Promise((resolve, reject) => {
            if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
                reject(new Error("WebSocket not connected"));
                return;
            }

            const id = String(++requestIdRef.current);
            pendingRequestsRef.current.set(id, { resolve, reject });

            wsRef.current.send(JSON.stringify({
                type: "req",
                id,
                method,
                params,
            }));

            setTimeout(() => {
                if (pendingRequestsRef.current.has(id)) {
                    pendingRequestsRef.current.delete(id);
                    reject(new Error("Request timeout"));
                }
            }, 30000);
        });
    }, []);

    return {
        isConnected,
        error,
        connect,
        disconnect,
        request,
    };
}
