import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { stubGlobal, unstubAllGlobals } from "../../test/testUtils";
import { createSocketClient } from "./socketClient";

type Listener = (event: Event | MessageEvent) => void;

class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    readonly sent: string[] = [];
    readonly listeners = new Map<string, Listener[]>();

    readonly url: string;

    constructor(url: string) {
        this.url = url;
        mockSocketInstances.push(this);
    }

    private emit(type: string, event: Event | MessageEvent) {
        for (const listener of this.listeners.get(type) || []) {
            listener(event);
        }
    }

    addEventListener(type: string, listener: Listener) {
        this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
    }

    send(data: string) {
        this.sent.push(data);
    }

    close() {
        this.readyState = MockWebSocket.CLOSED;
    }

    emitOpen() {
        this.readyState = MockWebSocket.OPEN;
        this.emit("open", new Event("open"));
    }

    emitMessage(data: unknown) {
        this.emit(
            "message",
            new MessageEvent("message", {
                data: typeof data === "string" ? data : JSON.stringify(data),
            })
        );
    }

    emitClose() {
        this.readyState = MockWebSocket.CLOSED;
        this.emit("close", new Event("close"));
    }

    emitError() {
        this.emit("error", new Event("error"));
    }
}

const mockSocketInstances: MockWebSocket[] = [];

describe("socketClient", () => {
    beforeEach(() => {
        mockSocketInstances.length = 0;
        stubGlobal("WebSocket", MockWebSocket);
    });

    afterEach(() => {
        jest.useRealTimers();
        unstubAllGlobals();
    });

    it("creates a client with connect/disconnect/request/isOpen", () => {
        const client = createSocketClient({ url: "ws://localhost" });
        expect(typeof client.connect).toBe("function");
        expect(typeof client.disconnect).toBe("function");
        expect(typeof client.request).toBe("function");
        expect(typeof client.isOpen).toBe("function");
    });

    it("connects and reports open state", () => {
        const onOpen = jest.fn();
        const client = createSocketClient({ url: "ws://localhost", onOpen });

        client.connect();
        expect(mockSocketInstances).toHaveLength(1);
        expect(mockSocketInstances[0]?.url).toBe("ws://localhost");
        expect(client.isOpen()).toBe(false);

        mockSocketInstances[0]?.emitOpen();
        expect(onOpen).toHaveBeenCalled();
        expect(client.isOpen()).toBe(true);
    });

    it("does not create a second socket while already connecting/open", () => {
        const client = createSocketClient({ url: "ws://localhost" });

        client.connect();
        client.connect();
        expect(mockSocketInstances).toHaveLength(1);

        mockSocketInstances[0]?.emitOpen();
        client.connect();
        expect(mockSocketInstances).toHaveLength(1);
    });

    it("rejects request when not connected", async () => {
        const client = createSocketClient({ url: "ws://localhost" });
        await expect(client.request("test")).rejects.toThrow("WebSocket not connected");
    });

    it("sends requests and resolves successful responses", async () => {
        const client = createSocketClient({ url: "ws://localhost" });
        client.connect();
        mockSocketInstances[0]?.emitOpen();

        const promise = client.request("sessions.list", { limit: 1 });
        const sent = JSON.parse(mockSocketInstances[0]?.sent[0] || "{}");
        expect(sent).toMatchObject({
            type: "req",
            id: "1",
            method: "sessions.list",
            params: { limit: 1 },
        });

        mockSocketInstances[0]?.emitMessage({
            type: "res",
            id: "1",
            ok: true,
            payload: { ok: true },
        });
        await expect(promise).resolves.toEqual({ ok: true });
    });

    it("rejects failed responses", async () => {
        const client = createSocketClient({ url: "ws://localhost" });
        client.connect();
        mockSocketInstances[0]?.emitOpen();

        const promise = client.request("bad.method");
        mockSocketInstances[0]?.emitMessage({
            type: "res",
            id: "1",
            ok: false,
            error: "boom",
        });

        await expect(promise).rejects.toBe("boom");
    });

    it("ignores responses without a matching pending request", () => {
        const onMessage = jest.fn();
        const client = createSocketClient({ url: "ws://localhost", onMessage });
        client.connect();
        mockSocketInstances[0]?.emitOpen();

        mockSocketInstances[0]?.emitMessage({
            type: "res",
            id: "missing",
            ok: true,
            payload: { ignored: true },
        });
        mockSocketInstances[0]?.emitMessage({ type: "res", ok: true });

        expect(onMessage).toHaveBeenCalledTimes(2);
    });

    it("forwards parsed messages to onMessage", () => {
        const onMessage = jest.fn();
        const client = createSocketClient({ url: "ws://localhost", onMessage });
        client.connect();

        mockSocketInstances[0]?.emitMessage({ type: "event", event: "x" });
        expect(onMessage).toHaveBeenCalledWith({ type: "event", event: "x" });
    });

    it("handles unparsable messages", () => {
        const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        const client = createSocketClient({ url: "ws://localhost" });
        client.connect();

        mockSocketInstances[0]?.emitMessage("not json");
        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });

    it("calls onError and onClose callbacks", () => {
        const onError = jest.fn();
        const onClose = jest.fn();
        const client = createSocketClient({ url: "ws://localhost", onError, onClose });
        client.connect();

        mockSocketInstances[0]?.emitError();
        mockSocketInstances[0]?.emitClose();
        expect(onError).toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled();
    });

    it("disconnect closes socket and rejects pending requests", async () => {
        const client = createSocketClient({ url: "ws://localhost" });
        client.connect();
        mockSocketInstances[0]?.emitOpen();

        const promise = client.request("slow.method");
        client.disconnect();

        expect(mockSocketInstances[0]?.readyState).toBe(MockWebSocket.CLOSED);
        expect(client.isOpen()).toBe(false);
        await expect(promise).rejects.toThrow("WebSocket disconnected");
    });

    it("times out unanswered requests", async () => {
        let timeout: (() => void) | undefined;
        const setTimeoutMock = jest
            .fn()
            .mockImplementationOnce((handler: TimerHandler) => {
                timeout = handler as () => void;
                return 1;
            });
        const setTimeoutSpy = jest
            .spyOn(window, "setTimeout")
            .mockImplementationOnce(
                setTimeoutMock as unknown as typeof window.setTimeout
            );
        const client = createSocketClient({ url: "ws://localhost" });
        client.connect();
        mockSocketInstances[0]?.emitOpen();

        const rejectionPromise = (async () => {
            try {
                await client.request("slow.method");
            } catch (error) {
                return error;
            }
            throw new Error("Expected request to reject");
        })();
        expect(setTimeoutMock).toHaveBeenCalledTimes(1);
        timeout?.();
        await expect(rejectionPromise).resolves.toThrow("Request timeout");
        setTimeoutSpy.mockRestore();
    });

    it("does not timeout requests that already resolved", async () => {
        let timeout: (() => void) | undefined;
        const setTimeoutMock = jest
            .fn()
            .mockImplementationOnce((handler: TimerHandler) => {
                timeout = handler as () => void;
                return 1;
            });
        const setTimeoutSpy = jest
            .spyOn(window, "setTimeout")
            .mockImplementationOnce(
                setTimeoutMock as unknown as typeof window.setTimeout
            );
        const client = createSocketClient({ url: "ws://localhost" });
        client.connect();
        mockSocketInstances[0]?.emitOpen();

        const promise = client.request("fast.method");
        expect(setTimeoutMock).toHaveBeenCalledTimes(1);
        mockSocketInstances[0]?.emitMessage({
            type: "res",
            id: "1",
            ok: true,
            payload: "done",
        });

        await expect(promise).resolves.toBe("done");
        timeout?.();
        expect(mockSocketInstances[0]?.sent).toHaveLength(1);
        setTimeoutSpy.mockRestore();
    });

    it("reconnects after close while reconnect is enabled", () => {
        let reconnect: (() => void) | undefined;
        const setTimeoutMock = jest
            .fn()
            .mockImplementationOnce((handler: TimerHandler) => {
                reconnect = handler as () => void;
                return 1;
            });
        const setTimeoutSpy = jest
            .spyOn(window, "setTimeout")
            .mockImplementationOnce(
                setTimeoutMock as unknown as typeof window.setTimeout
            );
        const client = createSocketClient({ url: "ws://localhost" });
        client.connect();
        expect(mockSocketInstances).toHaveLength(1);

        mockSocketInstances[0]?.emitClose();
        reconnect?.();
        expect(mockSocketInstances).toHaveLength(2);
        setTimeoutSpy.mockRestore();
    });

    it("skips reconnect when disconnected before the retry fires", () => {
        let reconnect: (() => void) | undefined;
        const setTimeoutMock = jest
            .fn()
            .mockImplementationOnce((handler: TimerHandler) => {
                reconnect = handler as () => void;
                return 1;
            });
        const setTimeoutSpy = jest
            .spyOn(window, "setTimeout")
            .mockImplementationOnce(
                setTimeoutMock as unknown as typeof window.setTimeout
            );
        const client = createSocketClient({ url: "ws://localhost" });
        client.connect();
        expect(mockSocketInstances).toHaveLength(1);

        mockSocketInstances[0]?.emitClose();
        client.disconnect();
        reconnect?.();

        expect(mockSocketInstances).toHaveLength(1);
        setTimeoutSpy.mockRestore();
    });

    it("does not schedule reconnect for intentional disconnect close events", () => {
        const setTimeoutSpy = jest.spyOn(window, "setTimeout");
        const client = createSocketClient({ url: "ws://localhost" });
        client.connect();
        const socket = mockSocketInstances[0];

        client.disconnect();
        socket?.emitClose();

        expect(mockSocketInstances).toHaveLength(1);
        expect(setTimeoutSpy).not.toHaveBeenCalled();
        setTimeoutSpy.mockRestore();
    });
});
