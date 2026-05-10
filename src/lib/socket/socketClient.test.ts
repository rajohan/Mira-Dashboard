import { describe, expect, it, vi } from "vitest";

import { createSocketClient } from "./socketClient";

class MockWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    static CLOSING = 2;

    readyState = MockWebSocket.CONNECTING;
    send = vi.fn();
    close = vi.fn();

    private listeners: Record<string, EventListener[]> = {};

    addEventListener(type: string, listener: EventListener) {
        (this.listeners[type] ??= []).push(listener);
    }

    removeEventListener() {}

    simulateOpen() {
        this.readyState = MockWebSocket.OPEN;
        for (const l of this.listeners["open"] ?? []) l(new Event("open"));
    }

    simulateMessage(data: unknown) {
        for (const l of this.listeners["message"] ?? [])
            l(new MessageEvent("message", { data: JSON.stringify(data) }));
    }

    simulateClose() {
        this.readyState = MockWebSocket.CLOSED;
        for (const l of this.listeners["close"] ?? []) new Event("close");
    }

    simulateError() {
        for (const l of this.listeners["error"] ?? []) l(new Event("error"));
    }
}

describe("socketClient", () => {
    it("creates a client with connect/disconnect/request/isOpen", () => {
        const client = createSocketClient({ url: "ws://localhost" });
        expect(typeof client.connect).toBe("function");
        expect(typeof client.disconnect).toBe("function");
        expect(typeof client.request).toBe("function");
        expect(typeof client.isOpen).toBe("function");
    });

    it("rejects request when not connected", async () => {
        const client = createSocketClient({ url: "ws://localhost" });
        await expect(client.request("test")).rejects.toThrow("WebSocket not connected");
    });

    it("isOpen returns false when not connected", () => {
        const client = createSocketClient({ url: "ws://localhost" });
        expect(client.isOpen()).toBe(false);
    });
});
