import { describe, expect, test } from "bun:test";

import { AsyncCleanupStack } from "../../../support/asyncCleanupStack.ts";
import { waitFor } from "../../../support/waitFor.ts";
import { startHttpsReverseProxy } from "./httpsReverseProxy.ts";
import { createTestTlsIdentity } from "./testTlsIdentity.ts";
import { createTrustedFetch } from "./trustedFetch.ts";

type UpstreamFetch = (request: Request) => Promise<Response> | Response;

async function startProxyHarness(
    cleanup: AsyncCleanupStack,
    upstreamFetch: UpstreamFetch
) {
    const tlsIdentity = await createTestTlsIdentity();
    cleanup.defer("integration TLS identity", () => tlsIdentity.dispose());
    const upstream = Bun.serve({
        fetch: upstreamFetch,
        hostname: "127.0.0.1",
        port: 0,
    });
    cleanup.defer("integration proxy upstream", () => upstream.stop(true));
    const proxy = startHttpsReverseProxy({
        certificate: tlsIdentity.certificate,
        privateKey: tlsIdentity.privateKey,
        target: new URL(`http://127.0.0.1:${upstream.port}`),
    });
    cleanup.defer("integration HTTPS proxy", () => proxy.stop(true));

    return {
        proxy,
        trustedFetch: createTrustedFetch({
            certificateAuthority: tlsIdentity.certificate,
        }),
    };
}

describe("integration HTTPS reverse proxy", () => {
    test("cancels an upstream request before response headers arrive", async () => {
        const cleanup = new AsyncCleanupStack();
        let upstreamRequestAborted = false;
        let upstreamRequestStarted = false;

        try {
            const { proxy, trustedFetch } = await startProxyHarness(
                cleanup,
                async (request) => {
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
                }
            );
            expect(proxy.url.hostname).toBe("127.0.0.1");
            const abortController = new AbortController();
            const pendingRequest = trustedFetch(proxy.url, {
                signal: abortController.signal,
            }).catch(() => null);

            await waitFor(() => upstreamRequestStarted);
            abortController.abort(new Error("Integration client disconnected"));
            await waitFor(() => upstreamRequestAborted);
            await pendingRequest;

            expect(upstreamRequestAborted).toBeTrue();
            expect(proxy.upstreamUnavailableCount).toBe(0);
        } finally {
            await cleanup.dispose();
        }
    }, 10_000);

    test("rejects malformed Connection metadata from either hop", async () => {
        const cleanup = new AsyncCleanupStack();
        let upstreamBodyCancelled = false;
        let upstreamRequestAborted = false;
        let upstreamRequestCount = 0;

        try {
            const { proxy, trustedFetch } = await startProxyHarness(
                cleanup,
                (request) => {
                    upstreamRequestCount += 1;
                    request.signal.addEventListener(
                        "abort",
                        () => {
                            upstreamRequestAborted = true;
                        },
                        { once: true }
                    );
                    return new Response(
                        new ReadableStream<Uint8Array>({
                            start(controller) {
                                controller.enqueue(
                                    new TextEncoder().encode("invalid upstream metadata")
                                );
                            },
                            cancel() {
                                upstreamBodyCancelled = true;
                            },
                        }),
                        {
                            headers: {
                                connection: '"x-hop"',
                                "x-hop": "remove",
                            },
                        }
                    );
                }
            );

            const invalidRequest = await trustedFetch(proxy.url, {
                headers: {
                    connection: '"x-hop"',
                    "x-hop": "remove",
                },
            });
            expect(invalidRequest.status).toBe(400);
            expect(upstreamRequestCount).toBe(0);

            const invalidResponse = await trustedFetch(proxy.url);
            expect(invalidResponse.status).toBe(502);
            expect(await invalidResponse.text()).toBe(
                "Invalid Connection response header"
            );
            expect(upstreamRequestCount).toBe(1);
            await waitFor(() => upstreamBodyCancelled || upstreamRequestAborted);
            expect(upstreamBodyCancelled || upstreamRequestAborted).toBeTrue();
        } finally {
            await cleanup.dispose();
        }
    }, 10_000);

    test("strips Connection-nominated headers on both proxy hops", async () => {
        const cleanup = new AsyncCleanupStack();
        let upstreamHeaders: Headers | undefined;

        try {
            const { proxy, trustedFetch } = await startProxyHarness(
                cleanup,
                (request) => {
                    upstreamHeaders = new Headers(request.headers);
                    return new Response("proxied", {
                        headers: {
                            connection: "x-upstream-hop, x-second-upstream-hop",
                            "x-end-to-end-response": "preserved",
                            "x-second-upstream-hop": "remove",
                            "x-upstream-hop": "remove",
                        },
                    });
                }
            );

            const response = await trustedFetch(proxy.url, {
                headers: {
                    connection: "X-Request-Hop,\tx-second-request-hop",
                    "x-end-to-end-request": "preserved",
                    "x-request-hop": "remove",
                    "x-second-request-hop": "remove",
                },
            });

            expect(response.status).toBe(200);
            expect(await response.text()).toBe("proxied");
            expect(upstreamHeaders?.get("x-request-hop")).toBeNull();
            expect(upstreamHeaders?.get("x-second-request-hop")).toBeNull();
            expect(upstreamHeaders?.get("x-end-to-end-request")).toBe("preserved");
            expect(upstreamHeaders?.get("x-forwarded-proto")).toBe("https");
            expect(response.headers.get("x-upstream-hop")).toBeNull();
            expect(response.headers.get("x-second-upstream-hop")).toBeNull();
            expect(response.headers.get("x-end-to-end-response")).toBe("preserved");
        } finally {
            await cleanup.dispose();
        }
    }, 10_000);
});
