const defaultResponseMaximumBytes = 128 * 1024;
const defaultTimeoutMs = 10_000;

export class OverviewProviderUnavailableError extends Error {
    constructor() {
        super("Overview provider is unavailable");
        this.name = "OverviewProviderUnavailableError";
    }
}

function unavailable(): never {
    throw new OverviewProviderUnavailableError();
}

async function readBoundedBody(
    response: Response,
    maximumBytes: number
): Promise<Uint8Array> {
    const declaredLength = response.headers.get("content-length");
    if (
        declaredLength !== null &&
        (!/^(?:0|[1-9][0-9]*)$/u.test(declaredLength) ||
            Number(declaredLength) > maximumBytes)
    ) {
        unavailable();
    }
    if (response.body === null) unavailable();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            const chunk = next.value as Uint8Array;
            length += chunk.byteLength;
            if (length > maximumBytes) {
                await reader.cancel().catch(() => {});
                unavailable();
            }
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock();
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}

export interface BoundedJsonRequest {
    readonly fetch?: typeof globalThis.fetch;
    readonly headers?: Readonly<Record<string, string>>;
    readonly maximumBytes?: number;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly url: URL;
}

/**
 * Reads one fixed HTTPS JSON resource through a bounded, redirect-free transport.
 * Callers own the URL and validate the returned provider schema before projection.
 * @returns The parsed JSON value after transport validation.
 */
export async function fetchBoundedJson(request: BoundedJsonRequest): Promise<unknown> {
    request.signal?.throwIfAborted();
    if (request.url.protocol !== "https:") unavailable();
    const maximumBytes = request.maximumBytes ?? defaultResponseMaximumBytes;
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
    if (
        !Number.isSafeInteger(maximumBytes) ||
        maximumBytes < 1 ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1
    ) {
        throw new RangeError("Overview provider transport budget is invalid");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, timeoutMs);
    try {
        request.signal?.throwIfAborted();
        const response = await (request.fetch ?? globalThis.fetch)(request.url, {
            headers: {
                Accept: "application/json",
                "User-Agent": "mira-dashboard-overview/1.0",
                ...request.headers,
            },
            method: "GET",
            redirect: "error",
            signal: controller.signal,
        });
        if (!response.ok) unavailable();
        const body = await readBoundedBody(response, maximumBytes);
        try {
            const value = JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(body)
            ) as unknown;
            request.signal?.throwIfAborted();
            return value;
        } catch {
            request.signal?.throwIfAborted();
            return unavailable();
        }
    } catch (error) {
        request.signal?.throwIfAborted();
        if (error instanceof OverviewProviderUnavailableError) throw error;
        return unavailable();
    } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", abort);
    }
}
