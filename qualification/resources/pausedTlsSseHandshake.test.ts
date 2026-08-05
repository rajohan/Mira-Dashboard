import { describe, expect, test } from "bun:test";

import { hasConnectedSseFrame } from "./pausedTlsSseHandshake.ts";

const responseHeaders = [
    "HTTP/1.1 200 OK",
    "Content-Type: text/event-stream",
    "Transfer-Encoding: chunked",
    "",
    "",
].join("\r\n");

describe("paused native TLS SSE handshake", () => {
    test("recognizes a connected frame across HTTP chunks", () => {
        const response = [
            responseHeaders,
            "11\r\nevent: connected\n\r\n",
            "9\r\ndata: {}\n\r\n",
            "2\r\n\n\n\r\n",
        ].join("");
        const oversizedResponse = Buffer.concat([
            Buffer.from(response, "ascii"),
            Buffer.alloc(20 * 1024, 120),
        ]);
        expect(hasConnectedSseFrame(response.slice(0, -5))).toBeFalse();
        expect(hasConnectedSseFrame(response)).toBeTrue();
        expect(hasConnectedSseFrame(oversizedResponse)).toBeTrue();
    });

    test("recognizes a connected frame at the start of a large open chunk", () => {
        const response = Buffer.concat([
            Buffer.from(responseHeaders, "ascii"),
            Buffer.from("10000\r\n", "ascii"),
            Buffer.from("event: connected\ndata: {}\n\n", "ascii"),
            Buffer.alloc(20 * 1024, 120),
        ]);

        expect(hasConnectedSseFrame(response)).toBeTrue();
    });

    test("uses HTTP chunk byte lengths before decoding SSE text", () => {
        const nonAsciiPrelude = Buffer.concat([
            Buffer.from(responseHeaders, "ascii"),
            Buffer.from("2\r\n", "ascii"),
            Buffer.from("é", "utf8"),
            Buffer.from("\r\n", "ascii"),
            Buffer.from("1b\r\nevent: connected\ndata: {}\n\n\r\n", "ascii"),
        ]);

        expect(() => hasConnectedSseFrame(nonAsciiPrelude)).toThrow(
            "unexpected connected frame"
        );
    });

    test("rejects invalid status, framing, and unbounded handshakes", () => {
        expect(() =>
            hasConnectedSseFrame(responseHeaders.replace("200 OK", "503 Unavailable"))
        ).toThrow("non-200");
        expect(() =>
            hasConnectedSseFrame(
                responseHeaders.replace("Transfer-Encoding: chunked", "Content-Length: 0")
            )
        ).toThrow("chunked");
        expect(() => hasConnectedSseFrame("x".repeat(16 * 1024 + 1))).toThrow(
            "byte budget"
        );
    });

    test("rejects duplicate and encoded response headers", () => {
        const duplicateContentType = responseHeaders.replace(
            "Content-Type: text/event-stream",
            "Content-Type: text/event-stream\r\ncontent-type: text/event-stream"
        );
        const compressedResponse = responseHeaders.replace(
            "Transfer-Encoding: chunked",
            "Transfer-Encoding: chunked\r\nContent-Encoding: gzip"
        );

        expect(() => hasConnectedSseFrame(duplicateContentType)).toThrow(
            "duplicate content-type"
        );
        expect(() => hasConnectedSseFrame(compressedResponse)).toThrow(
            "identity content encoding"
        );
    });

    test("rejects invalid chunk sizes and terminators", () => {
        const connectedFrame = "event: connected\ndata: {}\n\n";

        expect(() => hasConnectedSseFrame(`${responseHeaders}not-hex\r\n`)).toThrow(
            "invalid chunk size"
        );
        expect(() =>
            hasConnectedSseFrame(`${responseHeaders}20000000000000\r\n`)
        ).toThrow("unsafe chunk size");
        expect(() => hasConnectedSseFrame(`${responseHeaders}2\r\nab!!`)).toThrow(
            "invalid chunk terminator"
        );
        expect(() =>
            hasConnectedSseFrame(`${responseHeaders}1b\r\n${connectedFrame}!!`)
        ).toThrow("invalid chunk terminator");
    });
});
