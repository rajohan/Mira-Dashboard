const fixedHopByHopHeaders = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
] as const;

const httpTokenPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Optional synchronization boundary after one upstream response chunk is forwarded. */
export type ProxyResponseBodyChunkBoundary = (chunk: Uint8Array) => Promise<void> | void;

function trimOptionalWhitespace(value: string): string {
    return value.replaceAll(/^[\t ]+|[\t ]+$/g, "");
}

/**
 * Removes fixed and Connection-nominated fields before the next HTTP hop.
 * @param source Headers received from the previous hop.
 * @returns A sanitized copy safe to pass to the next hop.
 */
export function stripHopByHopHeaders(source: Headers): Headers {
    const headers = new Headers(source);
    const connection = headers.get("connection");

    if (connection !== null) {
        for (const member of connection.split(",")) {
            const fieldName = trimOptionalWhitespace(member);
            if (fieldName.length === 0) {
                continue;
            }
            if (!httpTokenPattern.test(fieldName)) {
                throw new TypeError("Connection header contains an invalid field name");
            }
            headers.delete(fieldName);
        }
    }

    for (const fieldName of fixedHopByHopHeaders) {
        headers.delete(fieldName);
    }
    return headers;
}

/**
 * Streams an upstream response body while preserving failure and cancellation semantics.
 * @param body Upstream response body.
 * @param upstreamController Controller for the upstream request.
 * @param detachRequestAbort Removes the downstream abort listener.
 * @param chunkBoundary Optional synchronization boundary after forwarding each chunk.
 * @returns A downstream response stream.
 */
export function createProxyResponseBody(
    body: ReadableStream<Uint8Array>,
    upstreamController: AbortController,
    detachRequestAbort: () => void,
    chunkBoundary?: ProxyResponseBodyChunkBoundary
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
                if (chunkBoundary !== undefined) {
                    await chunkBoundary(next.value);
                }
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
