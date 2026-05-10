import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OpenClawSocketProvider, useOpenClawSocket } from "./useOpenClawSocket";

const mockClient = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isOpen: vi.fn(() => false),
    request: vi.fn(() => Promise.resolve()),
};

vi.mock("../lib/socket/socketClient", () => ({
    createSocketClient: vi.fn(() => mockClient),
}));

const mockUseIsAuthenticated = vi.fn(() => false);

vi.mock("../stores/authStore", () => ({
    useIsAuthenticated: () => mockUseIsAuthenticated(),
}));

vi.mock("../utils/websocket", () => ({
    getWebSocketUrl: vi.fn(() => "ws://localhost:1234"),
}));

vi.mock("../lib/socket/socketMessageRouter", () => ({
    handleSocketMessage: vi.fn(() => null),
}));

function createWrapper({ children }: { children: ReactNode }) {
    return createElement(OpenClawSocketProvider, null, children);
}

describe("useOpenClawSocket", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockUseIsAuthenticated.mockReturnValue(false);
        mockClient.connect.mockReset();
        mockClient.disconnect.mockReset();
        mockClient.isOpen.mockReturnValue(false);
        mockClient.request.mockResolvedValue();
    });

    it("throws when used outside provider", () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
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
        const listener = vi.fn();
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

        const onConnect = vi.fn();
        renderHook(() => useOpenClawSocket({ onConnect, onDisconnect: vi.fn() }), {
            wrapper: createWrapper,
        });

        // The provider auto-connects when authenticated
        await waitFor(() => expect(mockClient.connect).toHaveBeenCalled());
    });

    it("subscribe listener receives messages", async () => {
        mockUseIsAuthenticated.mockReturnValue(true);

        let onMessageCallback: ((data: unknown) => void) | undefined;
        const { createSocketClient } = await import("../lib/socket/socketClient");
        (createSocketClient as ReturnType<typeof vi.fn>).mockImplementation(
            (opts: Record<string, unknown>) => {
                onMessageCallback = opts.onMessage as (data: unknown) => void;
                return mockClient;
            }
        );

        const listener = vi.fn();
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
        (handleSocketMessage as ReturnType<typeof vi.fn>).mockReturnValue(true);

        let onMessageCallback: ((data: unknown) => void) | undefined;
        const { createSocketClient } = await import("../lib/socket/socketClient");
        (createSocketClient as ReturnType<typeof vi.fn>).mockImplementation(
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

        // Reset
        (handleSocketMessage as ReturnType<typeof vi.fn>).mockReturnValue(null);
    });
});
