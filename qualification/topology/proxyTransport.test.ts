import { describe, expect, test } from "bun:test";

import { createProxyResponseBody, stripHopByHopHeaders } from "./proxyTransport.ts";

describe("qualification proxy transport", () => {
    test("strips fixed and Connection-nominated headers", () => {
        const source = new Headers({
            connection: " X-Hop,\tx-second, , X-HOP, close ",
            "keep-alive": "timeout=5",
            "proxy-authenticate": "Basic",
            "proxy-authorization": "Basic credential",
            "proxy-connection": "keep-alive",
            te: "trailers",
            trailer: "x-checksum",
            "transfer-encoding": "chunked",
            upgrade: "websocket",
            "x-end-to-end": "preserved",
            "x-hop": "remove",
            "x-second": "remove",
        });

        const headers = stripHopByHopHeaders(source);

        expect(headers.get("connection")).toBeNull();
        expect(headers.get("keep-alive")).toBeNull();
        expect(headers.get("proxy-authenticate")).toBeNull();
        expect(headers.get("proxy-authorization")).toBeNull();
        expect(headers.get("proxy-connection")).toBeNull();
        expect(headers.get("te")).toBeNull();
        expect(headers.get("trailer")).toBeNull();
        expect(headers.get("transfer-encoding")).toBeNull();
        expect(headers.get("upgrade")).toBeNull();
        expect(headers.get("x-hop")).toBeNull();
        expect(headers.get("x-second")).toBeNull();
        expect(headers.get("x-end-to-end")).toBe("preserved");
    });

    test("rejects malformed Connection options", () => {
        const source = new Headers({
            connection: '"x-hop"',
            "x-hop": "remove",
        });

        expect(() => stripHopByHopHeaders(source)).toThrow(
            "Connection header contains an invalid field name"
        );
    });

    test("propagates an upstream body failure without normal EOF", async () => {
        const expectedError = new Error("Qualification upstream body failed");
        let upstreamBody:
            | ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>
            | undefined;
        const upstream = new ReadableStream<Uint8Array<ArrayBuffer>>({
            start(controller) {
                upstreamBody = controller;
                controller.enqueue(new TextEncoder().encode("qualification chunk"));
            },
        });
        const upstreamController = new AbortController();
        let detachCount = 0;
        const downstream = createProxyResponseBody(upstream, upstreamController, () => {
            detachCount += 1;
        });
        const reader = downstream.getReader();

        const first = await reader.read();
        if (first.done) {
            throw new Error("Qualification proxy stream ended before first chunk");
        }
        expect(new TextDecoder().decode(first.value)).toBe("qualification chunk");
        if (upstreamBody === undefined) {
            throw new Error("Qualification upstream body controller was missing");
        }

        upstreamBody.error(expectedError);
        let downstreamError: unknown;
        try {
            await reader.read();
        } catch (error) {
            downstreamError = error;
        }

        expect(downstreamError).toBe(expectedError);
        expect(upstreamController.signal.aborted).toBeTrue();
        expect(upstreamController.signal.reason).toBe(expectedError);
        expect(detachCount).toBe(1);
    });
});
