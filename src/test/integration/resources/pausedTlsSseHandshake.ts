import * as v from "valibot";

import { nonnegativeSafeIntegerSchema } from "../../../shared/validation.ts";

const connectedFrame = Buffer.from("event: connected\ndata: {}\n\n", "ascii");
const headerTerminator = Buffer.from("\r\n\r\n", "ascii");
const lineTerminator = Buffer.from("\r\n", "ascii");
const maximumChunkSizeLineBytes = 128;
const chunkSizeSchema = nonnegativeSafeIntegerSchema(
    "Paused SSE client received an unsafe chunk size"
);

/** Maximum raw HTTP response prefix retained while establishing the SSE stream. */
export const maximumPausedTlsSseHandshakeBytes = 16 * 1024;

function asBuffer(value: string | Uint8Array): Buffer {
    return typeof value === "string"
        ? Buffer.from(value, "utf8")
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function parseHeaders(value: Uint8Array): Map<string, string> {
    const lines = asBuffer(value).toString("latin1").split("\r\n");
    if (!/^HTTP\/1\.1 200(?: |$)/u.test(lines.shift() ?? "")) {
        throw new Error("Paused SSE client received a non-200 HTTP response");
    }
    const headers = new Map<string, string>();
    for (const line of lines) {
        const separator = line.indexOf(":");
        if (separator <= 0) {
            throw new Error("Paused SSE client received a malformed HTTP header");
        }
        const name = line.slice(0, separator).trim().toLowerCase();
        const value_ = line.slice(separator + 1).trim();
        if (headers.has(name)) {
            throw new Error(`Paused SSE client received duplicate ${name} headers`);
        }
        headers.set(name, value_);
    }
    if (!headers.get("content-type")?.startsWith("text/event-stream")) {
        throw new Error("Paused SSE client received an unexpected content type");
    }
    if (headers.get("transfer-encoding")?.toLowerCase() !== "chunked") {
        throw new Error("Paused SSE client requires chunked streaming transfer");
    }
    const contentEncoding = headers.get("content-encoding")?.toLowerCase();
    if (contentEncoding !== undefined && contentEncoding !== "identity") {
        throw new Error("Paused SSE client requires identity content encoding");
    }
    return headers;
}

function decodeAvailableChunkedBodyPrefix(
    value: Uint8Array,
    maximumBytes: number
): Buffer {
    const buffer = asBuffer(value);
    const chunks: Buffer[] = [];
    let bodyByteLength = 0;
    let cursor = 0;
    while (cursor < buffer.byteLength && bodyByteLength < maximumBytes) {
        const lineEnd = buffer.indexOf(lineTerminator, cursor);
        if (lineEnd === -1) return Buffer.concat(chunks, bodyByteLength);
        const sizeBytes = buffer.subarray(cursor, lineEnd);
        if (sizeBytes.byteLength > maximumChunkSizeLineBytes) {
            throw new Error("Paused SSE client chunk-size line exceeded its byte budget");
        }
        const sizeText = sizeBytes.toString("ascii");
        if (!/^[\da-f]+$/iu.test(sizeText)) {
            throw new Error("Paused SSE client received an invalid chunk size");
        }
        const size = Number.parseInt(sizeText, 16);
        if (!v.safeParse(chunkSizeSchema, size, { abortEarly: true }).success) {
            throw new TypeError("Paused SSE client received an unsafe chunk size");
        }
        cursor = lineEnd + 2;
        const availablePayloadBytes = Math.min(size, buffer.byteLength - cursor);
        const copiedPayloadBytes = Math.min(
            availablePayloadBytes,
            maximumBytes - bodyByteLength
        );
        const payload = buffer.subarray(cursor, cursor + copiedPayloadBytes);
        if (copiedPayloadBytes < size) {
            chunks.push(payload);
            bodyByteLength += copiedPayloadBytes;
            return Buffer.concat(chunks, bodyByteLength);
        }
        const payloadEnd = cursor + size;
        if (buffer.byteLength < payloadEnd + 2) {
            return Buffer.concat(chunks, bodyByteLength);
        }
        if (!buffer.subarray(payloadEnd, payloadEnd + 2).equals(lineTerminator)) {
            throw new Error("Paused SSE client received an invalid chunk terminator");
        }
        chunks.push(payload);
        bodyByteLength += copiedPayloadBytes;
        cursor = payloadEnd + 2;
        if (bodyByteLength === maximumBytes) {
            return Buffer.concat(chunks, bodyByteLength);
        }
        if (size === 0) return Buffer.concat(chunks, bodyByteLength);
    }
    return Buffer.concat(chunks, bodyByteLength);
}

function connectedSseFrameInBytes(bytes: Buffer): boolean {
    const headerEnd = bytes.indexOf(headerTerminator);
    if (headerEnd === -1) return false;
    parseHeaders(bytes.subarray(0, headerEnd));
    const body = decodeAvailableChunkedBodyPrefix(
        bytes.subarray(headerEnd + 4),
        connectedFrame.byteLength
    );
    if (body.byteLength < connectedFrame.byteLength) return false;
    if (!body.subarray(0, connectedFrame.byteLength).equals(connectedFrame)) {
        throw new Error("Paused SSE client received an unexpected connected frame");
    }
    return true;
}

/**
 * Validates a raw HTTP prefix without rejecting a connected frame that arrived in an oversized
 * native socket callback.
 * @param value Incremental raw HTTP response bytes or an ASCII test fixture.
 * @returns Whether the complete connected frame occurs within the fixed prefix budget.
 */
export function hasConnectedSseFrame(value: string | Uint8Array): boolean {
    const bytes = asBuffer(value);
    const connected = connectedSseFrameInBytes(
        bytes.subarray(0, maximumPausedTlsSseHandshakeBytes)
    );
    if (connected) return true;
    if (bytes.byteLength > maximumPausedTlsSseHandshakeBytes) {
        throw new Error("Paused SSE client handshake exceeded its byte budget");
    }
    return false;
}
