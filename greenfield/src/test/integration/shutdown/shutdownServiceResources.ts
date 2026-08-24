import { rename } from "node:fs/promises";
import path from "node:path";

import {
    Data,
    Deferred,
    Duration,
    Effect,
    Exit,
    Fiber,
    Option,
    Schedule,
    Scope,
} from "effect";

import {
    createGatewayConnectRequest,
    createGatewayHelloResponse,
    parseGatewayChallenge,
    parseGatewayConnectRequest,
    parseGatewayHelloResponse,
    type ShutdownServiceStatus,
} from "./shutdownProtocol.ts";

const markerPollingSchedule = Schedule.spaced("5 millis").pipe(
    Schedule.upTo({ times: 2000 })
);
const operationDeadline = "10 seconds";
const applicationListenerGracefulStopDeadline = "250 millis";
const applicationListenerForcedStopDeadline = "2 seconds";
const grandchildModulePath = path.join(
    path.dirname(Bun.fileURLToPath(import.meta.url)),
    "shutdownGrandchild.ts"
);

type ShutdownIntegrationChildProcess = Bun.Subprocess<"ignore", "ignore", "ignore">;

export class ShutdownIntegrationResourceError extends Data.TaggedError(
    "ShutdownIntegrationResourceError"
)<{
    readonly cause?: unknown;
    readonly operation: string;
}> {}

export class ShutdownIntegrationDeadlineError extends Data.TaggedError(
    "ShutdownIntegrationDeadlineError"
)<{
    readonly operation: string;
}> {}

class ShutdownMarkerPendingError extends Data.TaggedError("ShutdownMarkerPendingError")<{
    readonly operation: string;
}> {}

function deadlineFailure(operation: string) {
    return new ShutdownIntegrationDeadlineError({ operation });
}

function withDeadline<A, E>(
    effect: Effect.Effect<A, E>,
    operation: string
): Effect.Effect<A, E | ShutdownIntegrationDeadlineError> {
    return effect.pipe(
        Effect.timeoutOrElse({
            duration: operationDeadline,
            orElse: () => Effect.fail(deadlineFailure(operation)),
        })
    );
}

export function awaitMarkerFile(
    markerPath: string,
    operation: string
): Effect.Effect<void, ShutdownIntegrationDeadlineError> {
    const attempt = Effect.tryPromise({
        catch: () => new ShutdownMarkerPendingError({ operation }),
        try: async () => {
            if (!(await Bun.file(markerPath).exists())) {
                throw new Error("marker pending");
            }
        },
    });
    return withDeadline(
        attempt.pipe(
            Effect.retry({ schedule: markerPollingSchedule }),
            Effect.catchTag("ShutdownMarkerPendingError", () =>
                Effect.fail(deadlineFailure(operation))
            )
        ),
        operation
    );
}

export function writeShutdownStatus(
    statusPath: string,
    status: ShutdownServiceStatus
): Effect.Effect<void, ShutdownIntegrationResourceError> {
    const temporaryPath = `${statusPath}.${process.pid}.tmp`;
    return Effect.tryPromise({
        catch: (cause) =>
            new ShutdownIntegrationResourceError({ cause, operation: "write-status" }),
        try: async () => {
            await Bun.write(temporaryPath, `${JSON.stringify(status)}\n`);
            await rename(temporaryPath, statusPath);
        },
    });
}

export interface ShutdownSignalResource {
    readonly awaitSignal: Effect.Effect<void>;
}

export function shutdownSignalResource(): Effect.Effect<
    ShutdownSignalResource,
    never,
    Scope.Scope
> {
    return Effect.gen(function* () {
        const requested = yield* Deferred.make<void>();
        const onSignal = () => {
            Deferred.doneUnsafe(requested, Effect.void);
        };
        yield* Effect.acquireRelease(
            Effect.sync(() => {
                process.on("SIGINT", onSignal);
                process.on("SIGTERM", onSignal);
            }),
            () =>
                Effect.sync(() => {
                    process.off("SIGINT", onSignal);
                    process.off("SIGTERM", onSignal);
                })
        );
        return Object.freeze({ awaitSignal: Deferred.await(requested) });
    });
}

interface ShutdownApplicationState {
    gatewaySocketOpen: boolean;
    leaseActive: boolean;
    readiness: boolean;
}

interface StoppableApplicationListener {
    stop(force?: boolean): Promise<void>;
}

interface ApplicationListenerStopPolicy {
    readonly forcedStopDeadline: Duration.Input;
    readonly gracefulStopDeadline: Duration.Input;
}

const defaultApplicationListenerStopPolicy: ApplicationListenerStopPolicy = {
    forcedStopDeadline: applicationListenerForcedStopDeadline,
    gracefulStopDeadline: applicationListenerGracefulStopDeadline,
};

/**
 * Applies the production-shaped graceful-to-forced listener stop policy.
 * @param server Listener stop boundary.
 * @param policy Bounded graceful and forced stop durations.
 * @returns The observed successful shutdown mode.
 */
export function stopApplicationListener(
    server: StoppableApplicationListener,
    policy: ApplicationListenerStopPolicy = defaultApplicationListenerStopPolicy
): Effect.Effect<
    "forced" | "graceful",
    ShutdownIntegrationDeadlineError | ShutdownIntegrationResourceError
> {
    const stopServer = (force: boolean) =>
        Effect.tryPromise({
            catch: (cause) =>
                new ShutdownIntegrationResourceError({
                    cause,
                    operation: force
                        ? "force-stop-application-listener"
                        : "gracefully-stop-application-listener",
                }),
            try: () => server.stop(force),
        });
    const boundedForceStop = stopServer(true).pipe(
        Effect.timeoutOrElse({
            duration: policy.forcedStopDeadline,
            orElse: () => Effect.fail(deadlineFailure("force-stop-application-listener")),
        })
    );

    return Effect.scoped(
        Effect.gen(function* () {
            const gracefulFiber = yield* Effect.forkScoped(stopServer(false));
            const gracefulExit = yield* Fiber.await(gracefulFiber).pipe(
                Effect.timeoutOption(policy.gracefulStopDeadline)
            );
            if (Option.isSome(gracefulExit)) {
                if (Exit.isSuccess(gracefulExit.value)) return "graceful";
                yield* boundedForceStop.pipe(Effect.ignore);
                return yield* Effect.failCause(gracefulExit.value.cause);
            }

            yield* boundedForceStop;
            yield* Fiber.join(gracefulFiber).pipe(
                Effect.timeoutOrElse({
                    duration: policy.forcedStopDeadline,
                    orElse: () =>
                        Effect.fail(
                            deadlineFailure("join-forced-application-listener-stop")
                        ),
                })
            );
            return "forced";
        })
    );
}

export interface ShutdownApplicationServer {
    readonly port: number;
    readonly sseConnectionCount: number;
    close(): Effect.Effect<
        "forced" | "graceful",
        ShutdownIntegrationDeadlineError | ShutdownIntegrationResourceError
    >;
}

export function applicationServerResource(
    state: ShutdownApplicationState
): Effect.Effect<
    ShutdownApplicationServer,
    ShutdownIntegrationResourceError,
    Scope.Scope
> {
    return Effect.acquireRelease(
        Effect.gen(function* () {
            const listener = yield* Effect.try({
                catch: (cause) =>
                    new ShutdownIntegrationResourceError({
                        cause,
                        operation: "start-application-listener",
                    }),
                try: () => {
                    const encoder = new TextEncoder();
                    const controllers = new Set<
                        ReadableStreamDefaultController<Uint8Array>
                    >();
                    const server = Bun.serve({
                        fetch(request) {
                            const pathname = new URL(request.url).pathname;
                            if (pathname === "/api/health/ready") {
                                return Response.json(
                                    { status: state.readiness ? "ready" : "not-ready" },
                                    { status: state.readiness ? 200 : 503 }
                                );
                            }
                            if (pathname === "/api/shutdown/state") {
                                return Response.json({
                                    gatewaySocketOpen: state.gatewaySocketOpen,
                                    leaseActive: state.leaseActive,
                                    readiness: state.readiness,
                                    sseConnectionCount: controllers.size,
                                });
                            }
                            if (pathname === "/api/events") {
                                let ownedController:
                                    | ReadableStreamDefaultController<Uint8Array>
                                    | undefined;
                                return new Response(
                                    new ReadableStream<Uint8Array>({
                                        cancel() {
                                            if (ownedController !== undefined) {
                                                controllers.delete(ownedController);
                                            }
                                        },
                                        start(controller) {
                                            ownedController = controller;
                                            controllers.add(controller);
                                            controller.enqueue(
                                                encoder.encode(
                                                    'event: ready\ndata: {"status":"connected"}\n\n'
                                                )
                                            );
                                        },
                                    }),
                                    {
                                        headers: {
                                            "cache-control": "no-store",
                                            "content-type": "text/event-stream",
                                        },
                                    }
                                );
                            }
                            return new Response("Not found", { status: 404 });
                        },
                        hostname: "127.0.0.1",
                        port: 0,
                    });
                    if (server.port === undefined) {
                        void server.stop(true);
                        throw new Error(
                            "Shutdown integration listener has no bound port"
                        );
                    }
                    return { controllers, port: server.port, server };
                },
            });
            const close = yield* Effect.cached(
                Effect.gen(function* () {
                    yield* Effect.sync(() => {
                        for (const controller of listener.controllers) {
                            controller.close();
                        }
                        listener.controllers.clear();
                    });
                    return yield* stopApplicationListener(listener.server);
                })
            );

            return Object.freeze({
                close: () => close,
                port: listener.port,
                get sseConnectionCount() {
                    return listener.controllers.size;
                },
            });
        }),
        (server) => server.close().pipe(Effect.asVoid, Effect.orDie)
    );
}

interface GatewayFixtureSocketData {
    readonly integration: true;
}

export interface GatewayFixtureServer {
    readonly url: string;
    close(): Effect.Effect<void, ShutdownIntegrationResourceError>;
}

export function gatewayFixtureResource(): Effect.Effect<
    GatewayFixtureServer,
    ShutdownIntegrationResourceError,
    Scope.Scope
> {
    return Effect.acquireRelease(
        Effect.try({
            catch: (cause) =>
                new ShutdownIntegrationResourceError({
                    cause,
                    operation: "start-gateway-fixture",
                }),
            try: () => {
                let closePromise: Promise<void> | undefined;
                const server = Bun.serve<GatewayFixtureSocketData>({
                    fetch(request, bunServer) {
                        return bunServer.upgrade(request, {
                            data: { integration: true },
                        })
                            ? undefined
                            : new Response("WebSocket upgrade required", {
                                  status: 426,
                              });
                    },
                    hostname: "127.0.0.1",
                    port: 0,
                    websocket: {
                        message(socket, message) {
                            try {
                                const request = parseGatewayConnectRequest(
                                    typeof message === "string"
                                        ? message
                                        : message.toString("utf8")
                                );
                                if (
                                    request.params.nonce !== "shutdown-integration-nonce"
                                ) {
                                    throw new Error(
                                        "Gateway connect request did not echo its challenge"
                                    );
                                }
                                socket.send(JSON.stringify(createGatewayHelloResponse()));
                            } catch {
                                socket.close(1008, "invalid connect request");
                            }
                        },
                        open(socket) {
                            socket.send(
                                JSON.stringify({
                                    event: "connect.challenge",
                                    payload: {
                                        nonce: "shutdown-integration-nonce",
                                        ts: 1_786_000_000_000,
                                    },
                                    type: "event",
                                })
                            );
                        },
                    },
                });
                const url = new URL(server.url);
                url.protocol = "ws:";
                return Object.freeze({
                    close() {
                        closePromise ??= server.stop(true);
                        return Effect.tryPromise({
                            catch: (cause) =>
                                new ShutdownIntegrationResourceError({
                                    cause,
                                    operation: "stop-gateway-fixture",
                                }),
                            try: () => closePromise!,
                        });
                    },
                    url: url.href,
                });
            },
        }),
        (fixture) => fixture.close().pipe(Effect.orDie)
    );
}

function openGatewaySocket(
    url: string
): Effect.Effect<
    WebSocket,
    ShutdownIntegrationDeadlineError | ShutdownIntegrationResourceError
> {
    const connection = Effect.callback<WebSocket, ShutdownIntegrationResourceError>(
        (resume) => {
            const socket = new WebSocket(url);
            let connectSent = false;
            let settled = false;
            const removeListeners = () => {
                socket.removeEventListener("close", onClose);
                socket.removeEventListener("error", onError);
                socket.removeEventListener("message", onMessage);
            };
            const closeSocket = (reason: string) => {
                if (
                    socket.readyState === WebSocket.CONNECTING ||
                    socket.readyState === WebSocket.OPEN
                ) {
                    socket.close(1000, reason);
                }
            };
            const fail = (operation: string, cause?: unknown) => {
                if (settled) return;
                settled = true;
                removeListeners();
                closeSocket("integration handshake failed");
                resume(
                    Effect.fail(
                        new ShutdownIntegrationResourceError({ cause, operation })
                    )
                );
            };
            const onClose = () => fail("gateway-closed-before-hello");
            const onError = (event: Event) => fail("gateway-transport-error", event);
            const onMessage = (event: MessageEvent) => {
                if (typeof event.data !== "string") {
                    fail("gateway-non-text-frame");
                    return;
                }
                try {
                    if (!connectSent) {
                        const challenge = parseGatewayChallenge(event.data);
                        connectSent = true;
                        socket.send(
                            JSON.stringify(
                                createGatewayConnectRequest(challenge.payload.nonce)
                            )
                        );
                        return;
                    }
                    parseGatewayHelloResponse(event.data);
                    settled = true;
                    removeListeners();
                    resume(Effect.succeed(socket));
                } catch (error) {
                    fail("gateway-protocol-error", error);
                }
            };
            socket.addEventListener("close", onClose);
            socket.addEventListener("error", onError);
            socket.addEventListener("message", onMessage);
            return Effect.sync(() => {
                removeListeners();
                closeSocket("integration interrupted");
            });
        }
    );
    return withDeadline(connection, "gateway-handshake");
}

function closeGatewaySocket(socket: WebSocket): Effect.Effect<void> {
    if (socket.readyState === WebSocket.CLOSED) return Effect.void;
    const close = Effect.callback<void>((resume) => {
        const onClose = () => {
            socket.removeEventListener("close", onClose);
            resume(Effect.void);
        };
        socket.addEventListener("close", onClose, { once: true });
        if (
            socket.readyState === WebSocket.CONNECTING ||
            socket.readyState === WebSocket.OPEN
        ) {
            socket.close(1000, "integration shutdown");
        }
        return Effect.sync(() => socket.removeEventListener("close", onClose));
    });
    return close.pipe(
        Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () =>
                Effect.die(
                    new Error("Shutdown integration Gateway socket did not close")
                ),
        })
    );
}

export function gatewaySocketResource(
    url: string
): Effect.Effect<
    WebSocket,
    ShutdownIntegrationDeadlineError | ShutdownIntegrationResourceError,
    Scope.Scope
> {
    return Effect.acquireRelease(openGatewaySocket(url), closeGatewaySocket);
}

function awaitChildExit(
    child: ShutdownIntegrationChildProcess,
    operation: string
): Effect.Effect<
    number,
    ShutdownIntegrationDeadlineError | ShutdownIntegrationResourceError
> {
    return withDeadline(
        Effect.tryPromise({
            catch: (cause) => new ShutdownIntegrationResourceError({ cause, operation }),
            try: () => child.exited,
        }),
        operation
    );
}

function stopGrandchild(child: ShutdownIntegrationChildProcess): Effect.Effect<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Effect.void;
    return Effect.sync(() => child.kill("SIGTERM")).pipe(
        Effect.andThen(awaitChildExit(child, "stop-grandchild")),
        Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () =>
                Effect.sync(() => child.kill("SIGKILL")).pipe(
                    Effect.andThen(awaitChildExit(child, "kill-grandchild"))
                ),
        }),
        Effect.asVoid,
        Effect.orDie
    );
}

export function grandchildProcessResource(): Effect.Effect<
    ShutdownIntegrationChildProcess,
    ShutdownIntegrationResourceError,
    Scope.Scope
> {
    return Effect.acquireRelease(
        Effect.try({
            catch: (cause) =>
                new ShutdownIntegrationResourceError({
                    cause,
                    operation: "start-grandchild",
                }),
            try: () =>
                Bun.spawn([process.execPath, grandchildModulePath], {
                    detached: false,
                    stderr: "ignore",
                    stdin: "ignore",
                    stdout: "ignore",
                }),
        }),
        stopGrandchild
    );
}
