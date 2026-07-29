import { useSelector } from "@tanstack/react-store";
import {
    createContext,
    createElement,
    type ReactNode,
    use,
    useEffect,
    useEffectEvent,
    useRef,
    useState,
} from "react";

import { readSessionsResponsePayload } from "../../../contracts/socket";
import { replaceSessionsFromWebSocket } from "../collections/sessions";
import {
    AUTH_SESSION_ROTATED_EVENT_NAME,
    type AuthSessionIdentity,
    isSignaledAuthSessionRotation,
} from "../lib/authBoundary";
import { subscribeToGlobalEvent } from "../lib/globalEvents";
import { isBrowserPollingAllowed, refreshPolicy } from "../lib/refreshPolicy";
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

class OpenClawSocketRuntime {
    private client: SocketClient | undefined;
    private readonly listeners = new Set<(data: unknown) => void>();
    private sessionListRefresh: { promise: Promise<void> } | undefined;

    currentClient(): SocketClient | undefined {
        return this.client;
    }

    installClient(client: SocketClient): void {
        this.client = client;
    }

    disconnectClient(): void {
        this.client?.disconnect();
        this.client = undefined;
        this.sessionListRefresh = undefined;
    }

    currentSessionListRefresh(): { promise: Promise<void> } | undefined {
        return this.sessionListRefresh;
    }

    beginSessionListRefresh(refresh: { promise: Promise<void> }): void {
        this.sessionListRefresh = refresh;
    }

    completeSessionListRefresh(refresh: { promise: Promise<void> }): void {
        if (this.sessionListRefresh === refresh) {
            this.sessionListRefresh = undefined;
        }
    }

    notifyListeners(data: unknown): void {
        for (const listener of this.listeners) {
            listener(data);
        }
    }

    subscribe(listener: (data: unknown) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
}

/**
 * Provides OpenClaw socket state.
 * @returns The OpenClaw socket state.
 */
export function OpenClawSocketProvider({ children }: { children: ReactNode }) {
    const isAuthenticated = useSelector(authStore, (state) => state.isAuthenticated);
    const authenticatedUserId = useSelector(authStore, (state) => state.user?.id);
    const sessionId = useSelector(authStore, (state) => state.sessionId);
    const [runtime] = useState(() => new OpenClawSocketRuntime());
    const previousAuthIdentityRef = useRef<AuthSessionIdentity | undefined>(undefined);

    const [isConnected, setIsConnected] = useState(false);
    const [hasConfirmedSessionList, setHasConfirmedSessionList] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [connectionId, setConnectionId] = useState(0);

    /** Applies only the result of a request known to be sessions.list. */
    const applySessionsListResponse = (client: SocketClient, payload: unknown) => {
        if (runtime.currentClient() !== client) {
            return;
        }
        const sessions = readSessionsResponsePayload(payload);
        if (sessions === undefined) {
            return;
        }
        replaceSessionsFromWebSocket(sessions);
        setHasConfirmedSessionList(true);
    };

    /** Coalesces session resync triggers within this browser connection. */
    const refreshSessionList = async (client: SocketClient): Promise<void> => {
        const existing = runtime.currentSessionListRefresh();
        if (existing) {
            await existing.promise;
            return;
        }

        const load = async () => {
            const payload = await client.request("sessions.list");
            applySessionsListResponse(client, payload);
        };
        const refresh = { promise: load() };
        runtime.beginSessionListRefresh(refresh);
        try {
            await refresh.promise;
        } finally {
            runtime.completeSessionListRefresh(refresh);
        }
    };

    const connectAuthenticated = () => {
        let client = runtime.currentClient();
        if (!client) {
            client = createSocketClient({
                url: getWebSocketUrl(),
                onOpen: () => {
                    setIsConnected(true);
                    setHasConfirmedSessionList(false);
                    setError(undefined);
                    setConnectionId((wasPrevious) => wasPrevious + 1);
                    const activeClient = runtime.currentClient();
                    if (!activeClient) {
                        return;
                    }
                    void refreshSessionList(activeClient).catch(() => {
                        // Best-effort socket resync.
                    });
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
                        const hasSessionList =
                            data.type === "sessions" &&
                            Array.isArray(data.sessions) &&
                            data.gatewayConnected !== false;
                        if (
                            connectionState === false ||
                            data.type === "connected" ||
                            data.type === "disconnected"
                        ) {
                            setHasConfirmedSessionList(false);
                        } else if (hasSessionList) {
                            setHasConfirmedSessionList(true);
                        }
                        if (connectionState !== undefined) {
                            setIsConnected(connectionState);
                        }
                        runtime.notifyListeners(data);
                    } catch (error_) {
                        console.error("[WebSocket] Failed to process message:", error_);
                    }
                },
            });
            runtime.installClient(client);
        }

        client.connect();
    };

    /** Performs connect. */
    const connect = () => {
        if (!isAuthenticated) {
            setError("Not authenticated");
            return;
        }
        connectAuthenticated();
    };

    const disconnectClient = () => {
        runtime.disconnectClient();
    };

    /** Performs disconnect. */
    const disconnect = () => {
        disconnectClient();
        setIsConnected(false);
        setHasConfirmedSessionList(false);
    };

    /**
     * Performs request.
     * @param method Method value.
     * @param parameters Parameters value.
     * @param options Operation options.
     * @returns Request result.
     */
    const request = <T = unknown>(
        method: string,
        parameters?: Record<string, unknown>,
        options?: SocketRequestOptions
    ): Promise<T> => {
        const client = runtime.currentClient();
        if (!client) {
            return Promise.reject(new Error("WebSocket not connected"));
        }

        return client.request<T>(method, parameters, options);
    };

    const connectFromEffect = useEffectEvent(connectAuthenticated);
    const disconnectClientFromEffect = useEffectEvent(disconnectClient);
    const refreshSessionListFromEffect = useEffectEvent(refreshSessionList);

    useEffect(() => {
        const currentAuthIdentity =
            isAuthenticated && authenticatedUserId !== undefined && sessionId
                ? {
                      sessionId,
                      userId: authenticatedUserId,
                  }
                : undefined;
        const previousAuthIdentity = previousAuthIdentityRef.current;
        previousAuthIdentityRef.current =
            currentAuthIdentity ?? (isAuthenticated ? previousAuthIdentity : undefined);
        if (isAuthenticated) {
            if (!currentAuthIdentity) {
                return;
            }
            if (
                previousAuthIdentity &&
                isSignaledAuthSessionRotation(previousAuthIdentity, currentAuthIdentity)
            ) {
                if (!runtime.currentClient()) {
                    connectFromEffect();
                }
                return;
            }
            const client = runtime.currentClient();
            if (client) {
                client.reconnect();
            } else {
                connectFromEffect();
            }
        } else {
            previousAuthIdentityRef.current = undefined;
            disconnectClientFromEffect();
        }
    }, [authenticatedUserId, isAuthenticated, runtime, sessionId]);

    useEffect(() => {
        if (!isAuthenticated) {
            return;
        }
        const reconnectWithRotatedSession = () => {
            runtime.currentClient()?.reconnect();
        };
        return subscribeToGlobalEvent(
            AUTH_SESSION_ROTATED_EVENT_NAME,
            reconnectWithRotatedSession
        );
    }, [isAuthenticated, runtime]);

    useEffect(() => {
        if (!isAuthenticated || !isConnected) {
            return;
        }

        const interval = setInterval(() => {
            const client = runtime.currentClient();
            if (!isBrowserPollingAllowed() || !client?.isOpen()) {
                return;
            }

            void (async () => {
                try {
                    await refreshSessionListFromEffect(client);
                } catch {
                    if (runtime.currentClient() !== client) {
                        return;
                    }

                    setIsConnected(false);
                    client.disconnect();
                    client.connect();
                }
            })();
        }, refreshPolicy.active * 2);

        return () => clearInterval(interval);
    }, [connectionId, isAuthenticated, isConnected, runtime]);

    useEffect(() => {
        if (!isAuthenticated) {
            return;
        }

        /** Performs resync visible socket. */
        const resyncVisibleSocket = () => {
            if (!isBrowserPollingAllowed()) {
                return;
            }

            if (!runtime.currentClient()?.isOpen()) {
                connectFromEffect();
                return;
            }

            void (async () => {
                try {
                    const client = runtime.currentClient();
                    if (!client) {
                        return;
                    }
                    await refreshSessionListFromEffect(client);
                } catch {
                    // Best-effort socket resync.
                }
            })();
        };

        document.addEventListener("visibilitychange", resyncVisibleSocket);
        window.addEventListener("focus", resyncVisibleSocket);
        const unsubscribeOnline = subscribeToGlobalEvent("online", resyncVisibleSocket);

        return () => {
            document.removeEventListener("visibilitychange", resyncVisibleSocket);
            window.removeEventListener("focus", resyncVisibleSocket);
            unsubscribeOnline();
        };
    }, [isAuthenticated, runtime]);

    useEffect(() => {
        return () => {
            runtime.disconnectClient();
        };
    }, [runtime]);

    /**
     * Performs subscribe.
     * @param listener Listener value.
     * @returns Subscribe result.
     */
    const subscribe = (listener: (data: unknown) => void) => {
        return runtime.subscribe(listener);
    };

    return createElement(
        OpenClawSocketContext.Provider,
        {
            value: {
                isConnected: isAuthenticated && isConnected,
                hasConfirmedSessionList: isAuthenticated && hasConfirmedSessionList,
                error: isAuthenticated ? error : undefined,
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

/**
 * Provides OpenClaw socket.
 * @returns The OpenClaw socket.
 */
export function useOpenClawSocket(options?: UseOpenClawSocketOptions) {
    const context = use(OpenClawSocketContext);

    if (!context) {
        throw new Error("useOpenClawSocket must be used within OpenClawSocketProvider");
    }

    const { onConnect, onDisconnect } = options || {};
    const notifyConnected = useEffectEvent(() => onConnect?.());
    const notifyDisconnected = useEffectEvent(() => onDisconnect?.());

    useEffect(() => {
        if (context.isConnected) {
            notifyConnected();
        }
    }, [context.isConnected]);

    useEffect(() => {
        if (!context.isConnected) {
            notifyDisconnected();
        }
    }, [context.isConnected]);

    return context;
}
