import { Context, Data, Effect, Fiber, FiberSet, Layer, Semaphore } from "effect";

export type AuthenticationWorkOperation = "gateway" | "password" | "totp";

/** Expected rejection when the process-owned authentication queue is full. */
export class AuthenticationWorkCapacityError extends Data.TaggedError(
    "AuthenticationWorkCapacityError"
)<{
    readonly operation: AuthenticationWorkOperation;
}> {}

/** Expected rejection when one bounded authentication operation exceeds its deadline. */
export class AuthenticationWorkTimeoutError extends Data.TaggedError(
    "AuthenticationWorkTimeoutError"
)<{
    readonly operation: AuthenticationWorkOperation;
    readonly timeoutMs: number;
}> {}

/** Redacted expected rejection when an asynchronous authentication dependency fails. */
export class AuthenticationUpstreamUnavailableError extends Data.TaggedError(
    "AuthenticationUpstreamUnavailableError"
)<{
    readonly operation: AuthenticationWorkOperation;
}> {}

export type AuthenticationWorkError =
    | AuthenticationUpstreamUnavailableError
    | AuthenticationWorkCapacityError
    | AuthenticationWorkTimeoutError;

export type GatewayAuthenticationWorkFailure =
    | AuthenticationUpstreamUnavailableError
    | AuthenticationWorkTimeoutError;

export type GatewayAuthenticationWorkStartDecision<T> =
    | { readonly proceed: true }
    | { readonly proceed: false; readonly value: T };

export type AuthenticationWorkGateResult<T> =
    | { readonly accepted: false }
    | { readonly accepted: true; readonly value: T };

/** Promise-facing adapter backed by the process authentication Effect service. */
export interface AuthenticationWorkGate {
    run<T>(
        work: () => Promise<T>,
        signal?: AbortSignal
    ): Promise<AuthenticationWorkGateResult<T>>;
}

export interface GatewayAuthenticationWorkOptions<T = unknown> {
    /** Synchronous in-gate admission check run after the active permit is acquired. */
    readonly onBeforeStart?: () => GatewayAuthenticationWorkStartDecision<T>;
    /** Synchronous durable settlement that completes before another waiter starts. */
    readonly onFailureBeforeRelease?: (failure: GatewayAuthenticationWorkFailure) => void;
    /** Synchronous result settlement that completes before another waiter starts. */
    readonly onResultBeforeRelease?: (value: T) => void;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
}

export interface AuthenticationWorkRuntimeService {
    readonly passwordWorkGate: AuthenticationWorkGate;
    readonly totpWorkGate: AuthenticationWorkGate;
    runGatewayVerification<T>(
        work: (signal: AbortSignal) => Promise<T>,
        options: GatewayAuthenticationWorkOptions<T>
    ): Promise<T>;
}

export interface AuthenticationWorkLayerOptions {
    readonly gatewayMaximumConcurrent?: number;
    readonly gatewayMaximumQueued?: number;
    readonly passwordMaximumConcurrent?: number;
    readonly passwordMaximumQueued?: number;
    readonly totpMaximumConcurrent?: number;
    readonly totpMaximumQueued?: number;
}

interface NormalizedAuthenticationWorkLayerOptions {
    readonly gatewayMaximumConcurrent: number;
    readonly gatewayMaximumQueued: number;
    readonly passwordMaximumConcurrent: number;
    readonly passwordMaximumQueued: number;
    readonly totpMaximumConcurrent: number;
    readonly totpMaximumQueued: number;
}

interface BoundedAuthenticationGate {
    readonly admitted: Semaphore.Semaphore;
    readonly active: Semaphore.Semaphore;
    readonly operation: AuthenticationWorkOperation;
}

type GatewayTrackedWorkResult<T> =
    | { readonly kind: "skipped"; readonly value: T }
    | { readonly kind: "verified"; readonly value: T };

interface AuthenticationWorkServiceShape {
    readonly runGatewayVerification: <T>(
        work: (signal: AbortSignal) => Promise<T>,
        timeoutMs: number,
        onBeforeStart?: () => GatewayAuthenticationWorkStartDecision<T>,
        onFailureBeforeRelease?: (failure: GatewayAuthenticationWorkFailure) => void,
        onResultBeforeRelease?: (value: T) => void
    ) => Effect.Effect<T, AuthenticationWorkError>;
    readonly runPasswordWork: <T>(
        work: () => Promise<T>
    ) => Effect.Effect<T, AuthenticationWorkCapacityError>;
    readonly runTotpWork: <T>(
        work: () => Promise<T>
    ) => Effect.Effect<T, AuthenticationWorkCapacityError>;
}

/** Process-scoped Effect service for authentication admission and async work lifetime. */
export class AuthenticationWorkService extends Context.Service<
    AuthenticationWorkService,
    AuthenticationWorkServiceShape
>()("mira-dashboard/server/domains/security/AuthenticationWorkService") {}

const authenticationWorkDefaults: NormalizedAuthenticationWorkLayerOptions =
    Object.freeze({
        gatewayMaximumConcurrent: 2,
        gatewayMaximumQueued: 4,
        passwordMaximumConcurrent: 1,
        passwordMaximumQueued: 3,
        totpMaximumConcurrent: 2,
        totpMaximumQueued: 4,
    });

function boundedInteger(value: number, minimum: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new RangeError(`${label} is invalid`);
    }
    return value;
}

function normalizedLayerOptions(
    options: AuthenticationWorkLayerOptions
): NormalizedAuthenticationWorkLayerOptions {
    return Object.freeze({
        gatewayMaximumConcurrent: boundedInteger(
            options.gatewayMaximumConcurrent ??
                authenticationWorkDefaults.gatewayMaximumConcurrent,
            1,
            "Gateway authentication concurrency limit"
        ),
        gatewayMaximumQueued: boundedInteger(
            options.gatewayMaximumQueued ??
                authenticationWorkDefaults.gatewayMaximumQueued,
            0,
            "Gateway authentication queue limit"
        ),
        passwordMaximumConcurrent: boundedInteger(
            options.passwordMaximumConcurrent ??
                authenticationWorkDefaults.passwordMaximumConcurrent,
            1,
            "Password work concurrency limit"
        ),
        passwordMaximumQueued: boundedInteger(
            options.passwordMaximumQueued ??
                authenticationWorkDefaults.passwordMaximumQueued,
            0,
            "Password work queue limit"
        ),
        totpMaximumConcurrent: boundedInteger(
            options.totpMaximumConcurrent ??
                authenticationWorkDefaults.totpMaximumConcurrent,
            1,
            "TOTP work concurrency limit"
        ),
        totpMaximumQueued: boundedInteger(
            options.totpMaximumQueued ?? authenticationWorkDefaults.totpMaximumQueued,
            0,
            "TOTP work queue limit"
        ),
    });
}

function createGate(
    operation: AuthenticationWorkOperation,
    maximumConcurrent: number,
    maximumQueued: number
): Effect.Effect<BoundedAuthenticationGate> {
    return Effect.gen(function* () {
        const active = yield* Semaphore.make(maximumConcurrent);
        const admitted = yield* Semaphore.make(maximumConcurrent + maximumQueued);
        return Object.freeze({ active, admitted, operation });
    });
}

function abortController(controller: AbortController, reason: unknown): void {
    if (!controller.signal.aborted) controller.abort(reason);
}

function abortControllerEffect(
    controller: AbortController,
    message: string,
    name: "AbortError" | "TimeoutError"
): Effect.Effect<void> {
    const reason = new DOMException(message, name);
    return Effect.sync(() => abortController(controller, reason));
}

function abortSignalEffect(signal: AbortSignal): Effect.Effect<void> {
    return Effect.callback<void>((resume) => {
        if (signal.aborted) {
            resume(Effect.void);
            return;
        }
        const onAbort = (): void => resume(Effect.void);
        signal.addEventListener("abort", onAbort, { once: true });
        return Effect.sync(() => signal.removeEventListener("abort", onAbort));
    });
}

function trackedWork<T, E extends AuthenticationUpstreamUnavailableError>(
    gate: BoundedAuthenticationGate,
    fibers: FiberSet.FiberSet<unknown, AuthenticationUpstreamUnavailableError>,
    work: (signal: AbortSignal) => Effect.Effect<T, E>
): Effect.Effect<T, E | AuthenticationWorkCapacityError>;
function trackedWork<T, E extends AuthenticationUpstreamUnavailableError>(
    gate: BoundedAuthenticationGate,
    fibers: FiberSet.FiberSet<unknown, AuthenticationUpstreamUnavailableError>,
    work: (signal: AbortSignal) => Effect.Effect<T, E>,
    timeoutMs: number,
    onFailureBeforeRelease?: (failure: E | AuthenticationWorkTimeoutError) => void,
    onResultBeforeRelease?: (value: T) => void
): Effect.Effect<T, E | AuthenticationWorkCapacityError | AuthenticationWorkTimeoutError>;
function trackedWork<T, E extends AuthenticationUpstreamUnavailableError>(
    gate: BoundedAuthenticationGate,
    fibers: FiberSet.FiberSet<unknown, AuthenticationUpstreamUnavailableError>,
    work: (signal: AbortSignal) => Effect.Effect<T, E>,
    timeoutMs?: number,
    onFailureBeforeRelease?: (failure: E | AuthenticationWorkTimeoutError) => void,
    onResultBeforeRelease?: (value: T) => void
): Effect.Effect<
    T,
    E | AuthenticationWorkCapacityError | AuthenticationWorkTimeoutError
> {
    return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
            const accepted = yield* gate.admitted.takeIfAvailable(1);
            if (!accepted) {
                return yield* new AuthenticationWorkCapacityError({
                    operation: gate.operation,
                });
            }

            const controller = new AbortController();
            const workerState = { callerInterrupted: false, started: false };
            const failureState = { notified: false };
            const notifyFailureBeforeRelease = (
                failure: E | AuthenticationWorkTimeoutError
            ): Effect.Effect<void> =>
                Effect.sync(() => {
                    if (
                        workerState.callerInterrupted ||
                        failureState.notified ||
                        onFailureBeforeRelease === undefined
                    ) {
                        return;
                    }
                    failureState.notified = true;
                    onFailureBeforeRelease(failure);
                });
            const notifyResultBeforeRelease = (value: T): Effect.Effect<void> =>
                Effect.sync(() => {
                    if (
                        controller.signal.aborted ||
                        workerState.callerInterrupted ||
                        failureState.notified ||
                        onResultBeforeRelease === undefined
                    ) {
                        return;
                    }
                    onResultBeforeRelease(value);
                });
            const activePermit = gate.active.take(1).pipe(Effect.as(true as const));
            const abortedBeforeStart = abortSignalEffect(controller.signal).pipe(
                Effect.as(false as const)
            );
            const releaseActivePermit = gate.active.release(1);
            const releaseAdmission = gate.admitted.release(1);
            const runtimeStopping = abortControllerEffect(
                controller,
                "Authentication runtime is stopping",
                "AbortError"
            );
            const upstream = Effect.suspend(() =>
                controller.signal.aborted ? Effect.interrupt : work(controller.signal)
            ).pipe(
                Effect.tap(notifyResultBeforeRelease),
                Effect.tapError(notifyFailureBeforeRelease),
                Effect.onInterrupt(() => runtimeStopping)
            );
            const worker = Effect.uninterruptibleMask((restoreWorker) =>
                restoreWorker(Effect.raceFirst(activePermit, abortedBeforeStart)).pipe(
                    Effect.flatMap((acquired) =>
                        acquired
                            ? Effect.sync(() => {
                                  workerState.started = true;
                              }).pipe(
                                  Effect.andThen(restoreWorker(upstream)),
                                  Effect.ensuring(releaseActivePermit)
                              )
                            : Effect.interrupt
                    )
                )
            ).pipe(Effect.ensuring(releaseAdmission));
            const fiber = yield* FiberSet.run(fibers, worker, {
                propagateInterruption: false,
                startImmediately: true,
            });
            let joined: Effect.Effect<T, E | AuthenticationWorkTimeoutError> =
                Fiber.join(fiber);
            if (timeoutMs !== undefined) {
                const timeoutFailure = new AuthenticationWorkTimeoutError({
                    operation: gate.operation,
                    timeoutMs,
                });
                const abortForTimeout = abortControllerEffect(
                    controller,
                    "Gateway credential verification timed out",
                    "TimeoutError"
                );
                const awaitQueuedWorker = Effect.suspend(() => {
                    if (workerState.started) return Effect.void;
                    const awaitExit = Fiber.await(fiber);
                    return awaitExit.pipe(Effect.asVoid);
                });
                const timeoutFallback = abortForTimeout.pipe(
                    Effect.andThen(notifyFailureBeforeRelease(timeoutFailure)),
                    Effect.andThen(awaitQueuedWorker),
                    Effect.andThen(Effect.fail(timeoutFailure))
                );
                joined = joined.pipe(
                    Effect.timeoutOrElse({
                        duration: timeoutMs,
                        orElse: () => timeoutFallback,
                    })
                );
            }
            const requestAbortReason = new DOMException(
                "Authentication request aborted",
                "AbortError"
            );
            const abortForRequest = Effect.sync(() => {
                workerState.callerInterrupted = true;
                abortController(controller, requestAbortReason);
            });
            return yield* restore(joined).pipe(
                Effect.onInterrupt(() =>
                    abortForRequest.pipe(
                        Effect.andThen(
                            workerState.started
                                ? Effect.void
                                : Fiber.await(fiber).pipe(Effect.asVoid)
                        )
                    )
                )
            );
        })
    );
}

/**
 * Creates the process-scoped authentication work layer.
 * Timed-out or cancelled callers stop waiting immediately, while a non-cooperative
 * Promise keeps its permit until settlement so abandoned work cannot accumulate.
 * @param options Optional limits for each bounded authentication operation.
 * @returns A scoped authentication service layer for the process runtime.
 */
export function authenticationWorkLayer(
    options: AuthenticationWorkLayerOptions = {}
): Layer.Layer<AuthenticationWorkService> {
    const normalized = normalizedLayerOptions(options);
    return Layer.effect(
        AuthenticationWorkService,
        Effect.gen(function* () {
            const fibers = yield* FiberSet.make<
                unknown,
                AuthenticationUpstreamUnavailableError
            >();
            const gateway = yield* createGate(
                "gateway",
                normalized.gatewayMaximumConcurrent,
                normalized.gatewayMaximumQueued
            );
            const password = yield* createGate(
                "password",
                normalized.passwordMaximumConcurrent,
                normalized.passwordMaximumQueued
            );
            const totp = yield* createGate(
                "totp",
                normalized.totpMaximumConcurrent,
                normalized.totpMaximumQueued
            );
            const runGatewayVerification = <T>(
                work: (signal: AbortSignal) => Promise<T>,
                timeoutMs: number,
                onBeforeStart?: () => GatewayAuthenticationWorkStartDecision<T>,
                onFailureBeforeRelease?: (
                    failure: GatewayAuthenticationWorkFailure
                ) => void,
                onResultBeforeRelease?: (value: T) => void
            ): Effect.Effect<T, AuthenticationWorkError> => {
                const operation = (
                    signal: AbortSignal
                ): Effect.Effect<
                    GatewayTrackedWorkResult<T>,
                    AuthenticationUpstreamUnavailableError
                > =>
                    Effect.suspend(
                        (): Effect.Effect<
                            GatewayTrackedWorkResult<T>,
                            AuthenticationUpstreamUnavailableError
                        > => {
                            const decision = onBeforeStart?.() ?? {
                                proceed: true as const,
                            };
                            if (!decision.proceed) {
                                return Effect.succeed({
                                    kind: "skipped" as const,
                                    value: decision.value,
                                } satisfies GatewayTrackedWorkResult<T>);
                            }
                            return Effect.tryPromise({
                                catch: () =>
                                    new AuthenticationUpstreamUnavailableError({
                                        operation: "gateway",
                                    }),
                                try: () => work(signal),
                            }).pipe(
                                Effect.map((value) => ({
                                    kind: "verified" as const,
                                    value,
                                }))
                            );
                        }
                    );
                return trackedWork(
                    gateway,
                    fibers,
                    operation,
                    timeoutMs,
                    onFailureBeforeRelease,
                    (result) => {
                        if (result.kind === "verified") {
                            onResultBeforeRelease?.(result.value);
                        }
                    }
                ).pipe(Effect.map(({ value }) => value));
            };
            return AuthenticationWorkService.of({
                runGatewayVerification,
                runPasswordWork: (work) =>
                    trackedWork(password, fibers, () => Effect.promise(() => work())),
                runTotpWork: (work) =>
                    trackedWork(totp, fibers, () => Effect.promise(() => work())),
            });
        })
    );
}
