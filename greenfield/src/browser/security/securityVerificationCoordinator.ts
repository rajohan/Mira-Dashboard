import type { ContractAuthenticationErrorReason } from "../../contracts/registry.ts";
import {
    authenticatedOperationForSignal,
    type AuthenticatedOperationToken,
} from "../auth/authenticatedOperationRegistry.ts";

const securityVerificationTimeoutMs = 10 * 60 * 1000;

export type SecurityVerificationPhase =
    | "cache-reset"
    | "idle"
    | "prompting"
    | "reconciling"
    | "replaying"
    | "verifying";

/** Immutable external-store state for the one global verification presenter. */
export interface SecurityVerificationSnapshot {
    readonly authenticationIdentity: string | undefined;
    readonly generation: number;
    readonly identity: string | undefined;
    readonly pendingInteractionCount: number;
    readonly pendingRequestCount: number;
    readonly phase: SecurityVerificationPhase;
    readonly presenterClaimed: boolean;
    readonly protectedInteraction: boolean;
    readonly reason: ContractAuthenticationErrorReason | undefined;
}

export interface SecurityVerificationRequestOptions {
    readonly identity?: string;
    readonly signal?: AbortSignal;
}

/** Exact transport waiter retained through its one allowed replay attempt. */
export interface SecurityVerificationWaiterLease {
    readonly outcome: Promise<"cancelled" | "verified">;
    releaseAfterAttempt(): void;
}

interface VerificationWaiter {
    readonly generation: number;
    readonly id: symbol;
    readonly kind: "interaction" | "request";
    readonly operation: AuthenticatedOperationToken | undefined;
    readonly outcome: PromiseWithResolvers<"cancelled" | "verified">;
    released: boolean;
    settled: boolean;
}

type SecurityVerificationFlowCompletion = "cancelled" | "completed";

/** Fixed cancellation raised when a verification presenter dismisses a blocked action. */
export class SecurityVerificationCancelledError extends Error {
    constructor() {
        super("Security verification was cancelled");
        this.name = "SecurityVerificationCancelledError";
    }
}

/**
 * Coordinates security prompts without retaining request payloads or action callbacks.
 * One instance belongs to one browser application composition root.
 */
export class SecurityVerificationCoordinator {
    readonly #getAuthenticationIdentity: () => string | undefined;
    readonly #listeners = new Set<() => void>();
    readonly #pendingOperationCompletions = new Set<Promise<void>>();
    readonly #waiters = new Map<symbol, VerificationWaiter>();
    #authenticationIdentity: string | undefined;
    #cacheResetIdentity: string | undefined;
    #flowCompletion: PromiseWithResolvers<SecurityVerificationFlowCompletion> | undefined;
    #generation = 0;
    #identity: string | undefined;
    #phase: SecurityVerificationPhase = "idle";
    #presenterClaimed = false;
    #protectedInteraction = false;
    #reason: ContractAuthenticationErrorReason | undefined;
    #replayWake: PromiseWithResolvers<void> | undefined;
    #snapshot: SecurityVerificationSnapshot;
    #timeout: ReturnType<typeof setTimeout> | undefined;

    constructor(getAuthenticationIdentity: () => string | undefined) {
        this.#getAuthenticationIdentity = getAuthenticationIdentity;
        this.#authenticationIdentity = this.#resolveAuthenticationIdentity();
        this.#snapshot = this.#createSnapshot();
    }

    /** @returns Stable state for `useSyncExternalStore`. */
    getSnapshot = (): SecurityVerificationSnapshot => this.#snapshot;

    /**
     * @param listener External-store change listener.
     * @returns Cleanup for the exact listener.
     */
    subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    };

    /**
     * Claims the one global prompt presenter.
     * @returns Its idempotent release, or undefined when another presenter owns it.
     */
    acquirePresenter(): (() => void) | undefined {
        if (this.#presenterClaimed) return undefined;
        this.#presenterClaimed = true;
        this.#publishSnapshot();
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            this.#presenterClaimed = false;
            if (this.#phase !== "idle") {
                this.#cancelFlow();
                return;
            }
            this.#publishSnapshot();
        };
    }

    /**
     * Publishes the auth identity currently owned by the cache boundary.
     * An unexpected change cancels any flow that has not entered its planned reset.
     * @param identity Current stable auth cache identity.
     */
    setAuthenticationIdentity(identity: string | undefined): void {
        if (identity === this.#authenticationIdentity) return;
        if (
            this.#phase !== "idle" &&
            !(this.#phase === "cache-reset" && identity === this.#cacheResetIdentity)
        ) {
            this.#cancelFlow();
        }
        this.#authenticationIdentity = identity;
        this.#publishSnapshot();
    }

    /**
     * Requests verification for one contract-rejected transport operation.
     * @param reason Exact contract-declared authentication reason.
     * @param options Optional identity and transport cancellation binding.
     * @returns A replay lease, or undefined when no exact auth identity can be bound.
     */
    request(
        reason: ContractAuthenticationErrorReason,
        { identity, signal }: SecurityVerificationRequestOptions = {}
    ): SecurityVerificationWaiterLease | undefined {
        return this.#requestWaiter(reason, "request", { identity, signal });
    }

    /**
     * Requests proof before a multi-step protected interaction starts. The caller
     * keeps the returned lease until that interaction finishes, so a proof-driven
     * session rotation cannot unmount its local UI halfway through the flow.
     * @param reason Exact authentication requirement to present.
     * @param options Optional identity and interaction cancellation binding.
     * @returns A payload-free interaction lease, or undefined without an exact identity.
     */
    prepareProtectedInteraction(
        reason: ContractAuthenticationErrorReason,
        { identity, signal }: SecurityVerificationRequestOptions = {}
    ): SecurityVerificationWaiterLease | undefined {
        return this.#requestWaiter(reason, "interaction", { identity, signal });
    }

    #requestWaiter(
        reason: ContractAuthenticationErrorReason,
        kind: VerificationWaiter["kind"],
        { identity, signal }: SecurityVerificationRequestOptions
    ): SecurityVerificationWaiterLease | undefined {
        this.#refreshAuthenticationIdentity();
        const operation = authenticatedOperationForSignal(signal);
        const operationIdentity = operation?.identity;
        if (
            identity !== undefined &&
            operationIdentity !== undefined &&
            identity !== operationIdentity
        ) {
            return undefined;
        }
        const boundIdentity =
            identity ?? operationIdentity ?? this.#authenticationIdentity;
        if (
            boundIdentity === undefined ||
            (this.#authenticationIdentity !== undefined &&
                boundIdentity !== this.#authenticationIdentity)
        ) {
            return undefined;
        }
        if (signal?.aborted === true) return this.#cancelledLease();
        if (this.#phase === "idle") {
            this.#beginFlow(reason, boundIdentity);
        } else if (
            this.#identity !== boundIdentity ||
            this.#phase === "cache-reset" ||
            this.#phase === "reconciling"
        ) {
            return undefined;
        } else if (
            this.#phase === "replaying" &&
            kind === "request" &&
            this.#interactionWaiterCount() > 0
        ) {
            // A long-running protected interaction may hold reconciliation after its
            // proof. A later server rejection must fail closed instead of borrowing
            // that earlier proof as if it were an already-blocked transport request.
            return undefined;
        } else if (reason === "mfa_enrollment_required" && this.#reason !== reason) {
            this.#reason = reason;
            this.#publishSnapshot();
        }

        const outcome = Promise.withResolvers<"cancelled" | "verified">();
        const waiter: VerificationWaiter = {
            generation: this.#generation,
            id: Symbol("security-verification-waiter"),
            kind,
            operation,
            outcome,
            released: false,
            settled: false,
        };
        if (kind === "interaction") this.#protectedInteraction = true;
        this.#waiters.set(waiter.id, waiter);
        const abort = () => this.#cancelWaiter(waiter);
        signal?.addEventListener("abort", abort, { once: true });
        if (this.#phase === "replaying") this.#verifyWaiter(waiter);
        this.#publishSnapshot();
        this.#wakeReplayDrain();
        return Object.freeze({
            outcome: outcome.promise,
            releaseAfterAttempt: () => {
                signal?.removeEventListener("abort", abort);
                this.#releaseWaiter(waiter);
            },
        });
    }

    /**
     * Opens one proactive expiry prompt without manufacturing a transport request.
     * @param reason Exact authentication requirement to present.
     * @param identity Auth identity whose server-relative freshness expired.
     * @returns Whether that identity owns the active prompt.
     */
    promptProactively(
        reason: ContractAuthenticationErrorReason,
        identity?: string
    ): boolean {
        this.#refreshAuthenticationIdentity();
        identity ??= this.#authenticationIdentity;
        if (identity === undefined) return false;
        if (this.#phase === "idle") {
            this.#beginFlow(reason, identity);
            return true;
        }
        if (
            (this.#phase === "prompting" || this.#phase === "verifying") &&
            this.#identity === identity
        ) {
            if (reason === "mfa_enrollment_required" && this.#reason !== reason) {
                this.#reason = reason;
                this.#publishSnapshot();
            }
            return true;
        }
        return false;
    }

    /** @returns Whether the current prompt entered active proof. */
    beginProof(): boolean {
        if (this.#phase !== "prompting") return false;
        this.#phase = "verifying";
        this.#publishSnapshot();
        return true;
    }

    /** @returns Whether an active proof returned to its prompt. */
    failProof(): boolean {
        if (this.#phase !== "verifying") return false;
        this.#phase = "prompting";
        this.#publishSnapshot();
        return true;
    }

    /**
     * Releases every exact waiter once, then resolves after all replay leases and
     * associated authenticated mutation-boundary operations finish.
     * @returns Whether the same verification generation drained successfully.
     */
    completeProof(): Promise<boolean> {
        if (this.#phase !== "verifying") return Promise.resolve(false);
        const generation = this.#generation;
        if (this.#timeout !== undefined) clearTimeout(this.#timeout);
        this.#timeout = undefined;
        this.#phase = "replaying";
        for (const waiter of this.#waiters.values()) this.#verifyWaiter(waiter);
        this.#publishSnapshot();
        return this.#waitForReplayDrain(generation);
    }

    /** Cancels blocked requests without authorizing a retry. */
    dismiss(): void {
        if (this.#phase === "prompting" || this.#phase === "verifying") {
            this.#cancelFlow();
        }
    }

    /**
     * Fails closed and releases coordinator-owned holds in any active phase.
     * Already-dispatched transport retries remain governed by their own abort signals.
     * @returns Whether an active flow was aborted.
     */
    abortActiveFlow(): boolean {
        if (this.#phase === "idle") return false;
        this.#cancelFlow();
        return true;
    }

    /**
     * Marks the exact post-replay identity expected from the cache reset.
     * @param identity Final server-resolved authentication identity.
     * @returns Whether reconciliation entered its planned cache reset.
     */
    beginCacheReset(identity: string): boolean {
        if (this.#phase !== "reconciling") return false;
        this.#cacheResetIdentity = identity;
        this.#phase = "cache-reset";
        this.#publishSnapshot();
        return true;
    }

    /**
     * Completes only the planned cache reset and rejects stale reset callbacks.
     * @param identity Identity reported by the completed cache reset.
     * @returns Whether the active flow was completed.
     */
    acknowledgeCacheReset(identity: string): boolean {
        if (this.#phase !== "cache-reset" || identity !== this.#cacheResetIdentity) {
            return false;
        }
        this.#authenticationIdentity = identity;
        const flowCompletion = this.#flowCompletion;
        this.#resetFlow();
        flowCompletion?.resolve("completed");
        return true;
    }

    /** @returns Completion of the current planned cache reset or cancellation. */
    waitForCacheReset(): Promise<SecurityVerificationFlowCompletion> {
        return this.#flowCompletion?.promise ?? Promise.resolve("cancelled");
    }

    #beginFlow(reason: ContractAuthenticationErrorReason, identity: string): void {
        this.#generation += 1;
        this.#identity = identity;
        this.#reason = reason;
        this.#phase = "prompting";
        this.#flowCompletion =
            Promise.withResolvers<SecurityVerificationFlowCompletion>();
        const generation = this.#generation;
        this.#timeout = setTimeout(() => {
            if (this.#generation === generation) this.#cancelFlow();
        }, securityVerificationTimeoutMs);
        this.#publishSnapshot();
    }

    #cancelFlow(): void {
        const flowCompletion = this.#flowCompletion;
        for (const waiter of this.#waiters.values()) {
            if (!waiter.settled) {
                waiter.settled = true;
                waiter.outcome.resolve("cancelled");
            }
        }
        this.#waiters.clear();
        this.#wakeReplayDrain();
        this.#resetFlow();
        flowCompletion?.resolve("cancelled");
    }

    #cancelWaiter(waiter: VerificationWaiter): void {
        if (waiter.released || waiter.generation !== this.#generation) return;
        if (!waiter.settled) {
            waiter.settled = true;
            waiter.outcome.resolve("cancelled");
        }
        this.#releaseWaiter(waiter);
        if (
            this.#waiters.size === 0 &&
            (this.#phase === "prompting" || this.#phase === "verifying")
        ) {
            this.#cancelFlow();
        }
    }

    #cancelledLease(): SecurityVerificationWaiterLease {
        return Object.freeze({
            outcome: Promise.resolve("cancelled" as const),
            releaseAfterAttempt() {},
        });
    }

    #createSnapshot(): SecurityVerificationSnapshot {
        return Object.freeze({
            authenticationIdentity: this.#authenticationIdentity,
            generation: this.#generation,
            identity: this.#identity,
            pendingInteractionCount: this.#interactionWaiterCount(),
            pendingRequestCount: this.#requestWaiterCount(),
            phase: this.#phase,
            presenterClaimed: this.#presenterClaimed,
            protectedInteraction: this.#protectedInteraction,
            reason: this.#reason,
        });
    }

    #interactionWaiterCount(): number {
        let count = 0;
        for (const waiter of this.#waiters.values()) {
            if (waiter.kind === "interaction") count += 1;
        }
        return count;
    }

    #requestWaiterCount(): number {
        let count = 0;
        for (const waiter of this.#waiters.values()) {
            if (waiter.kind === "request") count += 1;
        }
        return count;
    }

    #publishSnapshot(): void {
        this.#snapshot = this.#createSnapshot();
        for (const listener of this.#listeners) listener();
    }

    #refreshAuthenticationIdentity(): void {
        const resolvedIdentity = this.#resolveAuthenticationIdentity();
        if (resolvedIdentity !== this.#authenticationIdentity) {
            this.setAuthenticationIdentity(resolvedIdentity);
        }
    }

    #resolveAuthenticationIdentity(): string | undefined {
        try {
            return this.#getAuthenticationIdentity();
        } catch {
            return this.#authenticationIdentity;
        }
    }

    #releaseWaiter(waiter: VerificationWaiter): void {
        if (waiter.released) return;
        waiter.released = true;
        if (this.#waiters.get(waiter.id) === waiter) {
            this.#waiters.delete(waiter.id);
        }
        this.#publishSnapshot();
        this.#wakeReplayDrain();
    }

    #resetFlow(): void {
        if (this.#timeout !== undefined) clearTimeout(this.#timeout);
        this.#timeout = undefined;
        this.#cacheResetIdentity = undefined;
        this.#flowCompletion = undefined;
        this.#identity = undefined;
        this.#pendingOperationCompletions.clear();
        this.#phase = "idle";
        this.#protectedInteraction = false;
        this.#reason = undefined;
        this.#waiters.clear();
        this.#wakeReplayDrain();
        this.#publishSnapshot();
    }

    #trackOperationCompletion(operation: AuthenticatedOperationToken | undefined): void {
        const completion = operation?.completion;
        if (
            completion === undefined ||
            this.#pendingOperationCompletions.has(completion)
        ) {
            return;
        }
        this.#pendingOperationCompletions.add(completion);
        void completion.then(() => {
            this.#pendingOperationCompletions.delete(completion);
            this.#wakeReplayDrain();
            return true;
        });
    }

    #verifyWaiter(waiter: VerificationWaiter): void {
        if (waiter.settled || waiter.released) return;
        waiter.settled = true;
        this.#trackOperationCompletion(waiter.operation);
        waiter.outcome.resolve("verified");
    }

    async #waitForReplayDrain(generation: number): Promise<boolean> {
        while (this.#generation === generation && this.#phase === "replaying") {
            if (
                this.#waiters.size === 0 &&
                this.#pendingOperationCompletions.size === 0
            ) {
                this.#phase = "reconciling";
                this.#publishSnapshot();
                return true;
            }
            const wake = Promise.withResolvers<void>();
            this.#replayWake = wake;
            await wake.promise;
            if (this.#replayWake === wake) this.#replayWake = undefined;
        }
        return false;
    }

    #wakeReplayDrain(): void {
        this.#replayWake?.resolve();
        this.#replayWake = undefined;
    }
}

/**
 * @param getAuthenticationIdentity Reads the current auth cache identity on demand.
 * @returns A fresh payload-free coordinator for one application/test lifetime.
 */
export function createSecurityVerificationCoordinator(
    getAuthenticationIdentity: () => string | undefined
): SecurityVerificationCoordinator {
    return new SecurityVerificationCoordinator(getAuthenticationIdentity);
}
