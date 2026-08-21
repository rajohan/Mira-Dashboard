import { Data, Effect, Scope } from "effect";

const responseMaximumBytes = 16 * 1024;

export class ShutdownIdleHttpConnectionError extends Data.TaggedError(
    "ShutdownIdleHttpConnectionError"
)<{
    readonly cause?: unknown;
    readonly operation: string;
}> {}

interface IdleHttpConnectionState {
    abandoned: boolean;
    response: Buffer;
    request: Buffer;
    requestOffset: number;
    settled: boolean;
    socket?: Bun.Socket<IdleHttpConnectionState>;
}

function connectionFailure(operation: string, cause?: unknown) {
    return new ShutdownIdleHttpConnectionError({ cause, operation });
}

function writePendingRequest(socket: Bun.Socket<IdleHttpConnectionState>): void {
    const { request, requestOffset } = socket.data;
    if (requestOffset >= request.byteLength) return;
    const written = socket.write(request.subarray(requestOffset));
    socket.data.requestOffset += written;
}

function acquireIdleHttpConnection(
    baseUrl: string
): Effect.Effect<Bun.Socket<IdleHttpConnectionState>, ShutdownIdleHttpConnectionError> {
    return Effect.callback<
        Bun.Socket<IdleHttpConnectionState>,
        ShutdownIdleHttpConnectionError
    >((resume) => {
        const url = new URL(baseUrl);
        const request = Buffer.from(
            [
                "GET /api/health/ready HTTP/1.1",
                `Host: ${url.host}`,
                "Accept: application/json",
                "Connection: keep-alive",
                "",
                "",
            ].join("\r\n"),
            "utf8"
        );
        const state: IdleHttpConnectionState = {
            abandoned: false,
            request,
            requestOffset: 0,
            response: Buffer.alloc(0),
            settled: false,
        };
        const fail = (operation: string, cause?: unknown) => {
            if (state.settled) return;
            state.settled = true;
            state.socket?.terminate();
            resume(Effect.fail(connectionFailure(operation, cause)));
        };
        const connectPromise = Bun.connect({
            data: state,
            hostname: url.hostname,
            port: Number(url.port),
            socket: {
                binaryType: "buffer",
                close(_socket, error) {
                    if (!state.settled) {
                        fail("idle-http-connection-closed-before-response", error);
                    }
                },
                connectError(_socket, error) {
                    fail("connect-idle-http-connection", error);
                },
                data(socket, chunk) {
                    state.socket = socket;
                    if (state.settled) return;
                    const remainingBytes = responseMaximumBytes - state.response.length;
                    if (chunk.length > remainingBytes) {
                        fail("idle-http-response-exceeded-bound");
                        return;
                    }
                    state.response = Buffer.concat(
                        [state.response, chunk],
                        state.response.length + chunk.length
                    );
                    const headerEnd = state.response.indexOf("\r\n\r\n");
                    if (headerEnd === -1) return;
                    const headerLines = state.response
                        .subarray(0, headerEnd)
                        .toString("utf8")
                        .split("\r\n");
                    const statusLine = headerLines[0];
                    if (statusLine !== "HTTP/1.1 200 OK") {
                        fail(
                            "validate-idle-http-response",
                            new Error("Idle HTTP response was not successful")
                        );
                        return;
                    }
                    const contentLengthHeaders = headerLines
                        .slice(1)
                        .filter((line) => /^content-length\s*:/iu.test(line));
                    const contentLengthText = contentLengthHeaders[0]
                        ?.slice(contentLengthHeaders[0].indexOf(":") + 1)
                        .trim();
                    if (
                        contentLengthHeaders.length !== 1 ||
                        contentLengthText === undefined ||
                        !/^(?:0|[1-9][0-9]*)$/u.test(contentLengthText)
                    ) {
                        fail("validate-idle-http-content-length");
                        return;
                    }
                    const contentLength = Number(contentLengthText);
                    const completeResponseBytes = headerEnd + 4 + contentLength;
                    if (
                        !Number.isSafeInteger(contentLength) ||
                        completeResponseBytes > responseMaximumBytes
                    ) {
                        fail("validate-idle-http-content-length");
                        return;
                    }
                    if (state.response.length < completeResponseBytes) return;
                    state.settled = true;
                    socket.pause();
                    resume(Effect.succeed(socket));
                },
                drain(socket) {
                    state.socket = socket;
                    writePendingRequest(socket);
                },
                error(_socket, error) {
                    fail("idle-http-connection-error", error);
                },
                open(socket) {
                    state.socket = socket;
                    if (state.abandoned) {
                        socket.terminate();
                        return;
                    }
                    writePendingRequest(socket);
                },
            },
        });
        void connectPromise.catch((error: unknown) =>
            fail("start-idle-http-connection", error)
        );

        return Effect.sync(() => {
            state.abandoned = true;
            state.socket?.terminate();
            void connectPromise.then((socket) => socket.terminate()).catch(() => {});
        });
    }).pipe(
        Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () => Effect.fail(connectionFailure("await-idle-http-response")),
        })
    );
}

/**
 * Holds one completed HTTP/1.1 keep-alive connection across listener shutdown.
 * @param baseUrl Running integration listener URL.
 * @returns A scoped connection that remains open until release or remote shutdown.
 */
export function idleHttpConnectionResource(
    baseUrl: string
): Effect.Effect<void, ShutdownIdleHttpConnectionError, Scope.Scope> {
    return Effect.acquireRelease(acquireIdleHttpConnection(baseUrl), (socket) =>
        Effect.sync(() => socket.terminate())
    ).pipe(Effect.asVoid);
}
