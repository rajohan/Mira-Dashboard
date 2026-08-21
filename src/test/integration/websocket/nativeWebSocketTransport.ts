import { Data, Deferred, Effect } from "effect";

export const maximumNativeWebSocketMessageBytes = 64 * 1024;

const observationDeadline = "3 seconds";
const closeDeadline = "1 second";

export interface NativeWebSocketEventCounts {
    readonly closes: number;
    readonly errors: number;
    readonly messages: number;
    readonly opens: number;
}

export interface NativeWebSocketObservation {
    readonly bufferedAmount: number;
    readonly eventCounts: NativeWebSocketEventCounts;
    readonly message: string;
    readonly messageBytes: number;
}

export type NativeWebSocketFactory = (url: string) => WebSocket;

export class NativeWebSocketConstructionError extends Data.TaggedError(
    "NativeWebSocketConstructionError"
)<{
    readonly cause?: unknown;
}> {}

export class NativeWebSocketDeadlineError extends Data.TaggedError(
    "NativeWebSocketDeadlineError"
)<{
    readonly operation: string;
}> {}

export class NativeWebSocketCloseError extends Data.TaggedError(
    "NativeWebSocketCloseError"
)<{
    readonly cause?: unknown;
    readonly operation: "await-forced-close" | "await-graceful-close" | "terminate";
    readonly readyState: number;
}> {}

export class NativeWebSocketClosedError extends Data.TaggedError(
    "NativeWebSocketClosedError"
)<{
    readonly code: number;
    readonly eventCounts: NativeWebSocketEventCounts;
    readonly reason: string;
    readonly wasClean: boolean;
}> {}

export class NativeWebSocketMessageLimitError extends Data.TaggedError(
    "NativeWebSocketMessageLimitError"
)<{
    readonly actualBytes: number;
    readonly eventCounts: NativeWebSocketEventCounts;
    readonly maximumBytes: number;
}> {}

export class NativeWebSocketMessageTypeError extends Data.TaggedError(
    "NativeWebSocketMessageTypeError"
)<{
    readonly eventCounts: NativeWebSocketEventCounts;
}> {}

export type NativeWebSocketObservationError =
    | NativeWebSocketCloseError
    | NativeWebSocketClosedError
    | NativeWebSocketConstructionError
    | NativeWebSocketDeadlineError
    | NativeWebSocketMessageLimitError
    | NativeWebSocketMessageTypeError;

interface MutableEventCounts {
    closes: number;
    errors: number;
    messages: number;
    opens: number;
}

interface NativeWebSocketObserver {
    readonly awaitObservation: Effect.Effect<
        NativeWebSocketObservation,
        | NativeWebSocketClosedError
        | NativeWebSocketMessageLimitError
        | NativeWebSocketMessageTypeError
    >;
    readonly closeState: { requested: boolean };
    readonly closed: Deferred.Deferred<void>;
    readonly removeListeners: () => void;
    readonly socket: WebSocket;
}

function snapshotEventCounts(counts: MutableEventCounts): NativeWebSocketEventCounts {
    return Object.freeze({ ...counts });
}

function terminateNativeWebSocket(socket: WebSocket): void {
    const candidate = socket as WebSocket & { terminate?: () => void };
    if (typeof candidate.terminate !== "function") {
        throw new TypeError("Bun native WebSocket terminate is unavailable");
    }
    candidate.terminate();
}

/**
 * Applies the shared Effect deadline policy used by this integration slice.
 * @param effect Operation governed by the integration deadline.
 * @param operation Redacted operation label for a typed timeout.
 * @returns The original result or a tagged deadline failure.
 */
export function withNativeWebSocketDeadline<A, E>(
    effect: Effect.Effect<A, E>,
    operation: string
): Effect.Effect<A, E | NativeWebSocketDeadlineError> {
    return effect.pipe(
        Effect.timeoutOrElse({
            duration: observationDeadline,
            orElse: () => Effect.fail(new NativeWebSocketDeadlineError({ operation })),
        })
    );
}

function closeObserver(
    observer: NativeWebSocketObserver
): Effect.Effect<void, NativeWebSocketCloseError> {
    const close = Effect.sync(() => {
        if (
            !observer.closeState.requested &&
            (observer.socket.readyState === WebSocket.CONNECTING ||
                observer.socket.readyState === WebSocket.OPEN)
        ) {
            try {
                observer.closeState.requested = true;
                observer.socket.close(1000, "integration scope closed");
            } catch {
                // A simultaneous native transport close still completes the close event.
            }
        }
    });
    const awaitClose = Effect.gen(function* () {
        // Decide the graceful timeout before terminate can complete the same
        // Deferred; otherwise the original await can win after fallback starts.
        const closedGracefully = yield* Deferred.await(observer.closed).pipe(
            Effect.as(true),
            Effect.timeoutOrElse({
                duration: closeDeadline,
                orElse: () => Effect.succeed(false),
            })
        );
        if (closedGracefully) return;
        const gracefulCloseError = new NativeWebSocketCloseError({
            operation: "await-graceful-close",
            readyState: observer.socket.readyState,
        });
        yield* Effect.try({
            catch: (cause) =>
                new NativeWebSocketCloseError({
                    cause,
                    operation: "terminate",
                    readyState: observer.socket.readyState,
                }),
            try: () => terminateNativeWebSocket(observer.socket),
        });
        const closedAfterTermination = yield* Deferred.await(observer.closed).pipe(
            Effect.as(true),
            Effect.timeoutOrElse({
                duration: closeDeadline,
                orElse: () => Effect.succeed(false),
            })
        );
        if (!closedAfterTermination) {
            return yield* Effect.fail(
                new NativeWebSocketCloseError({
                    operation: "await-forced-close",
                    readyState: observer.socket.readyState,
                })
            );
        }
        return yield* Effect.fail(gracefulCloseError);
    });
    return close.pipe(
        Effect.andThen(awaitClose),
        Effect.ensuring(Effect.sync(observer.removeListeners))
    );
}

function openNativeWebSocketObserver(
    url: string,
    factory: NativeWebSocketFactory
): Effect.Effect<NativeWebSocketObserver, NativeWebSocketConstructionError> {
    return Effect.gen(function* () {
        const outcome = yield* Deferred.make<
            NativeWebSocketObservation,
            | NativeWebSocketClosedError
            | NativeWebSocketMessageLimitError
            | NativeWebSocketMessageTypeError
        >();
        const closed = yield* Deferred.make<void>();
        const observer = yield* Effect.try({
            catch: (cause) => new NativeWebSocketConstructionError({ cause }),
            try: () => {
                const counts: MutableEventCounts = {
                    closes: 0,
                    errors: 0,
                    messages: 0,
                    opens: 0,
                };
                const closeState = { requested: false };
                const socket = factory(url);
                const onClose = (event: CloseEvent): void => {
                    closeState.requested = true;
                    counts.closes += 1;
                    Deferred.doneUnsafe(closed, Effect.void);
                    const error = new NativeWebSocketClosedError({
                        code: event.code,
                        eventCounts: snapshotEventCounts(counts),
                        reason: event.reason,
                        wasClean: event.wasClean,
                    });
                    Deferred.doneUnsafe(outcome, Effect.fail(error));
                };
                const onError = (): void => {
                    counts.errors += 1;
                };
                const onMessage = (event: MessageEvent): void => {
                    counts.messages += 1;
                    if (Deferred.isDoneUnsafe(outcome)) return;
                    if (typeof event.data !== "string") {
                        closeState.requested = true;
                        const error = new NativeWebSocketMessageTypeError({
                            eventCounts: snapshotEventCounts(counts),
                        });
                        Deferred.doneUnsafe(outcome, Effect.fail(error));
                        socket.close(1003, "text messages required");
                        return;
                    }
                    const messageBytes = Buffer.byteLength(event.data, "utf8");
                    if (messageBytes > maximumNativeWebSocketMessageBytes) {
                        closeState.requested = true;
                        const error = new NativeWebSocketMessageLimitError({
                            actualBytes: messageBytes,
                            eventCounts: snapshotEventCounts(counts),
                            maximumBytes: maximumNativeWebSocketMessageBytes,
                        });
                        Deferred.doneUnsafe(outcome, Effect.fail(error));
                        socket.close(1009, "message too large");
                        return;
                    }
                    Deferred.doneUnsafe(
                        outcome,
                        Effect.succeed({
                            bufferedAmount: socket.bufferedAmount,
                            eventCounts: snapshotEventCounts(counts),
                            message: event.data,
                            messageBytes,
                        })
                    );
                };
                const onOpen = (): void => {
                    counts.opens += 1;
                };
                socket.addEventListener("close", onClose);
                socket.addEventListener("error", onError);
                socket.addEventListener("message", onMessage);
                socket.addEventListener("open", onOpen);
                const removeListeners = (): void => {
                    socket.removeEventListener("close", onClose);
                    socket.removeEventListener("error", onError);
                    socket.removeEventListener("message", onMessage);
                    socket.removeEventListener("open", onOpen);
                };
                return Object.freeze({
                    awaitObservation: Deferred.await(outcome),
                    closeState,
                    closed,
                    removeListeners,
                    socket,
                });
            },
        });
        return observer;
    });
}

/**
 * Observes exactly one bounded text message through Bun's native global WebSocket.
 * The first complete message wins over any subsequent close event, while cancellation
 * and deadlines close the socket through the Effect scope.
 * @param url Loopback WebSocket URL.
 * @param factory Injectable constructor used only to count connection attempts in tests.
 * @returns One native message observation or a tagged operational failure.
 */
export function observeNativeWebSocket(
    url: string,
    factory: NativeWebSocketFactory = (target) => new WebSocket(target)
): Effect.Effect<NativeWebSocketObservation, NativeWebSocketObservationError> {
    return Effect.acquireUseRelease(
        openNativeWebSocketObserver(url, factory),
        (observer) =>
            withNativeWebSocketDeadline(
                observer.awaitObservation,
                "await-native-message"
            ),
        closeObserver
    );
}

/**
 * Reserves and releases one loopback TCP port before a native refusal test.
 * The unavoidable release-to-connect port-reuse window is deliberately kept local
 * to the refusal test; the caller still verifies exactly one native connection attempt.
 * @returns A WebSocket URL with no listener remaining on its port.
 */
export function closedLoopbackWebSocketUrl(): Effect.Effect<
    string,
    NativeWebSocketConstructionError
> {
    return Effect.acquireUseRelease(
        Effect.try({
            catch: (cause) => new NativeWebSocketConstructionError({ cause }),
            try: () =>
                Bun.listen({
                    hostname: "127.0.0.1",
                    port: 0,
                    socket: {
                        data() {},
                    },
                }),
        }),
        (listener) => Effect.succeed(`ws://127.0.0.1:${listener.port}/integration`),
        (listener) => Effect.sync(() => listener.stop(true))
    );
}
