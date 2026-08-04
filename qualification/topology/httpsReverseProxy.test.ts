import { describe, expect, test } from "bun:test";

import { AsyncCleanupStack } from "../test/asyncCleanupStack.ts";
import { waitFor } from "../test/waitFor.ts";
import { startHttpsReverseProxy } from "./httpsReverseProxy.ts";
import { createTestTlsIdentity } from "./testTlsIdentity.ts";
import { createTrustedFetch } from "./trustedFetch.ts";

describe("qualification HTTPS reverse proxy", () => {
    test("cancels an upstream request before response headers arrive", async () => {
        const cleanup = new AsyncCleanupStack();
        let upstreamRequestAborted = false;
        let upstreamRequestStarted = false;

        try {
            const tlsIdentity = await createTestTlsIdentity();
            cleanup.defer("qualification TLS identity", () => tlsIdentity.dispose());
            const upstream = Bun.serve({
                async fetch(request) {
                    upstreamRequestStarted = true;
                    if (request.signal.aborted) {
                        upstreamRequestAborted = true;
                    } else {
                        await new Promise<void>((resolve) => {
                            request.signal.addEventListener(
                                "abort",
                                () => {
                                    upstreamRequestAborted = true;
                                    resolve();
                                },
                                { once: true }
                            );
                        });
                    }
                    return new Response("cancelled");
                },
                hostname: "127.0.0.1",
                port: 0,
            });
            cleanup.defer("qualification cancellation upstream", () =>
                upstream.stop(true)
            );
            const proxy = startHttpsReverseProxy({
                certificate: tlsIdentity.certificate,
                privateKey: tlsIdentity.privateKey,
                target: new URL(`http://127.0.0.1:${upstream.port}`),
            });
            cleanup.defer("qualification cancellation proxy", () => proxy.stop(true));
            const trustedFetch = createTrustedFetch({
                certificateAuthority: tlsIdentity.certificate,
            });
            const abortController = new AbortController();
            const pendingRequest = trustedFetch(proxy.url, {
                signal: abortController.signal,
            }).catch(() => null);

            await waitFor(() => upstreamRequestStarted);
            abortController.abort(new Error("Qualification client disconnected"));
            await waitFor(() => upstreamRequestAborted);
            await pendingRequest;

            expect(upstreamRequestAborted).toBeTrue();
            expect(proxy.upstreamUnavailableCount).toBe(0);
        } finally {
            await cleanup.dispose();
        }
    }, 10_000);
});
