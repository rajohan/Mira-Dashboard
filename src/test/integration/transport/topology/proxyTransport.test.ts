import { describe, expect, test } from "bun:test";

import { createProxyResponseBody, stripHopByHopHeaders } from "./proxyTransport.ts";

describe("integration proxy transport", () => {
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

    test("propagates the exact upstream body failure by default without normal EOF", async () => {
        const expectedError = new Error("Integration upstream body failed");
        let upstreamBody:
            | ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>
            | undefined;
        const upstream = new ReadableStream<Uint8Array<ArrayBuffer>>({
            start(controller) {
                upstreamBody = controller;
                controller.enqueue(new TextEncoder().encode("integration chunk"));
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
            throw new Error("Integration proxy stream ended before first chunk");
        }
        expect(new TextDecoder().decode(first.value)).toBe("integration chunk");
        if (upstreamBody === undefined) {
            throw new Error("Integration upstream body controller was missing");
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

    test("can hide an upstream failure reason from the downstream stream", async () => {
        const expectedError = new Error("Integration upstream body failed opaquely");
        let upstreamBody:
            | ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>
            | undefined;
        const upstream = new ReadableStream<Uint8Array<ArrayBuffer>>({
            start(controller) {
                upstreamBody = controller;
                controller.enqueue(new TextEncoder().encode("integration chunk"));
            },
        });
        const upstreamController = new AbortController();
        let detachCount = 0;
        const downstream = createProxyResponseBody(
            upstream,
            upstreamController,
            () => {
                detachCount += 1;
            },
            { downstreamStreamErrorMode: "opaque" }
        );
        const reader = downstream.getReader();

        const first = await reader.read();
        if (first.done) {
            throw new Error("Integration proxy stream ended before first chunk");
        }
        if (upstreamBody === undefined) {
            throw new Error("Integration upstream body controller was missing");
        }

        upstreamBody.error(expectedError);
        const downstreamOutcome = await reader.read().then(
            (value) => ({ status: "fulfilled" as const, value }),
            (error: unknown) => ({ reason: error, status: "rejected" as const })
        );

        expect(downstreamOutcome).toEqual({
            reason: undefined,
            status: "rejected",
        });
        expect(upstreamController.signal.aborted).toBeTrue();
        expect(upstreamController.signal.reason).toBe(expectedError);
        expect(detachCount).toBe(1);
    });

    test("holds the next upstream read at an explicit forwarded-chunk boundary", async () => {
        const encoder = new TextEncoder();
        const upstream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode("connected"));
                controller.enqueue(encoder.encode("queued"));
                controller.close();
            },
        });
        const boundaryReached = Promise.withResolvers<void>();
        const releaseBoundary = Promise.withResolvers<void>();
        let boundaryCalls = 0;
        const downstream = createProxyResponseBody(
            upstream,
            new AbortController(),
            () => {},
            {
                async chunkBoundary() {
                    boundaryCalls += 1;
                    if (boundaryCalls === 1) {
                        boundaryReached.resolve();
                        await releaseBoundary.promise;
                    }
                },
            }
        );
        const reader = downstream.getReader();

        const firstRead = reader.read();
        await boundaryReached.promise;
        const first = await firstRead;
        expect(new TextDecoder().decode(first.value)).toBe("connected");
        let secondReadSettled = false;
        const secondRead = reader.read().finally(() => {
            secondReadSettled = true;
        });
        await Bun.sleep(0);
        expect(secondReadSettled).toBeFalse();

        releaseBoundary.resolve();
        const second = await secondRead;
        expect(new TextDecoder().decode(second.value)).toBe("queued");
    });
});
