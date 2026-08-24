import { Data, Deferred, Effect, Scope } from "effect";

import {
    hasConnectedSseFrame,
    maximumPausedTlsSseHandshakeBytes,
} from "./pausedTlsSseHandshake.ts";

export { hasConnectedSseFrame } from "./pausedTlsSseHandshake.ts";

interface PausedClientState {
    abandoned: boolean;
    close: Deferred.Deferred<void>;
    closeSettled: boolean;
    handshakeBytes: Buffer;
    ready: Deferred.Deferred<
        Bun.Socket<PausedClientState>,
        PausedTlsSseClientOperationError
    >;
    readySettled: boolean;
    request: Buffer;
    requestOffset: number;
    socket?: Bun.Socket<PausedClientState>;
}

export class PausedTlsSseClientDeadlineError extends Data.TaggedError(
    "PausedTlsSseClientDeadlineError"
)<{
    readonly message: string;
    readonly operation: string;
    readonly timeoutMs: number;
}> {}

export class PausedTlsSseClientArgumentError extends Data.TaggedError(
    "PausedTlsSseClientArgumentError"
)<{
    readonly argument: "cookie" | "publicUrl";
    readonly message: string;
}> {}

export class PausedTlsSseClientOperationError extends Data.TaggedError(
    "PausedTlsSseClientOperationError"
)<{
    readonly cause: unknown;
    readonly message: string;
    readonly operation: string;
}> {}

export type PausedTlsSseClientError =
    | PausedTlsSseClientArgumentError
    | PausedTlsSseClientDeadlineError
    | PausedTlsSseClientOperationError;

/** Controlled native TLS client that stops reading after the first SSE frame. */
export interface PausedTlsSseClient {
    close(): Promise<void>;
}

const closeEffect = Symbol("PausedTlsSseClient.closeEffect");

interface ManagedPausedTlsSseClient extends PausedTlsSseClient {
    readonly [closeEffect]: Effect.Effect<
        void,
        PausedTlsSseClientDeadlineError | PausedTlsSseClientOperationError
    >;
}

function operationFailure(
    operation: string,
    cause: unknown,
    fallbackMessage: string
): PausedTlsSseClientOperationError {
    if (cause instanceof PausedTlsSseClientOperationError) return cause;
    return new PausedTlsSseClientOperationError({
        cause,
        message: cause instanceof Error ? cause.message : fallbackMessage,
        operation,
    });
}

function failClient(
    socket: Bun.Socket<PausedClientState>,
    operation: string,
    error: Error
): void {
    socket.data.socket = socket;
    if (!socket.data.readySettled) {
        socket.data.readySettled = true;
        Deferred.doneUnsafe(
            socket.data.ready,
            Effect.fail(operationFailure(operation, error, error.message))
        );
    }
    socket.terminate();
}

function requestTarget(url: URL): string {
    return `${url.pathname}${url.search}`;
}

function writePendingRequest(socket: Bun.Socket<PausedClientState>): void {
    const state = socket.data;
    try {
        while (state.requestOffset < state.request.byteLength) {
            const bytesWritten = socket.write(
                state.request,
                state.requestOffset,
                state.request.byteLength - state.requestOffset
            );
            if (bytesWritten < 0) {
                throw new Error("Paused SSE client request socket closed");
            }
            if (bytesWritten === 0) return;
            state.requestOffset += bytesWritten;
        }
        socket.flush();
    } catch (error) {
        failClient(
            socket,
            "write-request",
            error instanceof Error
                ? error
                : new Error("Paused SSE client request write failed", {
                      cause: error,
                  })
        );
    }
}

/**
 * Applies the shared typed deadline policy for paused-client operations.
 * @param effect Operation governed by the deadline.
 * @param operation Redacted operation label.
 * @param timeoutMs Deadline in milliseconds.
 * @returns Original result or a tagged deadline failure.
 */
export function withPausedTlsSseClientDeadline<A, E>(
    effect: Effect.Effect<A, E>,
    operation: string,
    timeoutMs: number
): Effect.Effect<A, E | PausedTlsSseClientDeadlineError> {
    return effect.pipe(
        Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () =>
                Effect.fail(
                    new PausedTlsSseClientDeadlineError({
                        message: `Paused SSE client did not ${operation} within ${timeoutMs} ms`,
                        operation,
                        timeoutMs,
                    })
                ),
        })
    );
}

function closeSocketBeforeDeadline(
    socket: Bun.Socket<PausedClientState>,
    timeoutMs: number
): Effect.Effect<
    void,
    PausedTlsSseClientDeadlineError | PausedTlsSseClientOperationError
> {
    const terminate = Effect.try({
        catch: (cause) =>
            operationFailure(
                "close",
                cause,
                "Paused SSE client could not request socket closure"
            ),
        try: () => {
            if (!socket.data.closeSettled) socket.terminate();
        },
    });
    const awaitClose = Deferred.await(socket.data.close);
    const close = terminate.pipe(Effect.andThen(awaitClose));
    return withPausedTlsSseClientDeadline(close, "close", timeoutMs);
}

function abandonClient(state: PausedClientState): void {
    state.abandoned = true;
    state.socket?.terminate();
}

function openPausedTlsSseClientEffect(
    publicUrl: URL,
    certificateAuthority: string,
    cookie: string,
    timeoutMs: number
): Effect.Effect<ManagedPausedTlsSseClient, PausedTlsSseClientError> {
    return Effect.gen(function* () {
        const request = yield* Effect.try({
            catch: (cause) =>
                cause instanceof PausedTlsSseClientArgumentError
                    ? cause
                    : operationFailure(
                          "build-request",
                          cause,
                          "Paused SSE client could not build its request"
                      ),
            try: () => {
                if (publicUrl.protocol !== "https:" || publicUrl.port.length === 0) {
                    throw new PausedTlsSseClientArgumentError({
                        argument: "publicUrl",
                        message: "Paused SSE client requires an explicit HTTPS port",
                    });
                }
                if (/[\r\n]/u.test(cookie)) {
                    throw new PausedTlsSseClientArgumentError({
                        argument: "cookie",
                        message: "Paused SSE client cookie must not contain CR or LF",
                    });
                }
                const endpoint = new URL("/trpc/events.stream", publicUrl);
                endpoint.searchParams.set("input", JSON.stringify({}));
                return Buffer.from(
                    [
                        `GET ${requestTarget(endpoint)} HTTP/1.1`,
                        `Host: ${publicUrl.host}`,
                        "Accept: text/event-stream",
                        "Accept-Encoding: identity",
                        `Cookie: ${cookie}`,
                        "Connection: keep-alive",
                        "",
                        "",
                    ].join("\r\n"),
                    "utf8"
                );
            },
        });
        const close = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<
            Bun.Socket<PausedClientState>,
            PausedTlsSseClientOperationError
        >();
        const state: PausedClientState = {
            abandoned: false,
            close,
            closeSettled: false,
            handshakeBytes: Buffer.alloc(0),
            ready,
            readySettled: false,
            request,
            requestOffset: 0,
        };
        const connectPromise = yield* Effect.try({
            catch: (cause) =>
                operationFailure(
                    "connect",
                    cause,
                    "Paused SSE client could not start its TLS connection"
                ),
            try: () =>
                Bun.connect({
                    data: state,
                    hostname: publicUrl.hostname,
                    port: Number(publicUrl.port),
                    socket: {
                        binaryType: "buffer",
                        close(closedSocket, error) {
                            closedSocket.data.socket = closedSocket;
                            if (!closedSocket.data.closeSettled) {
                                closedSocket.data.closeSettled = true;
                                Deferred.doneUnsafe(closedSocket.data.close, Effect.void);
                            }
                            if (!closedSocket.data.readySettled) {
                                const cause =
                                    error ??
                                    new Error(
                                        "Paused SSE client closed before its connected frame"
                                    );
                                closedSocket.data.readySettled = true;
                                Deferred.doneUnsafe(
                                    closedSocket.data.ready,
                                    Effect.fail(
                                        operationFailure(
                                            "await-connected-frame",
                                            cause,
                                            "Paused SSE client closed before its connected frame"
                                        )
                                    )
                                );
                            }
                        },
                        connectError(connectedSocket, error) {
                            failClient(connectedSocket, "connect", error);
                        },
                        data(connectedSocket, data) {
                            connectedSocket.data.socket = connectedSocket;
                            if (connectedSocket.data.readySettled) return;
                            const handshakeBytes = connectedSocket.data.handshakeBytes;
                            const remainingBytes =
                                maximumPausedTlsSseHandshakeBytes -
                                handshakeBytes.byteLength;
                            const boundedData = data.subarray(
                                0,
                                Math.min(data.byteLength, remainingBytes)
                            );
                            connectedSocket.data.handshakeBytes = Buffer.concat(
                                [handshakeBytes, boundedData],
                                handshakeBytes.byteLength + boundedData.byteLength
                            );
                            try {
                                if (
                                    hasConnectedSseFrame(
                                        connectedSocket.data.handshakeBytes
                                    )
                                ) {
                                    connectedSocket.pause();
                                    connectedSocket.data.readySettled = true;
                                    Deferred.doneUnsafe(
                                        connectedSocket.data.ready,
                                        Effect.succeed(connectedSocket)
                                    );
                                    return;
                                }
                                if (data.byteLength > boundedData.byteLength) {
                                    throw new Error(
                                        "Paused SSE client handshake exceeded its byte budget"
                                    );
                                }
                            } catch (error) {
                                failClient(
                                    connectedSocket,
                                    "parse-handshake",
                                    error instanceof Error
                                        ? error
                                        : new Error("Paused SSE client parse failed", {
                                              cause: error,
                                          })
                                );
                            }
                        },
                        error(connectedSocket, error) {
                            failClient(connectedSocket, "socket", error);
                        },
                        drain(connectedSocket) {
                            connectedSocket.data.socket = connectedSocket;
                            writePendingRequest(connectedSocket);
                        },
                        open(connectedSocket) {
                            connectedSocket.data.socket = connectedSocket;
                            if (
                                connectedSocket.data.readySettled ||
                                connectedSocket.data.abandoned
                            ) {
                                connectedSocket.terminate();
                                return;
                            }
                            if (!connectedSocket.authorized) {
                                failClient(
                                    connectedSocket,
                                    "authorize-tls",
                                    connectedSocket.getAuthorizationError() ??
                                        new Error(
                                            "Paused SSE client TLS authorization failed"
                                        )
                                );
                                return;
                            }
                            writePendingRequest(connectedSocket);
                        },
                        timeout(connectedSocket) {
                            failClient(
                                connectedSocket,
                                "socket-timeout",
                                new Error(
                                    `Paused SSE client timed out after ${timeoutMs} ms`
                                )
                            );
                        },
                    },
                    tls: {
                        ca: certificateAuthority,
                        rejectUnauthorized: true,
                        serverName: publicUrl.hostname,
                    },
                }),
        });
        void connectPromise.then(
            (connectedSocket) => {
                if (state.abandoned) connectedSocket.terminate();
                return null;
            },
            () => null
        );
        const awaitConnectedSocket = Effect.gen(function* () {
            const connect = Effect.tryPromise({
                catch: (cause) =>
                    operationFailure(
                        "connect",
                        cause,
                        "Paused SSE client TLS connection failed"
                    ),
                try: () => connectPromise,
            });
            yield* Effect.raceFirst(connect, Deferred.await(ready));
            return yield* Deferred.await(ready);
        }).pipe(Effect.onInterrupt(() => Effect.sync(() => abandonClient(state))));
        const connectedSocket = yield* withPausedTlsSseClientDeadline(
            awaitConnectedSocket,
            "connect",
            timeoutMs
        ).pipe(Effect.onError(() => Effect.sync(() => abandonClient(state))));
        const closeClient = closeSocketBeforeDeadline(connectedSocket, timeoutMs);
        let closePromise: Promise<void> | undefined;
        return Object.freeze({
            [closeEffect]: closeClient,
            close(): Promise<void> {
                closePromise ??= Effect.runPromise(closeClient);
                return closePromise;
            },
        });
    });
}

/**
 * Effect-scoped paused client whose finalizer bounds and confirms native closure.
 * @param publicUrl Stable HTTPS proxy URL.
 * @param certificateAuthority PEM certificate trusted only for this client.
 * @param cookie Evidence cookie required by the upstream server.
 * @param timeoutMs Maximum handshake, connected-frame, and close wait.
 * @returns Scoped paused native socket.
 */
export function pausedTlsSseClientResource(
    publicUrl: URL,
    certificateAuthority: string,
    cookie: string,
    timeoutMs: number
): Effect.Effect<PausedTlsSseClient, PausedTlsSseClientError, Scope.Scope> {
    return Effect.acquireRelease(
        openPausedTlsSseClientEffect(publicUrl, certificateAuthority, cookie, timeoutMs),
        (client) => client[closeEffect].pipe(Effect.orDie),
        { interruptible: true }
    );
}

/**
 * Opens a CA-verified TLS socket and pauses reads immediately after tRPC connects.
 * @param publicUrl Stable HTTPS proxy URL.
 * @param certificateAuthority PEM certificate trusted only for this client.
 * @param cookie Evidence cookie required by the upstream server.
 * @param timeoutMs Maximum handshake and connected-frame wait.
 * @returns Paused native socket controlled by the caller.
 */
export function openPausedTlsSseClient(
    publicUrl: URL,
    certificateAuthority: string,
    cookie: string,
    timeoutMs: number
): Promise<PausedTlsSseClient> {
    return Effect.runPromise(
        openPausedTlsSseClientEffect(publicUrl, certificateAuthority, cookie, timeoutMs)
    );
}
