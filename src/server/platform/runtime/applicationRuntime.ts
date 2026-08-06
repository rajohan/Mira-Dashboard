import { Data, Effect, Exit, Fiber, Layer, ManagedRuntime, Stream } from "effect";

import {
    type AuthenticationWorkLayerOptions,
    type AuthenticationWorkRuntimeService,
    AuthenticationWorkCapacityError,
    AuthenticationWorkService,
    authenticationWorkLayer,
    type AuthenticationVerificationWorkOptions,
} from "../../domains/security/authenticationWorkGate.ts";
import { createEffectLoggerLayer } from "../observability/effectLogger.ts";
import type { StructuredLogger } from "../observability/structuredLogger.ts";
import type { RealtimeEventDelivery } from "../realtime/eventPump.ts";
import type { RealtimeEventStreamOptions } from "../realtime/eventPumpService.ts";
import { RealtimeEventPumpService } from "../realtime/eventPumpService.ts";
import {
    type RenewableStreamLease,
    withRenewableStreamLease,
} from "../realtime/renewableStreamLease.ts";

/** Request-safe realtime methods backed by the process runtime. */
export interface RealtimeEventRuntimeService {
    stream(
        options: RealtimeEventStreamOptions,
        lease: RenewableStreamLease
    ): Promise<AsyncIterable<RealtimeEventDelivery>>;
}

/** Request-safe process services without lifecycle controls. */
export interface ApplicationRuntimeServices {
    readonly authentication: AuthenticationWorkRuntimeService;
    readonly realtimeEvents: RealtimeEventRuntimeService;
}

export type ApplicationListenerStopOperation = "force" | "graceful";
export type ApplicationListenerStopWait = "force" | "graceful-settlement";

/** Expected operational rejection from Bun listener shutdown. */
export class ApplicationListenerStopError extends Data.TaggedError(
    "ApplicationListenerStopError"
)<{
    readonly cause: unknown;
    readonly operation: ApplicationListenerStopOperation;
}> {}

/** Expected failure when listener shutdown does not settle inside its budget. */
export class ApplicationListenerStopTimeoutError extends Data.TaggedError(
    "ApplicationListenerStopTimeoutError"
)<{
    readonly operation: ApplicationListenerStopWait;
    readonly timeoutMs: number;
}> {}

export type ApplicationListenerShutdownError =
    | ApplicationListenerStopError
    | ApplicationListenerStopTimeoutError;

/** One process-listener shutdown coordinated by the process Effect runtime. */
export interface ApplicationListenerShutdownOptions {
    /** Synchronous escalation bridge used by repeated `ApplicationServer.stop(true)`. */
    readonly forceSignal: AbortSignal;
    /** Independent budget applied to each graceful, forced, and settlement phase. */
    readonly gracefulShutdownTimeoutMs: number;
    readonly stop: (force: boolean) => Promise<void>;
}

/** Effect-backed lifecycle and request services owned by one long-lived Bun process. */
export interface ApplicationRuntime {
    /** Exact process logger installed on this runtime's Effect layer. */
    readonly logger: StructuredLogger;
    readonly services: ApplicationRuntimeServices;
    dispose(): Promise<void>;
    /** Eagerly builds and caches every process-owned layer before readiness. */
    initialize(): Promise<void>;
    /** Drains or force-stops the one process listener before runtime disposal. */
    shutdownListener(options: ApplicationListenerShutdownOptions): Promise<void>;
}

/** Scoped layers owned by one composition root for the full process lifetime. */
export interface ApplicationRuntimeOptions {
    readonly authenticationWork?: AuthenticationWorkLayerOptions;
    readonly logger: StructuredLogger;
    readonly realtimeEventPumpLayer: Layer.Layer<RealtimeEventPumpService>;
}

function authenticationAbortReason(signal: AbortSignal): unknown {
    return (
        signal.reason ?? new DOMException("Authentication request aborted", "AbortError")
    );
}

function abortSignalEffect(signal: AbortSignal): Effect.Effect<void> {
    return Effect.callback<void>((resume) => {
        if (signal.aborted) {
            resume(Effect.void);
            return;
        }
        const onAbort = () => resume(Effect.void);
        signal.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", onAbort));
    });
}

function listenerStopEffect(
    options: ApplicationListenerShutdownOptions,
    force: boolean
): Effect.Effect<void, ApplicationListenerStopError> {
    return Effect.tryPromise({
        catch: (cause) =>
            new ApplicationListenerStopError({
                cause,
                operation: force ? "force" : "graceful",
            }),
        try: () => options.stop(force),
    });
}

function boundedForceListenerStop(
    options: ApplicationListenerShutdownOptions
): Effect.Effect<void, ApplicationListenerShutdownError> {
    return listenerStopEffect(options, true).pipe(
        Effect.timeoutOrElse({
            duration: options.gracefulShutdownTimeoutMs,
            orElse: () =>
                Effect.fail(
                    new ApplicationListenerStopTimeoutError({
                        operation: "force",
                        timeoutMs: options.gracefulShutdownTimeoutMs,
                    })
                ),
        })
    );
}

function awaitGracefulListenerSettlement(
    options: ApplicationListenerShutdownOptions,
    gracefulFiber: Fiber.Fiber<void, ApplicationListenerStopError>
): Effect.Effect<void, ApplicationListenerStopTimeoutError> {
    return Fiber.await(gracefulFiber).pipe(
        Effect.asVoid,
        Effect.timeoutOrElse({
            duration: options.gracefulShutdownTimeoutMs,
            orElse: () =>
                Effect.fail(
                    new ApplicationListenerStopTimeoutError({
                        operation: "graceful-settlement",
                        timeoutMs: options.gracefulShutdownTimeoutMs,
                    })
                ),
        })
    );
}

function forceAndSettleGracefulListener(
    options: ApplicationListenerShutdownOptions,
    gracefulFiber: Fiber.Fiber<void, ApplicationListenerStopError>
): Effect.Effect<void, ApplicationListenerShutdownError> {
    return boundedForceListenerStop(options).pipe(
        Effect.andThen(awaitGracefulListenerSettlement(options, gracefulFiber))
    );
}

function coordinatedListenerShutdown(
    options: ApplicationListenerShutdownOptions
): Effect.Effect<void, ApplicationListenerShutdownError> {
    return Effect.scoped(
        Effect.gen(function* () {
            if (options.forceSignal.aborted) {
                return yield* boundedForceListenerStop(options);
            }

            const gracefulFiber = yield* listenerStopEffect(options, false).pipe(
                Effect.forkScoped
            );
            const gracefulOutcome = Fiber.await(gracefulFiber).pipe(
                Effect.map((exit) => ({ exit, kind: "graceful" as const }))
            );
            const forceRequested = abortSignalEffect(options.forceSignal).pipe(
                Effect.as({ kind: "force-requested" as const })
            );
            const gracefulDeadline = Effect.sleep(options.gracefulShutdownTimeoutMs).pipe(
                Effect.as({ kind: "deadline" as const })
            );
            const outcome = yield* Effect.raceFirst(
                gracefulOutcome,
                Effect.raceFirst(forceRequested, gracefulDeadline)
            );

            if (outcome.kind !== "graceful") {
                return yield* forceAndSettleGracefulListener(options, gracefulFiber);
            }
            if (Exit.isSuccess(outcome.exit)) return;

            // A failed graceful stop still receives one bounded force attempt. Its
            // initiating failure remains the externally observable root cause.
            yield* boundedForceListenerStop(options).pipe(Effect.ignore);
            return yield* Effect.failCause(outcome.exit.cause);
        })
    );
}

/**
 * Creates one reusable Effect runtime whose scope is owned by the current process.
 * `initialize` eagerly prewarms the otherwise lazy layer before the listener opens;
 * `dispose` releases it after active HTTP and SSE requests have stopped.
 * @param options Scoped application layers.
 * @returns One reusable and explicitly disposable application runtime.
 */
export function createApplicationRuntime(
    options: ApplicationRuntimeOptions
): ApplicationRuntime {
    const runtime = ManagedRuntime.make(
        Layer.mergeAll(
            options.realtimeEventPumpLayer,
            authenticationWorkLayer(options.authenticationWork),
            createEffectLoggerLayer(options.logger)
        )
    );
    let disposePromise: Promise<void> | undefined;
    const runAuthenticationEffect = async <T, E>(
        effect: Effect.Effect<T, E, AuthenticationWorkService>,
        signal?: AbortSignal
    ): Promise<T> => {
        try {
            return await runtime.runPromise(effect, { signal });
        } catch (error) {
            if (signal?.aborted === true) throw authenticationAbortReason(signal);
            throw error;
        }
    };
    const services: ApplicationRuntimeServices = Object.freeze({
        authentication: Object.freeze({
            passwordWorkGate: Object.freeze({
                async run<T>(work: () => Promise<T>, signal?: AbortSignal) {
                    try {
                        const value = await runAuthenticationEffect(
                            AuthenticationWorkService.pipe(
                                Effect.flatMap((service) => service.runPasswordWork(work))
                            ),
                            signal
                        );
                        return { accepted: true as const, value };
                    } catch (error) {
                        if (error instanceof AuthenticationWorkCapacityError) {
                            return { accepted: false as const };
                        }
                        throw error;
                    }
                },
            }),
            totpWorkGate: Object.freeze({
                async run<T>(work: () => Promise<T>, signal?: AbortSignal) {
                    try {
                        const value = await runAuthenticationEffect(
                            AuthenticationWorkService.pipe(
                                Effect.flatMap((service) => service.runTotpWork(work))
                            ),
                            signal
                        );
                        return { accepted: true as const, value };
                    } catch (error) {
                        if (error instanceof AuthenticationWorkCapacityError) {
                            return { accepted: false as const };
                        }
                        throw error;
                    }
                },
            }),
            runGatewayVerification<T>(
                work: (signal: AbortSignal) => Promise<T>,
                workOptions: AuthenticationVerificationWorkOptions<T>
            ) {
                return runAuthenticationEffect(
                    AuthenticationWorkService.pipe(
                        Effect.flatMap((service) =>
                            service.runGatewayVerification(
                                work,
                                workOptions.timeoutMs,
                                workOptions.onBeforeStart,
                                workOptions.onCancellationBeforeRelease,
                                workOptions.onFailureBeforeRelease,
                                workOptions.onResultBeforeRelease
                            )
                        )
                    ),
                    workOptions.signal
                );
            },
            runWebAuthnVerification<T>(
                work: (signal: AbortSignal) => Promise<T>,
                workOptions: AuthenticationVerificationWorkOptions<T>
            ) {
                return runAuthenticationEffect(
                    AuthenticationWorkService.pipe(
                        Effect.flatMap((service) =>
                            service.runWebAuthnVerification(
                                work,
                                workOptions.timeoutMs,
                                workOptions.onBeforeStart,
                                workOptions.onCancellationBeforeRelease,
                                workOptions.onFailureBeforeRelease,
                                workOptions.onResultBeforeRelease
                            )
                        )
                    ),
                    workOptions.signal
                );
            },
        }),
        realtimeEvents: Object.freeze({
            stream(
                streamOptions: RealtimeEventStreamOptions,
                lease: RenewableStreamLease
            ) {
                // Effect 4 captures this ManagedRuntime's cached Context here.
                // The returned AsyncIterator owns and closes only its subscription scope.
                return runtime.runPromise(
                    RealtimeEventPumpService.pipe(
                        Effect.flatMap((service) => {
                            const source = service.stream(streamOptions);
                            const leased = withRenewableStreamLease(source, lease);
                            const interruptible =
                                streamOptions.signal === undefined
                                    ? leased
                                    : leased.pipe(
                                          Stream.interruptWhen(
                                              abortSignalEffect(streamOptions.signal)
                                          )
                                      );
                            return Stream.toAsyncIterableEffect(interruptible);
                        })
                    )
                );
            },
        }),
    });

    return Object.freeze({
        dispose() {
            disposePromise ??= runtime.dispose();
            return disposePromise;
        },
        async initialize() {
            await runtime.context();
        },
        logger: options.logger,
        services,
        shutdownListener(options: ApplicationListenerShutdownOptions) {
            return runtime.runPromise(coordinatedListenerShutdown(options));
        },
    });
}
