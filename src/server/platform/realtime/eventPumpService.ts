import { Cause, Context, Duration, Effect, Layer, Queue, Stream } from "effect";
import * as v from "valibot";

import {
    nonnegativeSafeIntegerSchema,
    parseSchemaWithRangeError,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import { BoundedAsyncQueueOverflowError } from "./boundedAsyncQueue.ts";
import {
    RealtimeCursorError,
    realtimeEventPumpDefaults,
    RealtimeSubscriptionInputError,
    type RealtimeEventDelivery,
    type RealtimeEventPollPlan,
    type RealtimeEventPumpMetrics,
    type RealtimeEventSubscriptionStoreRead,
    type RealtimeEventSubscriptionOptions,
} from "./eventPump.ts";
import * as StreamErrors from "./eventPumpStreamErrors.ts";
import { retryRealtimeEventStoreOperation } from "./eventStoreEffect.ts";

export * from "./eventPumpStreamErrors.ts";

interface RealtimeEventPumpPort {
    close(): void;
    failSubscribers(error: Error): void;
    metricsSnapshot(): Readonly<RealtimeEventPumpMetrics>;
    poll(): RealtimeEventPollPlan;
    recordPollFailure(): void;
    recordRetryablePollRetry(): void;
    recordRetryableSubscriptionReadRetry(): void;
    recordSubscriptionReadFailure(): void;
    subscribe(
        options: RealtimeEventSubscriptionOptions
    ): AsyncGenerator<RealtimeEventDelivery>;
    wake(): void;
}

export interface RealtimeEventPumpLayerOptions {
    readonly activePollIntervalMs?: number;
    readonly idlePollIntervalMs?: number;
    readonly makePump: (runtime: RealtimeEventPumpRuntime) => RealtimeEventPumpPort;
    readonly maximumRetryablePollRetries?: number;
    readonly retryablePollBaseDelayMs?: number;
    readonly retryablePollMaximumDelayMs?: number;
}

export interface RealtimeEventPumpRuntime {
    readonly readSubscriptionStore: RealtimeEventSubscriptionStoreRead;
    readonly requestPoll: () => void;
}

interface NormalizedRuntimeOptions {
    readonly activePollIntervalMs: number;
    readonly idlePollIntervalMs: number;
    readonly maximumRetryablePollRetries: number;
    readonly retryablePollBaseDelayMs: number;
    readonly retryablePollMaximumDelayMs: number;
}

export interface RealtimeEventStreamOptions {
    readonly afterId: string;
    readonly signal?: AbortSignal;
    readonly topics?: readonly string[];
}

class RealtimeEventStoreSubscriptionError extends Error {
    constructor() {
        super("Realtime event store is temporarily unavailable");
        this.name = "RealtimeEventStoreSubscriptionError";
    }
}

interface RealtimeEventPumpRunnerState {
    failed: boolean;
}

interface RealtimeEventPumpServiceShape {
    readonly metricsSnapshot: Effect.Effect<Readonly<RealtimeEventPumpMetrics>>;
    readonly stream: (
        options: RealtimeEventStreamOptions
    ) => Stream.Stream<RealtimeEventDelivery, StreamErrors.RealtimeEventStreamError>;
    readonly wake: Effect.Effect<void>;
}

export class RealtimeEventPumpService extends Context.Service<
    RealtimeEventPumpService,
    RealtimeEventPumpServiceShape
>()("mira-dashboard/server/platform/realtime/RealtimeEventPumpService") {}

const runtimeOptionsObjectSchema = v.strictObject({
    activePollIntervalMs: positiveSafeIntegerSchema(
        "Realtime active poll interval must be a positive safe integer"
    ),
    idlePollIntervalMs: positiveSafeIntegerSchema(
        "Realtime idle poll interval must be a positive safe integer"
    ),
    maximumRetryablePollRetries: nonnegativeSafeIntegerSchema(
        "Realtime maximum retryable poll retries must be a nonnegative safe integer"
    ),
    retryablePollBaseDelayMs: positiveSafeIntegerSchema(
        "Realtime retryable poll base delay must be a positive safe integer"
    ),
    retryablePollMaximumDelayMs: positiveSafeIntegerSchema(
        "Realtime retryable poll maximum delay must be a positive safe integer"
    ),
});

const runtimeOptionsSchema = v.pipe(
    runtimeOptionsObjectSchema,
    v.check(
        (options) =>
            options.retryablePollMaximumDelayMs >= options.retryablePollBaseDelayMs,
        "Realtime retryable poll maximum delay cannot be below its base delay"
    ),
    v.readonly()
);

function normalizeRuntimeOptions(
    options: RealtimeEventPumpLayerOptions
): NormalizedRuntimeOptions {
    return parseSchemaWithRangeError(runtimeOptionsSchema, {
        activePollIntervalMs:
            options.activePollIntervalMs ??
            realtimeEventPumpDefaults.activePollIntervalMs,
        idlePollIntervalMs:
            options.idlePollIntervalMs ?? realtimeEventPumpDefaults.idlePollIntervalMs,
        maximumRetryablePollRetries:
            options.maximumRetryablePollRetries ??
            realtimeEventPumpDefaults.maximumRetryablePollRetries,
        retryablePollBaseDelayMs:
            options.retryablePollBaseDelayMs ??
            realtimeEventPumpDefaults.retryablePollBaseDelayMs,
        retryablePollMaximumDelayMs:
            options.retryablePollMaximumDelayMs ??
            realtimeEventPumpDefaults.retryablePollMaximumDelayMs,
    });
}

const pollWithRecovery = Effect.fn("RealtimeEventPump.pollWithRecovery")(
    (pump: RealtimeEventPumpPort, options: NormalizedRuntimeOptions) =>
        retryRealtimeEventStoreOperation(() => pump.poll(), {
            maximumRetries: options.maximumRetryablePollRetries,
            onAttemptFailure: () => pump.recordPollFailure(),
            onRetry: () => pump.recordRetryablePollRetry(),
            retryBaseDelayMs: options.retryablePollBaseDelayMs,
            retryMaximumDelayMs: options.retryablePollMaximumDelayMs,
        }).pipe(
            Effect.catchTags({
                RealtimeEventStoreBusyError: () =>
                    Effect.sync(() => {
                        pump.failSubscribers(new RealtimeEventStoreSubscriptionError());
                        return "idle" as const;
                    }),
                RealtimeEventStoreUnavailableError: () =>
                    Effect.sync(() => {
                        pump.failSubscribers(new RealtimeEventStoreSubscriptionError());
                        return "idle" as const;
                    }),
            })
        )
);

const pollLoop = Effect.fn("RealtimeEventPump.pollLoop")(function* (
    pump: RealtimeEventPumpPort,
    wakeQueue: Queue.Queue<void>,
    options: NormalizedRuntimeOptions
): Effect.fn.Return<never> {
    while (true) {
        const plan = yield* pollWithRecovery(pump, options);
        if (plan === "immediate") {
            // Give stream fibers a chance to drain deliveries before the next bounded page.
            yield* Effect.yieldNow;
            continue;
        }
        const delayMs =
            plan === "active" ? options.activePollIntervalMs : options.idlePollIntervalMs;
        yield* Effect.raceFirst(
            Effect.sleep(Duration.millis(delayMs)),
            Queue.take(wakeQueue)
        );
    }
});

function streamError(
    error: unknown,
    runnerState: RealtimeEventPumpRunnerState
): StreamErrors.RealtimeEventStreamError {
    if (runnerState.failed) {
        return new StreamErrors.RealtimeEventStoreStreamError({
            message: "Realtime event store is temporarily unavailable",
        });
    }
    if (error instanceof RealtimeCursorError) {
        return new StreamErrors.RealtimeEventCursorStreamError({
            code: error.code,
            message: error.message,
        });
    }
    if (error instanceof RealtimeSubscriptionInputError) {
        return new StreamErrors.RealtimeEventSubscriptionStreamError({
            code: error.code,
            message: error.message,
        });
    }
    if (error instanceof RealtimeEventStoreSubscriptionError) {
        return new StreamErrors.RealtimeEventStoreStreamError({
            message: error.message,
        });
    }
    if (error instanceof BoundedAsyncQueueOverflowError) {
        return new StreamErrors.RealtimeEventSlowConsumerStreamError({
            message: error.message,
        });
    }

    // Throwing from the mapper keeps invariant/programmer failures in Effect's defect
    // channel instead of misrepresenting them as expected client-visible failures.
    throw error;
}

function subscriptionStream(
    pump: RealtimeEventPumpPort,
    options: RealtimeEventStreamOptions,
    runnerState: RealtimeEventPumpRunnerState
): Stream.Stream<RealtimeEventDelivery, StreamErrors.RealtimeEventStreamError> {
    return Stream.suspend(() => {
        if (runnerState.failed) {
            return Stream.fail(
                new StreamErrors.RealtimeEventStoreStreamError({
                    message: "Realtime event store is temporarily unavailable",
                })
            );
        }
        const streamAbortController = new AbortController();
        const signal =
            options.signal === undefined
                ? streamAbortController.signal
                : AbortSignal.any([options.signal, streamAbortController.signal]);
        const subscription = pump.subscribe({
            afterId: options.afterId,
            signal,
            ...(options.topics === undefined ? {} : { topics: options.topics }),
        });
        const iterable: AsyncIterable<RealtimeEventDelivery> = {
            [Symbol.asyncIterator]() {
                return {
                    next: () => subscription.next(),
                    return: () => {
                        // Abort first: a blocked async generator cannot complete return()
                        // until its pending queue read observes cancellation.
                        streamAbortController.abort();
                        return subscription.return(undefined);
                    },
                };
            },
        };
        return Stream.fromAsyncIterable(iterable, (error) =>
            streamError(error, runnerState)
        );
    });
}

function createService(
    pump: RealtimeEventPumpPort,
    runnerState: RealtimeEventPumpRunnerState
): RealtimeEventPumpService["Service"] {
    return RealtimeEventPumpService.of({
        metricsSnapshot: Effect.sync(() => pump.metricsSnapshot()),
        stream: (options) => subscriptionStream(pump, options, runnerState),
        wake: Effect.sync(() => pump.wake()),
    });
}

/**
 * Acquires one fresh event pump, runs its adaptive polling fiber in scope, and
 * interrupts the runner before closing the pump when the layer scope ends.
 * @param options Pump factory and validated runtime timing overrides.
 * @returns A scoped layer that provides the realtime event pump service.
 */
export function realtimeEventPumpLayer(
    options: RealtimeEventPumpLayerOptions
): Layer.Layer<RealtimeEventPumpService> {
    const runtimeOptions = normalizeRuntimeOptions(options);
    return Layer.effect(
        RealtimeEventPumpService,
        Effect.gen(function* () {
            const runnerState: RealtimeEventPumpRunnerState = { failed: false };
            const serviceContext = yield* Effect.context();
            const runSubscriptionEffect = Effect.runPromiseWith(serviceContext);
            const wakeQueue = yield* Effect.acquireRelease(
                Queue.dropping<void>(1),
                Queue.shutdown
            );
            let acquiredPump: RealtimeEventPumpPort | undefined;
            const pump = yield* Effect.acquireRelease(
                Effect.sync(() => {
                    const pump = options.makePump({
                        readSubscriptionStore: (read, signal) =>
                            runSubscriptionEffect(
                                retryRealtimeEventStoreOperation(read, {
                                    maximumRetries:
                                        runtimeOptions.maximumRetryablePollRetries,
                                    onAttemptFailure: () =>
                                        acquiredPump?.recordSubscriptionReadFailure(),
                                    onRetry: () =>
                                        acquiredPump?.recordRetryableSubscriptionReadRetry(),
                                    retryBaseDelayMs:
                                        runtimeOptions.retryablePollBaseDelayMs,
                                    retryMaximumDelayMs:
                                        runtimeOptions.retryablePollMaximumDelayMs,
                                }).pipe(
                                    Effect.mapError(
                                        () => new RealtimeEventStoreSubscriptionError()
                                    )
                                ),
                                { signal }
                            ),
                        requestPoll: () => {
                            Queue.offerUnsafe(wakeQueue, undefined);
                        },
                    });
                    acquiredPump = pump;
                    return pump;
                }),
                (acquiredPump) => Effect.sync(() => acquiredPump.close())
            );
            yield* pollLoop(pump, wakeQueue, runtimeOptions).pipe(
                Effect.catchCauseIf(
                    (cause) => !Cause.hasInterruptsOnly(cause),
                    () =>
                        Effect.gen(function* () {
                            yield* Effect.sync(() => {
                                runnerState.failed = true;
                                pump.failSubscribers(
                                    new RealtimeEventStoreSubscriptionError()
                                );
                                pump.close();
                            });
                            yield* Effect.logError(
                                "Realtime event pump runner failed"
                            ).pipe(
                                Effect.annotateLogs({
                                    component: "realtime-event-pump",
                                    failureKind: "unexpected-runner-defect",
                                })
                            );
                        })
                ),
                Effect.forkScoped
            );
            return createService(pump, runnerState);
        })
    );
}
