import * as v from "valibot";

import { jsonObjectSchema, parseJsonText, type JsonObject } from "./json.ts";

const frameLengthBytes = 4;
const frameKindBytes = 1;
const outputSequenceBytes = 8;
const controlFrameKind = 1;
const inputFrameKind = 2;
const outputFrameKind = 3;

export const terminalBrokerControlMaximumBytes = 32 * 1024;
export const terminalBrokerInputMaximumBytes = 16 * 1024;
export const terminalBrokerOutputMaximumBytes = 32 * 1024;
export const terminalBrokerFrameMaximumBytes = 64 * 1024;
export const terminalBrokerReadChunkMaximumBytes = terminalBrokerFrameMaximumBytes * 4;

export type TerminalBrokerFrame =
    | Readonly<{ kind: "control"; message: JsonObject }>
    | Readonly<{ data: Uint8Array; kind: "input" }>
    | Readonly<{ data: Uint8Array; kind: "output"; sequence: number }>;

export class TerminalBrokerProtocolError extends Error {
    public constructor() {
        super("Terminal broker protocol failed");
        this.name = "TerminalBrokerProtocolError";
    }
}

function framed(kind: number, payload: Uint8Array): Uint8Array {
    const bodyLength = frameKindBytes + payload.byteLength;
    if (bodyLength > terminalBrokerFrameMaximumBytes) {
        throw new TerminalBrokerProtocolError();
    }
    const frame = new Uint8Array(frameLengthBytes + bodyLength);
    new DataView(frame.buffer).setUint32(0, bodyLength, false);
    frame[frameLengthBytes] = kind;
    frame.set(payload, frameLengthBytes + frameKindBytes);
    return frame;
}

/**
 * Encodes one bounded JSON control message.
 * @param message JSON control payload.
 * @returns One length-prefixed control frame.
 */
export function encodeTerminalBrokerControl(message: JsonObject): Uint8Array {
    const parsed = v.safeParse(jsonObjectSchema, message, { abortEarly: true });
    if (!parsed.success) throw new TerminalBrokerProtocolError();
    const payload = new TextEncoder().encode(JSON.stringify(parsed.output));
    if (payload.byteLength > terminalBrokerControlMaximumBytes) {
        throw new TerminalBrokerProtocolError();
    }
    return framed(controlFrameKind, payload);
}

/**
 * Encodes raw PTY input without text conversion.
 * @param data Raw input bytes.
 * @returns One length-prefixed input frame.
 */
export function encodeTerminalBrokerInput(data: Uint8Array): Uint8Array {
    if (data.byteLength > terminalBrokerInputMaximumBytes) {
        throw new TerminalBrokerProtocolError();
    }
    return framed(inputFrameKind, new Uint8Array(data));
}

/**
 * Encodes one sequenced raw PTY output fragment.
 * @param sequence Positive output sequence.
 * @param data Raw output bytes.
 * @returns One length-prefixed output frame.
 */
export function encodeTerminalBrokerOutput(
    sequence: number,
    data: Uint8Array
): Uint8Array {
    if (
        !Number.isSafeInteger(sequence) ||
        sequence < 1 ||
        data.byteLength > terminalBrokerOutputMaximumBytes
    ) {
        throw new TerminalBrokerProtocolError();
    }
    const payload = new Uint8Array(outputSequenceBytes + data.byteLength);
    new DataView(payload.buffer).setBigUint64(0, BigInt(sequence), false);
    payload.set(data, outputSequenceBytes);
    return framed(outputFrameKind, payload);
}

function decodeControl(payload: Uint8Array): TerminalBrokerFrame {
    if (payload.byteLength > terminalBrokerControlMaximumBytes) {
        throw new TerminalBrokerProtocolError();
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    const parsed = v.safeParse(jsonObjectSchema, parseJsonText(text), {
        abortEarly: true,
    });
    if (!parsed.success) throw new TerminalBrokerProtocolError();
    return Object.freeze({ kind: "control", message: parsed.output });
}

function decodeOutput(payload: Uint8Array): TerminalBrokerFrame {
    if (
        payload.byteLength < outputSequenceBytes ||
        payload.byteLength - outputSequenceBytes > terminalBrokerOutputMaximumBytes
    ) {
        throw new TerminalBrokerProtocolError();
    }
    const sequence = new DataView(
        payload.buffer,
        payload.byteOffset,
        outputSequenceBytes
    ).getBigUint64(0, false);
    if (sequence < 1n || sequence > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new TerminalBrokerProtocolError();
    }
    return Object.freeze({
        data: payload.slice(outputSequenceBytes),
        kind: "output",
        sequence: Number(sequence),
    });
}

function decodeFrame(kind: number, payload: Uint8Array): TerminalBrokerFrame {
    if (kind === controlFrameKind) return decodeControl(payload);
    if (kind === inputFrameKind) {
        if (payload.byteLength > terminalBrokerInputMaximumBytes) {
            throw new TerminalBrokerProtocolError();
        }
        return Object.freeze({ data: new Uint8Array(payload), kind: "input" });
    }
    if (kind === outputFrameKind) return decodeOutput(payload);
    throw new TerminalBrokerProtocolError();
}

/** Incremental bounded decoder for Unix-stream fragmentation and frame coalescing. */
export class TerminalBrokerFrameDecoder {
    #pending = new Uint8Array();

    public push(chunk: Uint8Array): readonly TerminalBrokerFrame[] {
        if (
            chunk.byteLength === 0 ||
            chunk.byteLength > terminalBrokerReadChunkMaximumBytes ||
            this.#pending.byteLength + chunk.byteLength >
                terminalBrokerReadChunkMaximumBytes
        ) {
            this.#pending = new Uint8Array();
            throw new TerminalBrokerProtocolError();
        }
        const bytes = new Uint8Array(this.#pending.byteLength + chunk.byteLength);
        bytes.set(this.#pending);
        bytes.set(chunk, this.#pending.byteLength);
        const frames: TerminalBrokerFrame[] = [];
        let offset = 0;
        try {
            while (bytes.byteLength - offset >= frameLengthBytes) {
                const bodyLength = new DataView(
                    bytes.buffer,
                    bytes.byteOffset + offset,
                    frameLengthBytes
                ).getUint32(0, false);
                if (
                    bodyLength < frameKindBytes ||
                    bodyLength > terminalBrokerFrameMaximumBytes
                ) {
                    throw new TerminalBrokerProtocolError();
                }
                const frameLength = frameLengthBytes + bodyLength;
                if (bytes.byteLength - offset < frameLength) break;
                const kind = bytes[offset + frameLengthBytes];
                if (kind === undefined) throw new TerminalBrokerProtocolError();
                const payload = bytes.slice(
                    offset + frameLengthBytes + frameKindBytes,
                    offset + frameLength
                );
                frames.push(decodeFrame(kind, payload));
                offset += frameLength;
            }
            this.#pending = bytes.slice(offset);
            return frames;
        } catch (error) {
            this.#pending = new Uint8Array();
            throw error;
        }
    }

    public finish(): void {
        if (this.#pending.byteLength !== 0) {
            this.#pending = new Uint8Array();
            throw new TerminalBrokerProtocolError();
        }
    }
}
