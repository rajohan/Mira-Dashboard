import type { QueryClient } from "@tanstack/react-query";

/** Session-bound operation metadata associated with an exact transport signal. */
export interface AuthenticatedOperationToken {
    readonly cacheGeneration: number;
    readonly completion: Promise<void>;
    readonly identity: string | undefined;
    readonly queryClient: QueryClient;
}

interface AuthenticatedOperationRegistration {
    readonly cacheGeneration: number;
    readonly identity: string | undefined;
    readonly queryClient: QueryClient;
    readonly signal: AbortSignal;
}

const authenticatedOperationBySignal = new WeakMap<
    AbortSignal,
    AuthenticatedOperationToken
>();

/**
 * @param signal Exact transport cancellation signal.
 * @returns The authenticated operation associated with the signal, if any.
 */
export function authenticatedOperationForSignal(
    signal: AbortSignal | undefined
): AuthenticatedOperationToken | undefined {
    return signal === undefined ? undefined : authenticatedOperationBySignal.get(signal);
}

/**
 * Registers one operation for its complete authenticated mutation-boundary lifetime.
 * @returns Idempotent completion cleanup for the exact registration.
 */
export function registerAuthenticatedOperation({
    cacheGeneration,
    identity,
    queryClient,
    signal,
}: AuthenticatedOperationRegistration): () => void {
    const completion = Promise.withResolvers<void>();
    const token: AuthenticatedOperationToken = Object.freeze({
        cacheGeneration,
        completion: completion.promise,
        identity,
        queryClient,
    });
    authenticatedOperationBySignal.set(signal, token);
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        if (authenticatedOperationBySignal.get(signal) === token) {
            authenticatedOperationBySignal.delete(signal);
        }
        completion.resolve();
    };
}

/**
 * Combines cancellation signals while preserving the primary authenticated operation.
 * Use this instead of `AbortSignal.any()` when the primary signal came from
 * `useAuthenticatedMutationBoundary()`.
 * @param primarySignal Signal registered by the authenticated mutation boundary.
 * @param additionalSignals Other operation-specific cancellation signals.
 * @returns One combined signal carrying the primary operation association.
 */
export function authenticatedAbortSignal(
    primarySignal: AbortSignal,
    additionalSignals: readonly AbortSignal[]
): AbortSignal {
    if (additionalSignals.length === 0) return primarySignal;
    const combinedSignal = AbortSignal.any([primarySignal, ...additionalSignals]);
    const operation = authenticatedOperationBySignal.get(primarySignal);
    if (operation !== undefined) {
        authenticatedOperationBySignal.set(combinedSignal, operation);
    }
    return combinedSignal;
}
