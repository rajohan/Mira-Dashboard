import * as v from "valibot";

import {
    terminalBinaryOutputHeaderBytes,
    terminalBinaryOutputKind,
    terminalClientMessageMaximumBytes,
    terminalClientMessageSchema,
    type TerminalClientMessage,
    type TerminalConnectionTicket,
    terminalServerMessageMaximumBytes,
    terminalServerMessageSchema,
    type TerminalServerMessage,
    terminalSocketBufferedMaximumBytes,
} from "../../contracts/terminal.ts";

const webSocketConnecting = 0;
const webSocketOpen = 1;
const normalClosureCode = 1000;
const protocolClosureCode = 1002;
const unsupportedDataClosureCode = 1003;
const messageTooLargeClosureCode = 1009;
const inputDrainThresholdBytes = Math.floor(terminalSocketBufferedMaximumBytes / 2);
const inputDrainPollMs = 50;
const pendingInputMaximumFrames =
    terminalSocketBufferedMaximumBytes / terminalClientMessageMaximumBytes;

export interface TerminalWebSocketLike {
    binaryType: BinaryType;
    readonly bufferedAmount: number;
    readonly protocol: string;
    readonly readyState: number;
    close(code?: number, reason?: string): void;
    addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
    addEventListener(type: "error", listener: (event: Event) => void): void;
    addEventListener(
        type: "message",
        listener: (event: MessageEvent<unknown>) => void
    ): void;
    addEventListener(type: "open", listener: (event: Event) => void): void;
    send(data: ArrayBufferView<ArrayBuffer> | ArrayBuffer | string): void;
}

export type TerminalWebSocketFactory = (
    url: string,
    protocols: readonly string[]
) => TerminalWebSocketLike;

export interface TerminalSocketClose {
    readonly afterSequence: number;
    readonly expected: boolean;
    readonly kind: "closed" | "protocol" | "transport";
}

export interface TerminalSocketCallbacks {
    readonly onClose: (event: TerminalSocketClose) => void;
    readonly onControl: (message: TerminalServerMessage) => void;
    readonly onInputBackpressure: () => void;
    readonly onInputDrain: () => void;
    readonly onOpen: () => void;
    readonly onOutput: (data: Uint8Array, sequence: number) => boolean;
}

export interface TerminalSocketConnection {
    readonly afterSequence: number;
    close(): void;
    sendControl(message: TerminalClientMessage): boolean;
    /** Copies raw bytes into the bounded FIFO; true means the whole chunk was accepted. */
    sendInput(data: Uint8Array): boolean;
}

export interface CreateTerminalSocketConnectionOptions {
    readonly callbacks: TerminalSocketCallbacks;
    readonly location?: Pick<Location, "href" | "origin" | "protocol">;
    readonly ticket: TerminalConnectionTicket;
    readonly webSocketFactory?: TerminalWebSocketFactory;
}

export class TerminalBrowserProtocolError extends Error {
    public constructor() {
        super("Interactive terminal protocol failed");
        this.name = "TerminalBrowserProtocolError";
    }
}

function productionWebSocketFactory(
    url: string,
    protocols: readonly string[]
): TerminalWebSocketLike {
    return new WebSocket(url, [...protocols]);
}

/**
 * Resolves a contract-validated path onto the current same-origin WS endpoint.
 * @param path Contract-validated root-relative socket path.
 * @param location Current browser location or an isolated test location.
 * @returns Same-host ws/wss URL without a ticket query parameter.
 */
export function resolveTerminalWebSocketUrl(
    path: string,
    location: Pick<Location, "href" | "origin" | "protocol"> = globalThis.location
): string {
    const resolved = new URL(path, location.href);
    if (resolved.origin !== location.origin) throw new TerminalBrowserProtocolError();
    if (location.protocol === "https:") {
        resolved.protocol = "wss:";
    } else if (location.protocol === "http:") {
        resolved.protocol = "ws:";
    } else {
        throw new TerminalBrowserProtocolError();
    }
    return resolved.href;
}

function decodeOutputFrame(
    data: ArrayBuffer,
    expectedSequence: number
): Readonly<{ readonly bytes: Uint8Array; readonly sequence: number }> {
    if (
        data.byteLength < terminalBinaryOutputHeaderBytes ||
        data.byteLength >
            terminalServerMessageMaximumBytes + terminalBinaryOutputHeaderBytes
    ) {
        throw new TerminalBrowserProtocolError();
    }
    const bytes = new Uint8Array(data);
    if (bytes[0] !== terminalBinaryOutputKind) {
        throw new TerminalBrowserProtocolError();
    }
    const encodedSequence = new DataView(
        data,
        1,
        terminalBinaryOutputHeaderBytes - 1
    ).getBigUint64(0, false);
    if (
        encodedSequence > BigInt(Number.MAX_SAFE_INTEGER) ||
        encodedSequence !== BigInt(expectedSequence)
    ) {
        throw new TerminalBrowserProtocolError();
    }
    return Object.freeze({
        bytes: bytes.slice(terminalBinaryOutputHeaderBytes),
        sequence: Number(encodedSequence),
    });
}

function decodeControlFrame(data: string): TerminalServerMessage {
    if (new TextEncoder().encode(data).byteLength > terminalServerMessageMaximumBytes) {
        throw new TerminalBrowserProtocolError();
    }
    let value: unknown;
    try {
        value = JSON.parse(data) as unknown;
    } catch {
        throw new TerminalBrowserProtocolError();
    }
    const parsed = v.safeParse(terminalServerMessageSchema, value, {
        abortEarly: true,
    });
    if (!parsed.success) throw new TerminalBrowserProtocolError();
    return parsed.output;
}

/**
 * Opens one actor-bound same-origin PTY stream. The opaque ticket is presented
 * only as a WebSocket subprotocol value and never placed in a URL or browser store.
 * @param options Ticket, callback, and injectable transport boundary.
 * @returns Bounded socket input/control handle.
 */
export function createTerminalSocketConnection(
    options: CreateTerminalSocketConnectionOptions
): TerminalSocketConnection {
    const callbacks = options.callbacks;
    const { afterSequence, connectionToken, sessionId, webSocketProtocol, webSocketUrl } =
        options.ticket;
    const url = resolveTerminalWebSocketUrl(
        webSocketUrl,
        options.location ?? globalThis.location
    );
    const socket = (options.webSocketFactory ?? productionWebSocketFactory)(url, [
        webSocketProtocol,
        connectionToken,
    ]);
    socket.binaryType = "arraybuffer";
    let lastSequence = afterSequence;
    let ready = false;
    let expectedClose = false;
    let terminal = false;
    let closeKind: TerminalSocketClose["kind"] = "transport";
    let drainTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const pendingInput: Uint8Array[] = [];
    let pendingInputBytes = 0;
    let pendingInputFrames = 0;
    let pendingInputOffset = 0;
    let inputBackpressured = false;

    const clearDrainTimer = () => {
        if (drainTimer !== undefined) globalThis.clearTimeout(drainTimer);
        drainTimer = undefined;
    };
    const clearPendingInput = () => {
        pendingInput.length = 0;
        pendingInputBytes = 0;
        pendingInputFrames = 0;
        pendingInputOffset = 0;
        inputBackpressured = false;
    };
    const closeFor = (kind: TerminalSocketClose["kind"], code: number) => {
        if (terminal) return;
        closeKind = kind;
        clearDrainTimer();
        clearPendingInput();
        if (
            socket.readyState === webSocketConnecting ||
            socket.readyState === webSocketOpen
        ) {
            socket.close(code, "terminal transport closed");
        }
    };
    const flushPendingInput = () => {
        while (pendingInput.length > 0) {
            const bytes = pendingInput[0];
            if (bytes === undefined) return;
            const frameByteLength = Math.min(
                terminalClientMessageMaximumBytes,
                bytes.byteLength - pendingInputOffset
            );
            if (
                socket.bufferedAmount + frameByteLength >
                terminalSocketBufferedMaximumBytes
            ) {
                return;
            }
            const frameEnd = pendingInputOffset + frameByteLength;
            socket.send(bytes.slice(pendingInputOffset, frameEnd));
            pendingInputBytes -= frameByteLength;
            pendingInputFrames -= 1;
            pendingInputOffset = frameEnd;
            if (pendingInputOffset === bytes.byteLength) {
                pendingInput.shift();
                pendingInputOffset = 0;
            }
        }
    };
    const scheduleInputDrainPoll = () => {
        if (drainTimer === undefined) {
            drainTimer = globalThis.setTimeout(pollInputDrain, inputDrainPollMs);
        }
    };
    const pollInputDrain = () => {
        drainTimer = undefined;
        if (terminal || socket.readyState !== webSocketOpen) return;
        flushPendingInput();
        if (
            pendingInputBytes === 0 &&
            socket.bufferedAmount <= inputDrainThresholdBytes
        ) {
            if (inputBackpressured) {
                inputBackpressured = false;
                callbacks.onInputDrain();
            }
            return;
        }
        scheduleInputDrainPoll();
    };
    const markInputBackpressure = () => {
        if (!inputBackpressured) {
            inputBackpressured = true;
            callbacks.onInputBackpressure();
        }
        scheduleInputDrainPoll();
    };

    socket.addEventListener("open", () => {
        if (socket.protocol !== webSocketProtocol) {
            closeFor("protocol", protocolClosureCode);
            return;
        }
        callbacks.onOpen();
    });
    socket.addEventListener("message", (event) => {
        if (terminal) return;
        try {
            if (typeof event.data === "string") {
                const message = decodeControlFrame(event.data);
                if (message.type === "ready") {
                    if (
                        ready ||
                        message.session.sessionId !== sessionId ||
                        message.session.nextSequence <= lastSequence
                    ) {
                        throw new TerminalBrowserProtocolError();
                    }
                    ready = true;
                } else if (
                    !ready &&
                    message.type !== "error" &&
                    message.type !== "exit"
                ) {
                    throw new TerminalBrowserProtocolError();
                }
                callbacks.onControl(message);
                if (message.type === "exit" || message.type === "error") {
                    expectedClose = true;
                }
                return;
            }
            if (!(event.data instanceof ArrayBuffer) || !ready) {
                closeFor("protocol", unsupportedDataClosureCode);
                return;
            }
            const output = decodeOutputFrame(event.data, lastSequence + 1);
            if (!callbacks.onOutput(output.bytes, output.sequence)) {
                closeFor("protocol", messageTooLargeClosureCode);
                return;
            }
            lastSequence = output.sequence;
        } catch {
            closeFor("protocol", protocolClosureCode);
        }
    });
    socket.addEventListener("error", () => {
        closeKind = "transport";
    });
    socket.addEventListener("close", () => {
        if (terminal) return;
        terminal = true;
        clearDrainTimer();
        clearPendingInput();
        callbacks.onClose({
            afterSequence: lastSequence,
            expected: expectedClose,
            kind: closeKind,
        });
    });

    const connection: TerminalSocketConnection = {
        get afterSequence() {
            return lastSequence;
        },
        close() {
            if (terminal) return;
            expectedClose = true;
            closeFor("closed", normalClosureCode);
        },
        sendControl(message) {
            if (terminal || socket.readyState !== webSocketOpen) return false;
            const parsed = v.safeParse(terminalClientMessageSchema, message, {
                abortEarly: true,
            });
            if (!parsed.success) return false;
            const encoded = JSON.stringify(parsed.output);
            const byteLength = new TextEncoder().encode(encoded).byteLength;
            if (
                byteLength > terminalClientMessageMaximumBytes ||
                socket.bufferedAmount + byteLength > terminalSocketBufferedMaximumBytes
            ) {
                markInputBackpressure();
                return false;
            }
            socket.send(encoded);
            return true;
        },
        sendInput(data) {
            if (
                terminal ||
                socket.readyState !== webSocketOpen ||
                data.byteLength === 0
            ) {
                return false;
            }
            const inputFrames = Math.ceil(
                data.byteLength / terminalClientMessageMaximumBytes
            );
            if (
                data.byteLength > terminalSocketBufferedMaximumBytes ||
                pendingInputFrames + inputFrames > pendingInputMaximumFrames ||
                pendingInputBytes + data.byteLength > terminalSocketBufferedMaximumBytes
            ) {
                markInputBackpressure();
                return false;
            }
            pendingInput.push(new Uint8Array(data));
            pendingInputBytes += data.byteLength;
            pendingInputFrames += inputFrames;
            flushPendingInput();
            if (
                pendingInputBytes > 0 ||
                socket.bufferedAmount > inputDrainThresholdBytes
            ) {
                markInputBackpressure();
            }
            return true;
        },
    };
    return Object.freeze(connection);
}
