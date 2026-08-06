import { Context, Data, Effect, Exit, Fiber, FiberSet, Layer, Semaphore } from "effect";

export type AuthenticationWorkOperation = "gateway" | "password" | "totp" | "webauthn";
type AuthenticationVerificationOperation = Extract<
    AuthenticationWorkOperation,
    "gateway" | "webauthn"
>;

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

/** Expected wrapper when durable verification settlement cannot complete. */
export class AuthenticationWorkSettlementError extends Data.TaggedError(
    "AuthenticationWorkSettlementError"
)<{
    readonly cause: unknown;
    readonly operation: AuthenticationWorkOperation;
}> {}

export type AuthenticationWorkError =
    | AuthenticationUpstreamUnavailableError
    | AuthenticationWorkCapacityError
    | AuthenticationWorkSettlementError
    | AuthenticationWorkTimeoutError;

export type AuthenticationVerificationWorkFailure =
    | AuthenticationUpstreamUnavailableError
    | AuthenticationWorkTimeoutError;

export type AuthenticationVerificationWorkStartDecision<T> =
    | { readonly proceed: true }
    | { readonly proceed: false; readonly value: T };

/** Gateway-facing name for the shared bounded-verification failure. */
export type GatewayAuthenticationWorkFailure = AuthenticationVerificationWorkFailure;

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

export interface AuthenticationVerificationWorkOptions<T = unknown> {
    /** Synchronous in-gate admission check run after the active permit is acquired. */
    readonly onBeforeStart?: () => AuthenticationVerificationWorkStartDecision<T>;
    /** Durable settlement for active work whose caller stopped waiting. */
    readonly onCancellationBeforeRelease?: () => Promise<void> | void;
    /** Durable settlement that completes before another waiter starts. */
    readonly onFailureBeforeRelease?: (
        failure: AuthenticationVerificationWorkFailure
    ) => Promise<void> | void;
    /** Result settlement that completes before another waiter starts. */
    readonly onResultBeforeRelease?: (value: T) => Promise<void> | void;
    readonly signal?: AbortSignal;
    readonly timeoutMs: number;
}

/** Gateway-facing name for shared bounded-verification options. */
export type GatewayAuthenticationWorkOptions<T = unknown> =
    AuthenticationVerificationWorkOptions<T>;

export interface AuthenticationWorkRuntimeService {
    readonly passwordWorkGate: AuthenticationWorkGate;
    readonly totpWorkGate: AuthenticationWorkGate;
    runGatewayVerification<T>(
        work: (signal: AbortSignal) => Promise<T>,
        options: AuthenticationVerificationWorkOptions<T>
    ): Promise<T>;
    runWebAuthnVerification<T>(
        work: (signal: AbortSignal) => Promise<T>,
        options: AuthenticationVerificationWorkOptions<T>
    ): Promise<T>;
}

export interface AuthenticationWorkLayerOptions {
    readonly gatewayMaximumConcurrent?: number;
    readonly gatewayMaximumQueued?: number;
    readonly passwordMaximumConcurrent?: number;
    readonly passwordMaximumQueued?: number;
    readonly totpMaximumConcurrent?: number;
    readonly totpMaximumQueued?: number;
    readonly webAuthnMaximumConcurrent?: number;
    readonly webAuthnMaximumQueued?: number;
}

interface NormalizedAuthenticationWorkLayerOptions {
    readonly gatewayMaximumConcurrent: number;
    readonly gatewayMaximumQueued: number;
    readonly passwordMaximumConcurrent: number;
    readonly passwordMaximumQueued: number;
    readonly totpMaximumConcurrent: number;
    readonly totpMaximumQueued: number;
    readonly webAuthnMaximumConcurrent: number;
    readonly webAuthnMaximumQueued: number;
}

interface BoundedAuthenticationGate<
    TOperation extends AuthenticationWorkOperation = AuthenticationWorkOperation,
> {
    readonly admitted: Semaphore.Semaphore;
    readonly active: Semaphore.Semaphore;
    readonly operation: TOperation;
}

type VerificationTrackedWorkResult<T> =
    | { readonly kind: "skipped"; readonly value: T }
    | { readonly kind: "verified"; readonly value: T };

type AuthenticationVerificationEffectRunner = <T>(
    work: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    onBeforeStart?: () => AuthenticationVerificationWorkStartDecision<T>,
    onCancellationBeforeRelease?: () => Promise<void> | void,
    onFailureBeforeRelease?: (
        failure: AuthenticationVerificationWorkFailure
    ) => Promise<void> | void,
    onResultBeforeRelease?: (value: T) => Promise<void> | void
) => Effect.Effect<T, AuthenticationWorkError>;

interface AuthenticationWorkServiceShape {
    readonly runGatewayVerification: AuthenticationVerificationEffectRunner;
    readonly runPasswordWork: <T>(
        work: () => Promise<T>
    ) => Effect.Effect<T, AuthenticationWorkCapacityError>;
    readonly runTotpWork: <T>(
        work: () => Promise<T>
    ) => Effect.Effect<T, AuthenticationWorkCapacityError>;
    readonly runWebAuthnVerification: AuthenticationVerificationEffectRunner;
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
        webAuthnMaximumConcurrent: 2,
        webAuthnMaximumQueued: 4,
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
        webAuthnMaximumConcurrent: boundedInteger(
            options.webAuthnMaximumConcurrent ??
                authenticationWorkDefaults.webAuthnMaximumConcurrent,
            1,
            "WebAuthn verification concurrency limit"
        ),
        webAuthnMaximumQueued: boundedInteger(
            options.webAuthnMaximumQueued ??
                authenticationWorkDefaults.webAuthnMaximumQueued,
            0,
            "WebAuthn verification queue limit"
        ),
    });
}

function createGate<TOperation extends AuthenticationWorkOperation>(
    operation: TOperation,
    maximumConcurrent: number,
    maximumQueued: number
): Effect.Effect<BoundedAuthenticationGate<TOperation>> {
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
    fibers: FiberSet.FiberSet<unknown, AuthenticationWorkError>,
    work: (signal: AbortSignal) => Effect.Effect<T, E>
): Effect.Effect<T, E | AuthenticationWorkCapacityError>;
function trackedWork<T, E extends AuthenticationUpstreamUnavailableError>(
    gate: BoundedAuthenticationGate,
    fibers: FiberSet.FiberSet<unknown, AuthenticationWorkError>,
    work: (signal: AbortSignal) => Effect.Effect<T, E>,
    timeoutMs: number,
    onCancellationBeforeRelease?: () => Promise<void> | void,
    onFailureBeforeRelease?: (
        failure: E | AuthenticationWorkTimeoutError
    ) => Promise<void> | void,
    onResultBeforeRelease?: (value: T) => Promise<void> | void
): Effect.Effect<T, AuthenticationWorkError | E>;
function trackedWork<T, E extends AuthenticationUpstreamUnavailableError>(
    gate: BoundedAuthenticationGate,
    fibers: FiberSet.FiberSet<unknown, AuthenticationWorkError>,
    work: (signal: AbortSignal) => Effect.Effect<T, E>,
    timeoutMs?: number,
    onCancellationBeforeRelease?: () => Promise<void> | void,
    onFailureBeforeRelease?: (
        failure: E | AuthenticationWorkTimeoutError
    ) => Promise<void> | void,
    onResultBeforeRelease?: (value: T) => Promise<void> | void
): Effect.Effect<T, AuthenticationWorkError | E> {
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
            const upstreamCompleted = Promise.withResolvers<void>();
            type SettlementClaim = Readonly<{
                promise: Promise<void>;
                source: "cancellation" | "failure" | "result" | "timeout";
            }>;
            const settlementState: { claim?: SettlementClaim } = {};
            const beginSettlement = (
                source: SettlementClaim["source"],
                settlement?: () => Promise<void> | void
            ): Readonly<{ claim: SettlementClaim; owned: boolean }> => {
                const existing = settlementState.claim;
                if (existing !== undefined) {
                    return { claim: existing, owned: false };
                }
                const claim = Object.freeze({
                    promise: Promise.resolve().then(() => settlement?.()),
                    source,
                });
                settlementState.claim = claim;
                return { claim, owned: true };
            };
            const awaitSettlement = (
                claim: SettlementClaim
            ): Effect.Effect<void, AuthenticationWorkSettlementError> =>
                Effect.tryPromise({
                    catch: (cause) =>
                        new AuthenticationWorkSettlementError({
                            cause,
                            operation: gate.operation,
                        }),
                    try: () => claim.promise,
                });
            const notifyCancellationBeforeRelease = (): Effect.Effect<void> =>
                Effect.suspend(() => {
                    if (!workerState.started || !workerState.callerInterrupted) {
                        return Effect.void;
                    }
                    const { claim } = beginSettlement(
                        "cancellation",
                        onCancellationBeforeRelease
                    );
                    return awaitSettlement(claim).pipe(Effect.orDie);
                });
            const notifyFailureBeforeRelease = (
                failure: E | AuthenticationWorkTimeoutError
            ): Effect.Effect<void, AuthenticationWorkSettlementError> =>
                Effect.suspend(() => {
                    if (workerState.callerInterrupted) {
                        return Effect.void;
                    }
                    const { claim } = beginSettlement("failure", () =>
                        onFailureBeforeRelease?.(failure)
                    );
                    upstreamCompleted.resolve();
                    return Effect.uninterruptible(awaitSettlement(claim));
                });
            const notifyResultBeforeRelease = (
                value: T
            ): Effect.Effect<void, AuthenticationWorkSettlementError> =>
                Effect.suspend(() => {
                    if (workerState.callerInterrupted) {
                        return Effect.void;
                    }
                    const { claim } = beginSettlement("result", () =>
                        onResultBeforeRelease?.(value)
                    );
                    upstreamCompleted.resolve();
                    return Effect.uninterruptible(awaitSettlement(claim));
                });
            const activePermit = gate.active.take(1).pipe(Effect.as(true as const));
            const abortedBeforeStart = abortSignalEffect(controller.signal).pipe(
                Effect.as(false as const)
            );
            const releaseActivePermit = gate.active.release(1);
            const releaseAdmission = gate.admitted.release(1);
            const awaitClaimBeforeRelease = Effect.suspend(() => {
                const claim = settlementState.claim;
                return claim === undefined
                    ? Effect.void
                    : awaitSettlement(claim).pipe(Effect.ignore);
            });
            const releaseWorkerPermits = awaitClaimBeforeRelease.pipe(
                Effect.andThen(releaseAdmission)
            );
            const runtimeStopping = abortControllerEffect(
                controller,
                "Authentication runtime is stopping",
                "AbortError"
            );
            const upstream = Effect.suspend(() =>
                controller.signal.aborted ? Effect.interrupt : work(controller.signal)
            ).pipe(
                Effect.tapError(notifyFailureBeforeRelease),
                Effect.tap(notifyResultBeforeRelease),
                Effect.onInterrupt(() => runtimeStopping),
                Effect.ensuring(notifyCancellationBeforeRelease())
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
            ).pipe(Effect.ensuring(releaseWorkerPermits));
            const fiber = yield* FiberSet.run(fibers, worker, {
                propagateInterruption: false,
                startImmediately: true,
            });
            const joined: Effect.Effect<
                T,
                AuthenticationWorkSettlementError | AuthenticationWorkTimeoutError | E
            > = Fiber.join(fiber);
            let callerWait = joined;
            if (timeoutMs !== undefined) {
                const timeoutFailure = new AuthenticationWorkTimeoutError({
                    operation: gate.operation,
                    timeoutMs,
                });
                const abortForTimeout = abortControllerEffect(
                    controller,
                    "Authentication verification timed out",
                    "TimeoutError"
                );
                const awaitQueuedWorker = Effect.suspend(() => {
                    if (workerState.started) return Effect.void;
                    const awaitExit = Fiber.await(fiber);
                    return awaitExit.pipe(Effect.asVoid);
                });
                const timeoutFallback = Effect.sync(() =>
                    beginSettlement("timeout", () =>
                        onFailureBeforeRelease?.(timeoutFailure)
                    )
                ).pipe(
                    Effect.flatMap(({ claim, owned }) =>
                        owned
                            ? abortForTimeout.pipe(
                                  Effect.andThen(awaitSettlement(claim)),
                                  Effect.andThen(awaitQueuedWorker),
                                  Effect.andThen(Effect.fail(timeoutFailure))
                              )
                            : Effect.promise(() => upstreamCompleted.promise)
                    )
                );
                const continueUnlessTimeoutOwnsSettlement = Effect.suspend(() =>
                    settlementState.claim?.source === "timeout"
                        ? Effect.never
                        : Effect.void
                );
                const awaitUpstreamMilestone = Effect.promise(
                    () => upstreamCompleted.promise
                ).pipe(Effect.andThen(continueUnlessTimeoutOwnsSettlement));
                const awaitWorkerOutcome = Fiber.await(fiber).pipe(
                    Effect.flatMap((exit) =>
                        Effect.suspend(() => {
                            if (settlementState.claim?.source === "timeout") {
                                return Effect.never;
                            }
                            return Exit.isSuccess(exit)
                                ? Effect.void
                                : Effect.failCause(exit.cause);
                        })
                    )
                );
                const awaitUpstream = Effect.raceFirst(
                    awaitUpstreamMilestone,
                    awaitWorkerOutcome
                ).pipe(
                    Effect.timeoutOrElse({
                        duration: timeoutMs,
                        orElse: () => timeoutFallback,
                    })
                );
                callerWait = awaitUpstream.pipe(Effect.andThen(joined));
            }
            const requestAbortReason = new DOMException(
                "Authentication request aborted",
                "AbortError"
            );
            const abortForRequest = Effect.sync(() => {
                workerState.callerInterrupted = true;
                abortController(controller, requestAbortReason);
            });
            return yield* restore(callerWait).pipe(
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

function verificationWork<T>(
    gate: BoundedAuthenticationGate<AuthenticationVerificationOperation>,
    fibers: FiberSet.FiberSet<unknown, AuthenticationWorkError>,
    work: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    onBeforeStart?: () => AuthenticationVerificationWorkStartDecision<T>,
    onCancellationBeforeRelease?: () => Promise<void> | void,
    onFailureBeforeRelease?: (
        failure: AuthenticationVerificationWorkFailure
    ) => Promise<void> | void,
    onResultBeforeRelease?: (value: T) => Promise<void> | void
): Effect.Effect<T, AuthenticationWorkError> {
    const operation = (
        signal: AbortSignal
    ): Effect.Effect<
        VerificationTrackedWorkResult<T>,
        AuthenticationUpstreamUnavailableError
    > =>
        Effect.suspend(
            (): Effect.Effect<
                VerificationTrackedWorkResult<T>,
                AuthenticationUpstreamUnavailableError
            > => {
                const decision = onBeforeStart?.() ?? {
                    proceed: true as const,
                };
                if (!decision.proceed) {
                    return Effect.succeed({
                        kind: "skipped" as const,
                        value: decision.value,
                    } satisfies VerificationTrackedWorkResult<T>);
                }
                return Effect.tryPromise({
                    catch: () =>
                        new AuthenticationUpstreamUnavailableError({
                            operation: gate.operation,
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
        gate,
        fibers,
        operation,
        timeoutMs,
        onCancellationBeforeRelease,
        onFailureBeforeRelease,
        (result) => {
            if (result.kind === "verified") {
                return onResultBeforeRelease?.(result.value);
            }
        }
    ).pipe(Effect.map(({ value }) => value));
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
            const fibers = yield* FiberSet.make<unknown, AuthenticationWorkError>();
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
            const webAuthn = yield* createGate(
                "webauthn",
                normalized.webAuthnMaximumConcurrent,
                normalized.webAuthnMaximumQueued
            );
            return AuthenticationWorkService.of({
                runGatewayVerification: (work, ...options) =>
                    verificationWork(gateway, fibers, work, ...options),
                runPasswordWork: (work) =>
                    trackedWork(password, fibers, () => Effect.promise(() => work())),
                runTotpWork: (work) =>
                    trackedWork(totp, fibers, () => Effect.promise(() => work())),
                runWebAuthnVerification: (work, ...options) =>
                    verificationWork(webAuthn, fibers, work, ...options),
            });
        })
    );
}
