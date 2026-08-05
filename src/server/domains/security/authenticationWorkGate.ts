export type AuthenticationWorkGateResult<T> =
    | { readonly accepted: false }
    | { readonly accepted: true; readonly value: T };

export interface AuthenticationWorkGate {
    run<T>(
        work: () => Promise<T>,
        signal?: AbortSignal
    ): Promise<AuthenticationWorkGateResult<T>>;
}

interface AuthenticationWorkWaiter {
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
 * Bounds expensive authentication work and rejects overflow without creating
 * an unbounded promise queue. Queued work re-enters serially after prior state
 * changes are durable.
 * @param maximumConcurrent Maximum work items allowed to run at once.
 * @param maximumQueued Maximum work items allowed to wait for admission.
 * @returns A bounded authentication work gate.
 */
export function createAuthenticationWorkGate(
    maximumConcurrent: number,
    maximumQueued: number
): AuthenticationWorkGate {
    if (!Number.isSafeInteger(maximumConcurrent) || maximumConcurrent < 1) {
        throw new RangeError("Authentication concurrency limit is invalid");
    }
    if (!Number.isSafeInteger(maximumQueued) || maximumQueued < 0) {
        throw new RangeError("Authentication queue limit is invalid");
    }

    let active = 0;
    const waiters: AuthenticationWorkWaiter[] = [];

    const acquire = (signal?: AbortSignal): Promise<boolean> => {
        if (signal?.aborted) return Promise.reject(abortReason(signal));
        if (active < maximumConcurrent) {
            active += 1;
            return Promise.resolve(true);
        }
        if (waiters.length >= maximumQueued) return Promise.resolve(false);

        return new Promise<boolean>((resolve, reject) => {
            const waiter: AuthenticationWorkWaiter = {
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
            if (waiter.signal !== undefined && waiter.signalListener !== undefined) {
                waiter.signal.addEventListener("abort", waiter.signalListener, {
                    once: true,
                });
            }
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
        async run<T>(
            work: () => Promise<T>,
            signal?: AbortSignal
        ): Promise<AuthenticationWorkGateResult<T>> {
            if (!(await acquire(signal))) return { accepted: false };
            try {
                if (signal?.aborted) throw abortReason(signal);
                return { accepted: true, value: await work() };
            } finally {
                release();
            }
        },
    });
}
