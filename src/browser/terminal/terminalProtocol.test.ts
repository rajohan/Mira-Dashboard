import { describe, expect, jest, test } from "bun:test";

import {
    terminalBinaryOutputHeaderBytes,
    terminalBinaryOutputKind,
    terminalClientMessageMaximumBytes,
    type TerminalConnectionTicket,
    terminalSocketBufferedMaximumBytes,
} from "../../contracts/terminal.ts";
import {
    createTerminalSocketConnection,
    resolveTerminalWebSocketUrl,
    TerminalBrowserProtocolError,
    type TerminalWebSocketLike,
} from "./terminalProtocol.ts";

const sessionId = "019fe7a8-03fe-7000-8ea2-874b1ea1b40e";
const connectionToken = `${"a".repeat(32)}.${"b".repeat(64)}`;
const ticket: TerminalConnectionTicket = Object.freeze({
    afterSequence: 0,
    connectionToken,
    expiresAtMs: 1_800_000_060_000,
    sessionId,
    webSocketProtocol: "mira-terminal-v1",
    webSocketUrl: `/api/terminal/sessions/${sessionId}/socket`,
});
const summary = Object.freeze({
    dimensions: { columns: 100, rows: 30 },
    expiresAtMs: 1_800_001_800_000,
    idleExpiresAtMs: 1_800_000_600_000,
    location: { path: "/", rootId: "dashboard" },
    nextSequence: 1,
    replayAvailableFromSequence: 1,
    sessionId,
    startedAtMs: 1_800_000_000_000,
    state: "connected" as const,
});

class FakeWebSocket implements TerminalWebSocketLike {
    public binaryType: BinaryType = "blob";
    public bufferedAmount = 0;
    public protocol = "";
    public readyState = 0;
    public readonly closeCalls: { code?: number; reason?: string }[] = [];
    public readonly sent: (ArrayBuffer | ArrayBufferView<ArrayBuffer> | string)[] = [];
    readonly #closeListeners: ((event: CloseEvent) => void)[] = [];
    readonly #errorListeners: ((event: Event) => void)[] = [];
    readonly #messageListeners: ((event: MessageEvent<unknown>) => void)[] = [];
    readonly #openListeners: ((event: Event) => void)[] = [];

    public addEventListener(
        type: "close" | "error" | "message" | "open",
        listener:
            | ((event: CloseEvent) => void)
            | ((event: Event) => void)
            | ((event: MessageEvent<unknown>) => void)
    ): void {
        switch (type) {
            case "close": {
                this.#closeListeners.push(listener as (event: CloseEvent) => void);
                return;
            }
            case "error": {
                this.#errorListeners.push(listener as (event: Event) => void);
                return;
            }
            case "message": {
                this.#messageListeners.push(
                    listener as (event: MessageEvent<unknown>) => void
                );
                return;
            }
            case "open": {
                this.#openListeners.push(listener as (event: Event) => void);
            }
        }
    }

    public close(code?: number, reason?: string): void {
        this.closeCalls.push({
            ...(code === undefined ? {} : { code }),
            ...(reason === undefined ? {} : { reason }),
        });
        this.readyState = 2;
    }

    public emitClose(): void {
        this.readyState = 3;
        for (const listener of this.#closeListeners) {
            listener(new CloseEvent("close"));
        }
    }

    public emitMessage(data: unknown): void {
        for (const listener of this.#messageListeners) {
            listener(new MessageEvent("message", { data }));
        }
    }

    public emitOpen(protocol = ticket.webSocketProtocol): void {
        this.protocol = protocol;
        this.readyState = 1;
        for (const listener of this.#openListeners) listener(new Event("open"));
    }

    public send(data: ArrayBuffer | ArrayBufferView<ArrayBuffer> | string): void {
        this.sent.push(data);
    }
}

function readyMessage(): string {
    return JSON.stringify({
        replayAvailableFromSequence: 1,
        resumed: false,
        session: summary,
        type: "ready",
    });
}

function outputFrame(sequence: number, payload: readonly number[]): ArrayBuffer {
    const frame = new Uint8Array(terminalBinaryOutputHeaderBytes + payload.length);
    frame[0] = terminalBinaryOutputKind;
    new DataView(frame.buffer).setBigUint64(1, BigInt(sequence), false);
    frame.set(payload, terminalBinaryOutputHeaderBytes);
    return frame.buffer;
}

function sentInputFrames(socket: FakeWebSocket): Uint8Array[] {
    return socket.sent
        .filter((value): value is Uint8Array<ArrayBuffer> => value instanceof Uint8Array)
        .map((value) => new Uint8Array(value));
}

function createHarness() {
    const socket = new FakeWebSocket();
    const controls: unknown[] = [];
    const outputs: { bytes: Uint8Array; sequence: number }[] = [];
    const closes: unknown[] = [];
    let inputBackpressure = 0;
    let inputDrains = 0;
    let opened = 0;
    let createdUrl = "";
    let createdProtocols: readonly string[] = [];
    const connection = createTerminalSocketConnection({
        callbacks: {
            onClose: (event) => closes.push(event),
            onControl: (event) => controls.push(event),
            onInputBackpressure: () => {
                inputBackpressure += 1;
            },
            onInputDrain: () => {
                inputDrains += 1;
            },
            onOpen: () => {
                opened += 1;
            },
            onOutput(bytes, sequence) {
                outputs.push({ bytes: new Uint8Array(bytes), sequence });
                return true;
            },
        },
        location: {
            href: "https://dashboard.test/terminal",
            origin: "https://dashboard.test",
            protocol: "https:",
        },
        ticket,
        webSocketFactory(url, protocols) {
            createdUrl = url;
            createdProtocols = protocols;
            return socket;
        },
    });
    return {
        closes,
        connection,
        controls,
        get createdProtocols() {
            return createdProtocols;
        },
        get createdUrl() {
            return createdUrl;
        },
        get inputBackpressure() {
            return inputBackpressure;
        },
        get inputDrains() {
            return inputDrains;
        },
        get opened() {
            return opened;
        },
        outputs,
        socket,
    };
}

describe("interactive terminal browser protocol", () => {
    test("presents the one-time ticket only as a same-origin WebSocket subprotocol", () => {
        const harness = createHarness();

        expect(harness.createdUrl).toBe(
            `wss://dashboard.test/api/terminal/sessions/${sessionId}/socket`
        );
        expect(harness.createdUrl).not.toContain(connectionToken);
        expect(harness.createdProtocols).toEqual(["mira-terminal-v1", connectionToken]);
        expect(harness.socket.binaryType).toBe("arraybuffer");

        harness.socket.emitOpen();
        expect(harness.opened).toBe(1);
        harness.connection.close();
        harness.socket.emitClose();
    });

    test("renders sequenced raw ANSI bytes without decoding or duplicating them", () => {
        const harness = createHarness();
        harness.socket.emitOpen();
        harness.socket.emitMessage(readyMessage());
        harness.socket.emitMessage(outputFrame(1, [27, 91, 51, 49, 109, 255]));

        expect(harness.controls[0]).toMatchObject({ type: "ready" });
        expect(harness.outputs).toEqual([
            {
                bytes: new Uint8Array([27, 91, 51, 49, 109, 255]),
                sequence: 1,
            },
        ]);
        expect(harness.connection.afterSequence).toBe(1);
        harness.connection.close();
        harness.socket.emitClose();
    });

    test("closes on a sequence gap instead of presenting an incomplete stream", () => {
        const harness = createHarness();
        harness.socket.emitOpen();
        harness.socket.emitMessage(readyMessage());
        harness.socket.emitMessage(outputFrame(2, [65]));
        expect(harness.outputs).toHaveLength(0);
        expect(harness.socket.closeCalls.at(-1)).toMatchObject({ code: 1002 });

        harness.socket.emitClose();
        expect(harness.closes).toEqual([
            { afterSequence: 0, expected: false, kind: "protocol" },
        ]);
    });

    test("accepts a bounded handshake error without trusting its server message", () => {
        const harness = createHarness();
        harness.socket.emitOpen();
        harness.socket.emitMessage(
            JSON.stringify({
                code: "unavailable",
                message: "Untrusted adapter detail",
                type: "error",
            })
        );
        expect(harness.controls).toEqual([
            {
                code: "unavailable",
                message: "Untrusted adapter detail",
                type: "error",
            },
        ]);
        harness.socket.emitClose();
        expect(harness.closes).toEqual([
            { afterSequence: 0, expected: true, kind: "transport" },
        ]);
    });

    test("queues the triggering slow-consumer input and drains raw bytes in FIFO order", () => {
        jest.useFakeTimers();
        const harness = createHarness();
        try {
            harness.socket.emitOpen();
            harness.socket.emitMessage(readyMessage());
            const initialInput = new Uint8Array(
                terminalClientMessageMaximumBytes + 7
            ).fill(65);

            expect(harness.connection.sendInput(initialInput)).toBe(true);
            expect(
                sentInputFrames(harness.socket).map((frame) => frame.byteLength)
            ).toEqual([terminalClientMessageMaximumBytes, 7]);

            harness.socket.bufferedAmount = terminalSocketBufferedMaximumBytes;
            const triggeringInput = new Uint8Array([66, 0, 255]);
            expect(harness.connection.sendInput(triggeringInput)).toBe(true);
            triggeringInput.fill(9);
            expect(harness.connection.sendInput(new Uint8Array([67, 68]))).toBe(true);
            expect(harness.inputBackpressure).toBe(1);
            expect(sentInputFrames(harness.socket)).toHaveLength(2);

            harness.socket.bufferedAmount = 0;
            jest.advanceTimersByTime(100);
            const drainedFrames = sentInputFrames(harness.socket);
            expect(drainedFrames.map((frame) => frame.byteLength)).toEqual([
                terminalClientMessageMaximumBytes,
                7,
                3,
                2,
            ]);
            expect([...drainedFrames[2]!]).toEqual([66, 0, 255]);
            expect([...drainedFrames[3]!]).toEqual([67, 68]);
            expect(harness.inputDrains).toBe(1);
        } finally {
            harness.connection.close();
            harness.socket.emitClose();
            jest.useRealTimers();
        }
    });

    test("bounds the pending input FIFO without partially accepting overflow", () => {
        jest.useFakeTimers();
        const harness = createHarness();
        try {
            harness.socket.emitOpen();
            harness.socket.emitMessage(readyMessage());
            harness.socket.bufferedAmount = terminalSocketBufferedMaximumBytes;
            const maximumQueuedInput = new Uint8Array(
                terminalSocketBufferedMaximumBytes
            ).fill(65);

            expect(harness.connection.sendInput(maximumQueuedInput)).toBe(true);
            expect(harness.connection.sendInput(new Uint8Array([66]))).toBe(false);
            expect(sentInputFrames(harness.socket)).toHaveLength(0);
            expect(harness.inputBackpressure).toBe(1);

            harness.socket.bufferedAmount = 0;
            jest.advanceTimersByTime(100);
            const drainedFrames = sentInputFrames(harness.socket);
            expect(drainedFrames).toHaveLength(
                terminalSocketBufferedMaximumBytes / terminalClientMessageMaximumBytes
            );
            expect(
                drainedFrames.reduce((total, frame) => total + frame.byteLength, 0)
            ).toBe(terminalSocketBufferedMaximumBytes);
            expect(
                drainedFrames.every((frame) => frame.every((byte) => byte === 65))
            ).toBe(true);
            expect(harness.inputDrains).toBe(1);
        } finally {
            harness.connection.close();
            harness.socket.emitClose();
            jest.useRealTimers();
        }
    });

    test("rejects cross-origin resolution before a socket is constructed", () => {
        expect(() =>
            resolveTerminalWebSocketUrl("https://attacker.test/socket", {
                href: "https://dashboard.test/terminal",
                origin: "https://dashboard.test",
                protocol: "https:",
            })
        ).toThrow(TerminalBrowserProtocolError);
    });
});
