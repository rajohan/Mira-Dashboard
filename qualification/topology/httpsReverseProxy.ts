const hopByHopHeaders = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
] as const;

/** TLS and loopback target for one qualification reverse proxy. */
export interface HttpsReverseProxyOptions {
    certificate: string;
    privateKey: string;
    target: URL;
}

function forwardedHeaders(request: Request): Headers {
    const headers = new Headers(request.headers);
    const forwardedHost = headers.get("host");
    for (const header of hopByHopHeaders) {
        headers.delete(header);
    }
    headers.delete("host");
    headers.set("x-forwarded-proto", "https");
    if (forwardedHost !== null) {
        headers.set("x-forwarded-host", forwardedHost);
    }
    return headers;
}

function responseHeaders(upstream: Response): Headers {
    const headers = new Headers(upstream.headers);
    for (const header of hopByHopHeaders) {
        headers.delete(header);
    }
    return headers;
}

function streamedBody(
    body: ReadableStream<Uint8Array>,
    upstreamController: AbortController,
    detachRequestAbort: () => void
): ReadableStream<Uint8Array> {
    const reader = body.getReader();

    return new ReadableStream<Uint8Array>({
        async cancel(reason) {
            upstreamController.abort(reason);
            detachRequestAbort();
            await reader.cancel(reason).catch(() => null);
        },
        async pull(controller) {
            try {
                const next = await reader.read();
                if (next.done) {
                    detachRequestAbort();
                    controller.close();
                    return;
                }
                controller.enqueue(next.value);
            } catch (error) {
                detachRequestAbort();
                if (upstreamController.signal.aborted) {
                    return;
                }
                upstreamController.abort(error);
                controller.error(error);
            }
        },
    });
}

/**
 * Starts an HTTPS Bun proxy that streams to one stable loopback release port.
 * @param options TLS identity and upstream target.
 * @returns A controlled proxy with a stable HTTPS URL.
 */
export function startHttpsReverseProxy(options: HttpsReverseProxyOptions) {
    let upstreamUnavailableCount = 0;
    const server = Bun.serve({
        async fetch(request) {
            const upstreamUrl = new URL(request.url);
            upstreamUrl.protocol = options.target.protocol;
            upstreamUrl.host = options.target.host;
            const upstreamController = new AbortController();
            const abortUpstream = (): void => {
                upstreamController.abort(request.signal.reason);
            };
            const detachRequestAbort = (): void => {
                request.signal.removeEventListener("abort", abortUpstream);
            };

            if (request.signal.aborted) {
                abortUpstream();
            } else {
                request.signal.addEventListener("abort", abortUpstream, { once: true });
            }

            try {
                const upstream = await fetch(upstreamUrl, {
                    body:
                        request.method === "GET" || request.method === "HEAD"
                            ? undefined
                            : request.body,
                    headers: forwardedHeaders(request),
                    keepalive: false,
                    method: request.method,
                    redirect: "manual",
                    signal: upstreamController.signal,
                });
                if (upstream.body === null) {
                    detachRequestAbort();
                }
                return new Response(
                    upstream.body === null
                        ? null
                        : streamedBody(
                              upstream.body,
                              upstreamController,
                              detachRequestAbort
                          ),
                    {
                        headers: responseHeaders(upstream),
                        status: upstream.status,
                        statusText: upstream.statusText,
                    }
                );
            } catch {
                detachRequestAbort();
                upstreamController.abort();
                if (request.signal.aborted) {
                    return new Response(null, { status: 499 });
                }
                upstreamUnavailableCount += 1;
                return new Response("Qualification upstream unavailable", {
                    status: 503,
                });
            }
        },
        hostname: "127.0.0.1",
        port: 0,
        tls: {
            cert: options.certificate,
            key: options.privateKey,
        },
    });
    let stopPromise: Promise<void> | undefined;

    return {
        server,
        stop(force = true): Promise<void> {
            stopPromise ??= server.stop(force);
            return stopPromise;
        },
        get upstreamUnavailableCount() {
            return upstreamUnavailableCount;
        },
        url: new URL(`https://127.0.0.1:${server.port}`),
    };
}
