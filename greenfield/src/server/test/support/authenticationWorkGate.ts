import {
    type AuthenticationWorkGate,
    type AuthenticationWorkRuntimeService,
    AuthenticationUpstreamUnavailableError,
    AuthenticationWorkCapacityError,
    AuthenticationWorkTimeoutError,
    type GatewayAuthenticationWorkOptions,
} from "../../domains/security/authenticationWorkGate.ts";

interface TestAuthenticationWorkWaiter {
    readonly reject: (reason?: unknown) => void;
    readonly resolve: () => void;
    readonly signal?: AbortSignal;
    readonly signalListener?: () => void;
}

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Authentication work aborted", "AbortError");
}

/**
 * Creates a serial or bounded Promise gate for focused domain tests.
 * @param maximumConcurrent Maximum work items allowed to execute concurrently.
 * @param maximumQueued Maximum work items allowed to wait for admission.
 * @returns Test-only authentication work gate.
 */
export function createTestAuthenticationWorkGate(
    maximumConcurrent = 1,
    maximumQueued = 16
): AuthenticationWorkGate {
    let active = 0;
    const waiters: TestAuthenticationWorkWaiter[] = [];

    const acquire = (signal?: AbortSignal): Promise<boolean> => {
        if (signal?.aborted === true) return Promise.reject(abortReason(signal));
        if (active < maximumConcurrent) {
            active += 1;
            return Promise.resolve(true);
        }
        if (waiters.length >= maximumQueued) return Promise.resolve(false);
        return new Promise<boolean>((resolve, reject) => {
            const waiter: TestAuthenticationWorkWaiter = {
                reject,
                resolve: () => resolve(true),
                ...(signal !== undefined && { signal }),
                ...(signal !== undefined && {
                    signalListener: () => {
                        const index = waiters.indexOf(waiter);
                        if (index === -1) return;
                        waiters.splice(index, 1);
                        reject(abortReason(signal));
                    },
                }),
            };
            waiter.signal?.addEventListener("abort", waiter.signalListener!, {
                once: true,
            });
            waiters.push(waiter);
        });
    };

    const release = (): void => {
        const waiter = waiters.shift();
        if (waiter === undefined) {
            active -= 1;
            return;
        }
        if (waiter.signal !== undefined && waiter.signalListener !== undefined) {
            waiter.signal.removeEventListener("abort", waiter.signalListener);
        }
        waiter.resolve();
    };

    return Object.freeze({
        async run<T>(work: () => Promise<T>, signal?: AbortSignal) {
            if (!(await acquire(signal))) return { accepted: false as const };
            try {
                signal?.throwIfAborted();
                return { accepted: true as const, value: await work() };
            } finally {
                release();
            }
        },
    });
}

/**
 * Creates a deadline/capacity runner for domain tests; production uses ApplicationRuntime.
 * @param maximumConcurrent Maximum unsettled Gateway verifications.
 * @returns Test-only Gateway authentication runtime facade.
 */
export function createTestGatewayWorkRuntime(
    maximumConcurrent = 2
): Pick<AuthenticationWorkRuntimeService, "runGatewayVerification"> {
    const unsettled = new Set<Promise<unknown>>();
    return Object.freeze({
        async runGatewayVerification<T>(
            work: (signal: AbortSignal) => Promise<T>,
            options: GatewayAuthenticationWorkOptions<T>
        ): Promise<T> {
            options.signal?.throwIfAborted();
            if (unsettled.size >= maximumConcurrent) {
                throw new AuthenticationWorkCapacityError({ operation: "gateway" });
            }
            const decision = options.onBeforeStart?.() ?? {
                proceed: true as const,
            };
            if (!decision.proceed) return decision.value;
            const controller = new AbortController();
            const forwardAbort = (): void => controller.abort(options.signal?.reason);
            options.signal?.addEventListener("abort", forwardAbort, { once: true });
            const timeoutOutcome = Promise.withResolvers<"timed-out">();
            const timeout = setTimeout(() => {
                controller.abort(
                    new DOMException(
                        "Gateway credential verification timed out",
                        "TimeoutError"
                    )
                );
                timeoutOutcome.resolve("timed-out");
            }, options.timeoutMs);
            const verification = Promise.resolve().then(() => work(controller.signal));
            let releaseAllowed = false;
            let verificationSettled = false;
            unsettled.add(verification);
            void verification.then(
                () => {
                    verificationSettled = true;
                    if (releaseAllowed) unsettled.delete(verification);
                    return verificationSettled;
                },
                () => {
                    verificationSettled = true;
                    if (releaseAllowed) unsettled.delete(verification);
                    return verificationSettled;
                }
            );
            try {
                const outcome = await Promise.race([
                    verification.then(
                        (value) => ({ kind: "value" as const, value }),
                        () => ({ kind: "unavailable" as const })
                    ),
                    timeoutOutcome.promise.then(() => ({ kind: "timeout" as const })),
                ]);
                options.signal?.throwIfAborted();
                if (outcome.kind === "timeout") {
                    const failure = new AuthenticationWorkTimeoutError({
                        operation: "gateway",
                        timeoutMs: options.timeoutMs,
                    });
                    options.onFailureBeforeRelease?.(failure);
                    throw failure;
                }
                if (outcome.kind === "unavailable") {
                    const failure = new AuthenticationUpstreamUnavailableError({
                        operation: "gateway",
                    });
                    options.onFailureBeforeRelease?.(failure);
                    throw failure;
                }
                options.onResultBeforeRelease?.(outcome.value);
                return outcome.value;
            } finally {
                releaseAllowed = true;
                if (verificationSettled) unsettled.delete(verification);
                clearTimeout(timeout);
                options.signal?.removeEventListener("abort", forwardAbort);
            }
        },
    });
}
