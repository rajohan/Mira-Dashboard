import {
    createProxyResponseBody,
    type ProxyDownstreamStreamErrorMode,
    type ProxyResponseBodyChunkBoundary,
    stripHopByHopHeaders,
} from "./proxyTransport.ts";

/** TLS and loopback target for one integration reverse proxy. */
export interface HttpsReverseProxyOptions {
    certificate: string;
    /** Optional opaque downstream failure mode for intentional reconnect scenarios. */
    downstreamStreamErrorMode?: ProxyDownstreamStreamErrorMode;
    privateKey: string;
    /** Optional scenario synchronization after forwarding each response chunk. */
    responseBodyChunkBoundary?: ProxyResponseBodyChunkBoundary;
    target: URL;
}

function forwardedHeaders(request: Request): Headers {
    const forwardedHost = request.headers.get("host");
    const headers = stripHopByHopHeaders(request.headers);
    headers.delete("host");
    headers.set("x-forwarded-proto", "https");
    if (forwardedHost !== null) {
        headers.set("x-forwarded-host", forwardedHost);
    }
    return headers;
}

function responseHeaders(upstream: Response): Headers {
    return stripHopByHopHeaders(upstream.headers);
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

            let headers: Headers;
            try {
                headers = forwardedHeaders(request);
            } catch {
                detachRequestAbort();
                upstreamController.abort();
                return new Response("Invalid Connection request header", {
                    status: 400,
                });
            }

            try {
                const upstream = await fetch(upstreamUrl, {
                    body:
                        request.method === "GET" || request.method === "HEAD"
                            ? undefined
                            : request.body,
                    headers,
                    keepalive: false,
                    method: request.method,
                    redirect: "manual",
                    signal: upstreamController.signal,
                });
                let downstreamHeaders: Headers;
                try {
                    downstreamHeaders = responseHeaders(upstream);
                } catch (error) {
                    detachRequestAbort();
                    upstreamController.abort(error);
                    if (upstream.body !== null) {
                        await upstream.body.cancel(error).catch(() => null);
                    }
                    return new Response("Invalid Connection response header", {
                        status: 502,
                    });
                }
                if (upstream.body === null) {
                    detachRequestAbort();
                }
                return new Response(
                    upstream.body === null
                        ? null
                        : createProxyResponseBody(
                              upstream.body,
                              upstreamController,
                              detachRequestAbort,
                              {
                                  chunkBoundary: options.responseBodyChunkBoundary,
                                  downstreamStreamErrorMode:
                                      options.downstreamStreamErrorMode,
                              }
                          ),
                    {
                        headers: downstreamHeaders,
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
                return new Response("Integration upstream unavailable", {
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
