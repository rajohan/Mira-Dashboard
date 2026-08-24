import { createHash } from "node:crypto";

const webSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const headerTerminator = Buffer.from("\r\n\r\n", "ascii");
export const maximumRawWebSocketFixtureOutboundBytes = 128 * 1024;

export const maximumRawWebSocketHandshakeBytes = 16 * 1024;
export const maximumRawWebSocketPeerBytes = 128 * 1024;

export const fragmentedUtf8Message = "Mira says: blåbær 🦀 ferdig";
export const oversizedScenarioMessageBytes = 64 * 1024 + 1;

export type RawWebSocketScenario =
    | "close-before-message"
    | "fragmented-utf8"
    | "interleaved-text-fragments"
    | "invalid-64-bit-length"
    | "message-then-close"
    | "orphan-continuation"
    | "oversized-text"
    | "silent";

export interface DecodedClientFrame {
    readonly fin: boolean;
    readonly opcode: number;
    readonly payload: Buffer;
}

export interface DecodedClientFrames {
    readonly frames: readonly DecodedClientFrame[];
    readonly remaining: Buffer;
}

export interface FragmentedUtf8Evidence {
    readonly completeBytes: Buffer;
    readonly fragments: readonly Buffer[];
    readonly frames: readonly Buffer[];
    readonly splitCodePointBytes: Buffer;
}

export interface ParsedUpgradeRequest {
    readonly response: Buffer;
    readonly remaining: Buffer;
}

function asBoundedPayload(payload: string | Uint8Array): Buffer {
    const bytes =
        typeof payload === "string"
            ? Buffer.from(payload, "utf8")
            : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    if (bytes.byteLength > maximumRawWebSocketFixtureOutboundBytes) {
        throw new RangeError("WebSocket fixture payload exceeded its byte budget");
    }
    return bytes;
}

/**
 * Encodes one unmasked server-to-client RFC 6455 frame.
 * @param opcode RFC 6455 frame opcode.
 * @param payload Frame payload.
 * @param fin Whether this frame completes its message.
 * @returns Encoded frame bytes.
 */
export function encodeServerFrame(
    opcode: number,
    payload: string | Uint8Array,
    fin = true
): Buffer {
    if (!Number.isInteger(opcode) || opcode < 0 || opcode > 15) {
        throw new RangeError("WebSocket fixture opcode is invalid");
    }
    const bytes = asBoundedPayload(payload);
    let extendedLengthBytes = 0;
    if (bytes.byteLength > 65_535) {
        extendedLengthBytes = 8;
    } else if (bytes.byteLength > 125) {
        extendedLengthBytes = 2;
    }
    const frame = Buffer.allocUnsafe(2 + extendedLengthBytes + bytes.byteLength);
    frame[0] = (fin ? 0x80 : 0) | opcode;
    if (extendedLengthBytes === 0) {
        frame[1] = bytes.byteLength;
    } else if (extendedLengthBytes === 2) {
        frame[1] = 126;
        frame.writeUInt16BE(bytes.byteLength, 2);
    } else {
        frame[1] = 127;
        frame.writeBigUInt64BE(BigInt(bytes.byteLength), 2);
    }
    bytes.copy(frame, 2 + extendedLengthBytes);
    return frame;
}

/**
 * Encodes a server close frame.
 * @param code RFC 6455 close code.
 * @param reason UTF-8 close reason.
 * @returns Encoded close-frame bytes.
 */
export function encodeServerCloseFrame(code: number, reason = ""): Buffer {
    if (!Number.isInteger(code) || code < 1000 || code > 4999) {
        throw new RangeError("WebSocket fixture close code is invalid");
    }
    const reasonBytes = Buffer.from(reason, "utf8");
    if (reasonBytes.byteLength > 123) {
        throw new RangeError("WebSocket fixture close reason exceeded 123 bytes");
    }
    const payload = Buffer.allocUnsafe(2 + reasonBytes.byteLength);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    return encodeServerFrame(0x08, payload);
}

function parseHeaderLines(headerBytes: Buffer): Map<string, string> {
    const lines = headerBytes.toString("latin1").split("\r\n");
    if (lines.shift() !== "GET /integration HTTP/1.1") {
        throw new Error("WebSocket fixture received an unexpected request target");
    }
    const headers = new Map<string, string>();
    for (const line of lines) {
        const separator = line.indexOf(":");
        if (separator <= 0) {
            throw new Error("WebSocket fixture received a malformed header");
        }
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        if (headers.has(name)) {
            throw new Error(`WebSocket fixture received duplicate ${name} header`);
        }
        headers.set(name, value);
    }
    return headers;
}

function hasHeaderToken(value: string | undefined, expected: string): boolean {
    return (
        value?.split(",").some((token) => token.trim().toLowerCase() === expected) ??
        false
    );
}

function createUpgradeResponse(key: string): Buffer {
    // RFC 6455 section 4.2.2 mandates SHA-1 for Sec-WebSocket-Accept; this is
    // protocol framing, not a cryptographic integrity or credential decision.
    const accept = createHash("sha1") // lgtm[js/weak-cryptographic-algorithm]
        .update(`${key}${webSocketGuid}`, "ascii")
        .digest("base64");
    return Buffer.from(
        [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            "",
            "",
        ].join("\r\n"),
        "ascii"
    );
}

/**
 * Parses one bounded native WebSocket upgrade request.
 * @param bytes Incremental raw HTTP request bytes.
 * @returns A response and any bytes received after the HTTP headers, or undefined while pending.
 */
export function parseUpgradeRequest(bytes: Buffer): ParsedUpgradeRequest | undefined {
    if (bytes.byteLength > maximumRawWebSocketHandshakeBytes) {
        throw new Error("WebSocket fixture handshake exceeded its byte budget");
    }
    const headerEnd = bytes.indexOf(headerTerminator);
    if (headerEnd === -1) return undefined;
    const headers = parseHeaderLines(bytes.subarray(0, headerEnd));
    if (!hasHeaderToken(headers.get("connection"), "upgrade")) {
        throw new Error("WebSocket fixture requires Connection: Upgrade");
    }
    if (headers.get("upgrade")?.toLowerCase() !== "websocket") {
        throw new Error("WebSocket fixture requires Upgrade: websocket");
    }
    if (headers.get("sec-websocket-version") !== "13") {
        throw new Error("WebSocket fixture requires RFC 6455 version 13");
    }
    const key = headers.get("sec-websocket-key");
    if (key === undefined || !/^[A-Za-z\d+/]{22}==$/u.test(key)) {
        throw new Error("WebSocket fixture received an invalid WebSocket key");
    }
    if (Buffer.from(key, "base64").byteLength !== 16) {
        throw new Error("WebSocket fixture received a non-128-bit WebSocket key");
    }
    return {
        remaining: bytes.subarray(headerEnd + headerTerminator.byteLength),
        response: createUpgradeResponse(key),
    };
}

function readPayloadLength(
    bytes: Buffer,
    offset: number,
    shortLength: number
): { readonly headerBytes: number; readonly payloadBytes: number } | undefined {
    if (shortLength <= 125) {
        return { headerBytes: offset, payloadBytes: shortLength };
    }
    if (shortLength === 126) {
        if (bytes.byteLength < offset + 2) return undefined;
        return { headerBytes: offset + 2, payloadBytes: bytes.readUInt16BE(offset) };
    }
    if (bytes.byteLength < offset + 8) return undefined;
    const payloadBytes = bytes.readBigUInt64BE(offset);
    if (payloadBytes > BigInt(maximumRawWebSocketPeerBytes)) {
        throw new Error("WebSocket fixture peer frame exceeded its byte budget");
    }
    return { headerBytes: offset + 8, payloadBytes: Number(payloadBytes) };
}

/**
 * Incrementally decodes bounded, masked client-to-server frames.
 * @param bytes Raw bytes retained for one fixture connection.
 * @returns Complete frames and the incomplete suffix.
 */
export function decodeClientFrames(bytes: Buffer): DecodedClientFrames {
    const frames: DecodedClientFrame[] = [];
    let cursor = 0;
    while (bytes.byteLength - cursor >= 2) {
        const first = bytes[cursor] ?? 0;
        const second = bytes[cursor + 1] ?? 0;
        if ((first & 0x70) !== 0) {
            throw new Error("WebSocket fixture peer frame used reserved bits");
        }
        if ((second & 0x80) === 0) {
            throw new Error("WebSocket fixture peer frame was not masked");
        }
        const length = readPayloadLength(bytes, cursor + 2, second & 127);
        if (length === undefined) break;
        if (length.payloadBytes > maximumRawWebSocketPeerBytes) {
            throw new Error("WebSocket fixture peer frame exceeded its byte budget");
        }
        const maskOffset = length.headerBytes;
        const payloadOffset = maskOffset + 4;
        const frameEnd = payloadOffset + length.payloadBytes;
        if (bytes.byteLength < frameEnd) break;
        const payload = Buffer.allocUnsafe(length.payloadBytes);
        for (let index = 0; index < length.payloadBytes; index += 1) {
            payload[index] =
                (bytes[payloadOffset + index] ?? 0) ^
                (bytes[maskOffset + (index % 4)] ?? 0);
        }
        frames.push({
            fin: (first & 0x80) !== 0,
            opcode: first & 15,
            payload,
        });
        cursor = frameEnd;
    }
    return { frames, remaining: bytes.subarray(cursor) };
}

/**
 * Creates fragments that split the crab emoji inside its four-byte UTF-8 sequence.
 * @returns The raw fragments, encoded frames, and split code-point evidence.
 */
export function createFragmentedUtf8Evidence(): FragmentedUtf8Evidence {
    const completeBytes = Buffer.from(fragmentedUtf8Message, "utf8");
    const codePointBytes = Buffer.from("🦀", "utf8");
    const codePointOffset = completeBytes.indexOf(codePointBytes);
    if (codePointOffset === -1) {
        throw new Error("WebSocket scenario message lost its split code point");
    }
    const fragments = [
        completeBytes.subarray(0, codePointOffset + 2),
        completeBytes.subarray(codePointOffset + 2, codePointOffset + 3),
        completeBytes.subarray(codePointOffset + 3),
    ];
    return {
        completeBytes,
        fragments,
        frames: [
            encodeServerFrame(0x01, fragments[0] ?? Buffer.alloc(0), false),
            encodeServerFrame(0x00, fragments[1] ?? Buffer.alloc(0), false),
            encodeServerFrame(0x00, fragments[2] ?? Buffer.alloc(0)),
        ],
        splitCodePointBytes: completeBytes.subarray(
            codePointOffset,
            codePointOffset + codePointBytes.byteLength
        ),
    };
}

/**
 * Creates the raw post-upgrade bytes for one native WebSocket scenario.
 * @param scenario Scenario selected by a focused integration check.
 * @returns Bounded RFC 6455 bytes sent by the raw TCP fixture.
 */
export function createScenarioBytes(scenario: RawWebSocketScenario): Buffer {
    let frames: readonly Buffer[];
    switch (scenario) {
        case "close-before-message": {
            frames = [encodeServerCloseFrame(1000, "fixture complete")];
            break;
        }
        case "fragmented-utf8": {
            frames = createFragmentedUtf8Evidence().frames;
            break;
        }
        case "interleaved-text-fragments": {
            frames = [
                encodeServerFrame(0x01, "first", false),
                encodeServerFrame(0x01, "illegal second message"),
            ];
            break;
        }
        case "invalid-64-bit-length": {
            frames = [Buffer.from([0x81, 127, 0x80, 0, 0, 0, 0, 0, 0, 0])];
            break;
        }
        case "message-then-close": {
            frames = [
                encodeServerFrame(0x01, "first outcome wins"),
                encodeServerCloseFrame(1000, "fixture complete"),
            ];
            break;
        }
        case "orphan-continuation": {
            frames = [encodeServerFrame(0x00, "orphan")];
            break;
        }
        case "oversized-text": {
            frames = [
                encodeServerFrame(
                    0x01,
                    Buffer.alloc(oversizedScenarioMessageBytes, 0x61)
                ),
            ];
            break;
        }
        case "silent": {
            frames = [encodeServerFrame(0x09, "ready")];
            break;
        }
    }
    const bytes = Buffer.concat(frames);
    if (bytes.byteLength > maximumRawWebSocketFixtureOutboundBytes) {
        throw new Error("WebSocket fixture scenario exceeded its byte budget");
    }
    return bytes;
}
