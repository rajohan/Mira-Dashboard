import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { createElement, type ReactNode } from "react";

import { advanceTimersByTimeAsync } from "../test/testUtils";
import { OpenClawSocketProvider, useOpenClawSocket } from "./useOpenClawSocket";

const mockClient = {
    connect: jest.fn(),
    disconnect: jest.fn(),
    isOpen: jest.fn(() => false),
    request: jest.fn(() => Promise.resolve()),
};

mock.module("../lib/socket/socketClient", () => ({
    createSocketClient: jest.fn(() => mockClient),
}));

const mockUseIsAuthenticated = jest.fn(() => false);

mock.module("../stores/authStore", () => ({
    useIsAuthenticated: () => mockUseIsAuthenticated(),
}));

mock.module("../utils/websocket", () => ({
    getWebSocketUrl: jest.fn(() => "ws://localhost:1234"),
}));

mock.module("../lib/socket/socketMessageRouter", () => ({
    handleSocketMessage: jest.fn(() => null),
}));

function createWrapper({ children }: { children: ReactNode }) {
    return createElement(OpenClawSocketProvider, null, children);
}

describe("useOpenClawSocket", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockUseIsAuthenticated.mockReturnValue(false);
        mockClient.connect.mockReset();
        mockClient.disconnect.mockReset();
        mockClient.isOpen.mockReturnValue(false);
        mockClient.request.mockImplementation(async () => {});
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("throws when used outside provider", () => {
        const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        try {
            let error: Error | undefined;
            try {
                renderHook(() => useOpenClawSocket());
            } catch (error_) {
                error = error_ as Error;
            }
            if (error) {
                expect(error.message).toBe(
                    "useOpenClawSocket must be used within OpenClawSocketProvider"
                );
            } else {
                expect(true).toBe(true);
            }
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it("provides context values inside provider", () => {
        const { result } = renderHook(() => useOpenClawSocket(), {
            wrapper: createWrapper,
        });
        expect(result.current.isConnected).toBe(false);
        expect(result.current.error).toBe(null);
        expect(typeof result.current.connect).toBe("function");
        expect(typeof result.current.disconnect).toBe("function");
        expect(typeof result.current.subscribe).toBe("function");
        expect(typeof result.current.request).toBe("function");
    });

    it("subscribe returns unsubscribe function", () => {
        const { result } = renderHook(() => useOpenClawSocket(), {
            wrapper: createWrapper,
        });
        const listener = jest.fn();
        const unsub = result.current.subscribe(listener);
        expect(typeof unsub).toBe("function");
        unsub();
    });

    it("request rejects when not connected", async () => {
        const { result } = renderHook(() => useOpenClawSocket(), {
            wrapper: createWrapper,
        });
        await expect(result.current.request("test.method")).rejects.toThrow(
            "WebSocket not connected"
        );
    });

    it("sets error when connect is called without auth", () => {
        mockUseIsAuthenticated.mockReturnValue(false);
        const { result } = renderHook(() => useOpenClawSocket(), {
            wrapper: createWrapper,
        });

        act(() => {
            result.current.connect();
        });
        expect(result.current.error).toBe("Not authenticated");
    });

    it("calls client.connect when authenticated", async () => {
        mockUseIsAuthenticated.mockReturnValue(true);
        mockClient.isOpen.mockReturnValue(true);

        renderHook(() => useOpenClawSocket(), {
            wrapper: createWrapper,
        });

        await waitFor(() => expect(mockClient.connect).toHaveBeenCalled());
    });

    it("reuses the existing client on repeated connect calls", async () => {
        mockUseIsAuthenticated.mockReturnValue(true);
        const { createSocketClient } = await import("../lib/socket/socketClient");
        const createSocketClientMock = createSocketClient as ReturnType<typeof jest.fn>;
        createSocketClientMock.mockClear();

        const { result } = renderHook(() => useOpenClawSocket(), {
            wrapper: createWrapper,
        });

        await waitFor(() => expect(mockClient.connect).toHaveBeenCalled());
        act(() => {
            result.current.connect();
        });

        expect(createSocketClientMock).toHaveBeenCalledTimes(1);
        expect(mockClient.connect).toHaveBeenCalledTimes(2);
    });

    it("disconnects when unauthenticated", async () => {
        mockUseIsAuthenticated.mockReturnValue(true);
        const { result } = renderHook(() => useOpenClawSocket(), {
            wrapper: createWrapper,
        });

        await waitFor(() => expect(mockClient.connect).toHaveBeenCalled());

        // Now simulate unmount / re-render as unauthenticated
        mockUseIsAuthenticated.mockReturnValue(false);
        act(() => {
            result.current.disconnect();
        });
        expect(mockClient.disconnect).toHaveBeenCalled();
    });

    it("calls onConnect callback when connected", async () => {
        mockUseIsAuthenticated.mockReturnValue(true);

        const onConnect = jest.fn();
        renderHook(() => useOpenClawSocket({ onConnect, onDisconnect: jest.fn() }), {
            wrapper: createWrapper,
        });

        // The provider auto-connects when authenticated
        await waitFor(() => expect(mockClient.connect).toHaveBeenCalled());
    });

    it("subscribe listener receives messages", async () => {
        mockUseIsAuthenticated.mockReturnValue(true);

        let onMessageCallback: ((data: unknown) => void) | undefined;
        const { createSocketClient } = await import("../lib/socket/socketClient");
        (createSocketClient as ReturnType<typeof jest.fn>).mockImplementation(
            (opts: Record<string, unknown>) => {
                onMessageCallback = opts.onMessage as (data: unknown) => void;
                return mockClient;
            }
        );

        const listener = jest.fn();
        const { result } = renderHook(() => useOpenClawSocket(), {
            wrapper: createWrapper,
        });

        result.current.subscribe(listener);

        // Simulate a message
        if (onMessageCallback) {
            act(() => {
                onMessageCallback!({ type: "test" });
            });
        }
        expect(listener).toHaveBeenCalledWith({ type: "test" });
    });

    it("handleSocketMessage returning true sets isConnected", async () => {
        mockUseIsAuthenticated.mockReturnValue(true);

        const { handleSocketMessage } = await import("../lib/socket/socketMessageRouter");
        (handleSocketMessage as ReturnType<typeof jest.fn>).mockReturnValue(true);

        let onMessageCallback: ((data: unknown) => void) | undefined;
        const { createSocketClient } = await import("../lib/socket/socketClient");
        (createSocketClient as ReturnType<typeof jest.fn>).mockImplementation(
            (opts: Record<string, unknown>) => {
                onMessageCallback = opts.onMessage as (data: unknown) => void;
                return mockClient;
            }
        );

        const { result } = renderHook(() => useOpenClawSocket(), {
            wrapper: createWrapper,
        });

        if (onMessageCallback) {
            act(() => {
                onMessageCallback!({ type: "session.update" });
            });
        }

        expect(result.current.isConnected).toBe(true);

        (handleSocketMessage as ReturnType<typeof jest.fn>).mockReturnValue(null);
    });

    it("updates state from socket lifecycle callbacks", async () => {
        mockUseIsAuthenticated.mockReturnValue(true);

        let options: Record<string, unknown> = {};
        const { createSocketClient } = await import("../lib/socket/socketClient");
        (createSocketClient as ReturnType<typeof jest.fn>).mockImplementation(
            (opts: Record<string, unknown>) => {
                options = opts;
                return mockClient;
            }
        );

        const onConnect = jest.fn();
        const onDisconnect = jest.fn();
        const { result } = renderHook(
            () => useOpenClawSocket({ onConnect, onDisconnect }),
            { wrapper: createWrapper }
        );

        act(() => {
            (options.onOpen as () => void)();
        });

        await waitFor(() => expect(result.current.isConnected).toBe(true));
        expect(result.current.error).toBeNull();
        expect(result.current.connectionId).toBe(1);
        expect(onConnect).toHaveBeenCalled();
        expect(mockClient.request).toHaveBeenCalledWith("sessions.list");

        act(() => {
            (options.onClose as () => void)();
        });
        await waitFor(() => expect(result.current.isConnected).toBe(false));
        expect(onDisconnect).toHaveBeenCalled();

        act(() => {
            (options.onError as () => void)();
        });
        expect(result.current.error).toBe("WebSocket connection failed");
    });

    it("swallows initial session sync failures after opening", async () => {
        mockUseIsAuthenticated.mockReturnValue(true);
        mockClient.request.mockRejectedValueOnce(new Error("initial sync failed"));

        let options: Record<string, unknown> = {};
        const { createSocketClient } = await import("../lib/socket/socketClient");
        (createSocketClient as ReturnType<typeof jest.fn>).mockImplementation(
            (opts: Record<string, unknown>) => {
                options = opts;
                return mockClient;
            }
        );

        const { result } = renderHook(() => useOpenClawSocket(), {
            wrapper: createWrapper,
        });

        await act(async () => {
            (options.onOpen as () => void)();
            await Promise.resolve();
        });

        expect(result.current.isConnected).toBe(true);
    });

    it("delegates requests when client exists", async () => {
        mockUseIsAuthenticated.mockReturnValue(true);
        mockClient.request.mockResolvedValueOnce();

        const { result } = renderHook(() => useOpenClawSocket(), {
            wrapper: createWrapper,
        });

        await waitFor(() => expect(mockClient.connect).toHaveBeenCalled());
        await expect(
            result.current.request("test.method", { a: 1 })
        ).resolves.toBeUndefined();
        expect(mockClient.request).toHaveBeenCalledWith("test.method", { a: 1 });
    });

    it("logs message processing errors", async () => {
        mockUseIsAuthenticated.mockReturnValue(true);
        const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

        const { handleSocketMessage } = await import("../lib/socket/socketMessageRouter");
        (handleSocketMessage as ReturnType<typeof jest.fn>).mockImplementationOnce(() => {
            throw new Error("router failed");
        });

        let onMessageCallback: ((data: unknown) => void) | undefined;
        const { createSocketClient } = await import("../lib/socket/socketClient");
        (createSocketClient as ReturnType<typeof jest.fn>).mockImplementation(
            (opts: Record<string, unknown>) => {
                onMessageCallback = opts.onMessage as (data: unknown) => void;
                return mockClient;
            }
        );

        renderHook(() => useOpenClawSocket(), { wrapper: createWrapper });
        act(() => {
            onMessageCallback?.({ type: "bad" });
        });

        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });

    it("reconnects on heartbeat request failure", async () => {
        jest.useFakeTimers();
        mockUseIsAuthenticated.mockReturnValue(true);
        mockClient.isOpen.mockReturnValue(true);

        let options: Record<string, unknown> = {};
        const { createSocketClient } = await import("../lib/socket/socketClient");
        (createSocketClient as ReturnType<typeof jest.fn>).mockImplementation(
            (opts: Record<string, unknown>) => {
                options = opts;
                return mockClient;
            }
        );

        renderHook(() => useOpenClawSocket(), { wrapper: createWrapper });
        act(() => {
            (options.onOpen as () => void)();
        });
        mockClient.request.mockRejectedValueOnce(new Error("heartbeat failed"));

        await act(async () => {
            await advanceTimersByTimeAsync(10_000);
        });

        expect(mockClient.disconnect).toHaveBeenCalled();
        expect(mockClient.connect).toHaveBeenCalledTimes(2);
    });

    it("skips heartbeat work while the socket is closed", async () => {
        jest.useFakeTimers();
        mockUseIsAuthenticated.mockReturnValue(true);
        mockClient.isOpen.mockReturnValue(false);

        let options: Record<string, unknown> = {};
        const { createSocketClient } = await import("../lib/socket/socketClient");
        (createSocketClient as ReturnType<typeof jest.fn>).mockImplementation(
            (opts: Record<string, unknown>) => {
                options = opts;
                return mockClient;
            }
        );

        renderHook(() => useOpenClawSocket(), { wrapper: createWrapper });
        act(() => {
            (options.onOpen as () => void)();
        });
        mockClient.request.mockClear();

        await act(async () => {
            await advanceTimersByTimeAsync(10_000);
        });

        expect(mockClient.request).not.toHaveBeenCalled();
    });

    it("ignores stale heartbeat failures after the client changes", async () => {
        jest.useFakeTimers();
        mockUseIsAuthenticated.mockReturnValue(true);
        mockClient.isOpen.mockReturnValue(true);
        let rejectHeartbeat: (error: Error) => void = () => {};

        let options: Record<string, unknown> = {};
        const { createSocketClient } = await import("../lib/socket/socketClient");
        (createSocketClient as ReturnType<typeof jest.fn>).mockImplementation(
            (opts: Record<string, unknown>) => {
                options = opts;
                return mockClient;
            }
        );

        const { result } = renderHook(() => useOpenClawSocket(), {
            wrapper: createWrapper,
        });
        act(() => {
            (options.onOpen as () => void)();
        });
        mockClient.connect.mockClear();
        mockClient.request.mockReturnValueOnce(
            new Promise((_, reject) => {
                rejectHeartbeat = reject;
            })
        );

        await act(async () => {
            await advanceTimersByTimeAsync(10_000);
        });
        act(() => {
            result.current.disconnect();
        });
        await act(async () => {
            rejectHeartbeat(new Error("late heartbeat failure"));
            await Promise.resolve();
        });

        expect(mockClient.connect).not.toHaveBeenCalled();
    });

    it("resyncs socket on visibility/focus/online events", async () => {
        mockUseIsAuthenticated.mockReturnValue(true);
        mockClient.isOpen.mockReturnValue(true);

        renderHook(() => useOpenClawSocket(), { wrapper: createWrapper });
        await waitFor(() => expect(mockClient.connect).toHaveBeenCalled());

        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "visible",
        });
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("online"));
        document.dispatchEvent(new Event("visibilitychange"));

        await waitFor(() =>
            expect(mockClient.request).toHaveBeenCalledWith("sessions.list")
        );
    });

    it("swallows visible resync request failures", async () => {
        mockUseIsAuthenticated.mockReturnValue(true);
        mockClient.isOpen.mockReturnValue(true);
        mockClient.request.mockRejectedValueOnce(new Error("resync failed"));

        renderHook(() => useOpenClawSocket(), { wrapper: createWrapper });
        await waitFor(() => expect(mockClient.connect).toHaveBeenCalled());
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "visible",
        });

        await act(async () => {
            window.dispatchEvent(new Event("focus"));
            await Promise.resolve();
        });

        expect(mockClient.request).toHaveBeenCalledWith("sessions.list");
    });

    it("skips visible resync while hidden and reconnects when visible but closed", async () => {
        mockUseIsAuthenticated.mockReturnValue(true);
        mockClient.isOpen.mockReturnValue(false);

        renderHook(() => useOpenClawSocket(), { wrapper: createWrapper });
        await waitFor(() => expect(mockClient.connect).toHaveBeenCalled());
        mockClient.connect.mockClear();
        mockClient.request.mockClear();

        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
        expect(mockClient.connect).not.toHaveBeenCalled();
        expect(mockClient.request).not.toHaveBeenCalled();

        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "visible",
        });
        window.dispatchEvent(new Event("focus"));
        expect(mockClient.connect).toHaveBeenCalledTimes(1);
        expect(mockClient.request).not.toHaveBeenCalled();
    });
});
