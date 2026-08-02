import type { OpenClawRuntimeEnvelope } from "../../../../contracts/chat/transport.ts";
import {
    isSameSessionKey,
    normalizedSessionKey,
    type OpenClawChatIdentityRegistry,
} from "./openClawChatIdentity.ts";
import type { OpenClawChatPersistenceCoordinator } from "./openClawChatPersistence.ts";
import {
    asRecord,
    runtimePayloadView,
    stringField,
} from "./openClawChatProviderAdapter.ts";
import type { OpenClawChatReplaySessions } from "./openClawChatReplaySessions.ts";
import type { OpenClawChatRequestBoundaries } from "./openClawChatRequestBoundaries.ts";
import {
    firstSequence,
    hasActiveConversationRun,
    lastSequence,
    type RetainedRun,
} from "./openClawChatRetention.ts";
import {
    isActiveConversationAtBoundary,
    isProvisionalRunId,
    sessionMessageRequestId,
    type RepairedInterruptedRun,
} from "./openClawChatRunIdentity.ts";
import type { OpenClawChatRunReconciliation } from "./openClawChatRunReconciliation.ts";

interface OpenClawChatRequestLifecycleOptions {
    currentSequence: () => number;
    identity: OpenClawChatIdentityRegistry;
    persistence: OpenClawChatPersistenceCoordinator;
    replaySessions: OpenClawChatReplaySessions;
    requestBoundaries: OpenClawChatRequestBoundaries;
    requireSequenceHydrated: () => void;
    runReconciliation: OpenClawChatRunReconciliation;
    runsBySession: Map<string, Map<string, RetainedRun>>;
    runtimeIdentityEnvelope: (
        sessionKey: string,
        repaired: RepairedInterruptedRun
    ) => OpenClawRuntimeEnvelope;
}

/** Owns outgoing chat request boundaries and their replay lifecycle. */
export class OpenClawChatRequestLifecycle {
    readonly #currentSequence: () => number;
    readonly #identity: OpenClawChatIdentityRegistry;
    readonly #persistence: OpenClawChatPersistenceCoordinator;
    readonly #replaySessions: OpenClawChatReplaySessions;
    readonly #requestBoundaries: OpenClawChatRequestBoundaries;
    readonly #requireSequenceHydrated: () => void;
    readonly #runReconciliation: OpenClawChatRunReconciliation;
    readonly #runsBySession: Map<string, Map<string, RetainedRun>>;
    readonly #runtimeIdentityEnvelope: OpenClawChatRequestLifecycleOptions["runtimeIdentityEnvelope"];

    constructor(options: OpenClawChatRequestLifecycleOptions) {
        this.#currentSequence = options.currentSequence;
        this.#identity = options.identity;
        this.#persistence = options.persistence;
        this.#replaySessions = options.replaySessions;
        this.#requestBoundaries = options.requestBoundaries;
        this.#requireSequenceHydrated = options.requireSequenceHydrated;
        this.#runReconciliation = options.runReconciliation;
        this.#runsBySession = options.runsBySession;
        this.#runtimeIdentityEnvelope = options.runtimeIdentityEnvelope;
    }

    #settleRequestBoundary(
        sessionKey: string,
        requestId: string | undefined,
        fallbackBoundary: number | undefined,
        isContinuation: boolean
    ): void {
        const changedSessionKeys = this.#requestBoundaries.settle(
            sessionKey,
            requestId,
            fallbackBoundary,
            isContinuation
        );
        for (const candidateSessionKey of changedSessionKeys) {
            if (this.#runsBySession.has(candidateSessionKey)) {
                this.#persistence.flushSession(candidateSessionKey);
            }
        }
    }

    clearSettledRequestBoundariesWithinRun(
        sessionKey: string,
        firstRunSequence: number
    ): void {
        const changedSessionKeys = this.#requestBoundaries.clearSettledWithinRun(
            sessionKey,
            firstRunSequence
        );
        for (const changedSessionKey of changedSessionKeys) {
            this.#persistence.queueSession(changedSessionKey);
        }
    }

    #requestContinuesExistingRun(
        sessionKey: string,
        runId: string | undefined,
        requestBoundary?: number
    ): boolean {
        if (requestBoundary === undefined) return false;
        const activeCandidates = new Map<string, RetainedRun>();
        for (const [candidateSessionKey, runs] of this.#runsBySession) {
            if (!isSameSessionKey(candidateSessionKey, sessionKey)) continue;
            if (runId) {
                const run = runs.get(runId);
                if (run) {
                    const isContinuation = firstSequence(run) <= requestBoundary;
                    if (isContinuation) {
                        this.clearSettledRequestBoundariesWithinRun(
                            sessionKey,
                            firstSequence(run)
                        );
                    }
                    return isContinuation;
                }
                continue;
            }
            const matchingRuns = runs
                .values()
                .filter((run) => isActiveConversationAtBoundary(run, requestBoundary));
            for (const run of matchingRuns) {
                const existing = activeCandidates.get(run.runId);
                if (!existing || lastSequence(run) > lastSequence(existing)) {
                    activeCandidates.set(run.runId, run);
                }
            }
        }
        if (runId || activeCandidates.size === 0) return false;
        const isContinuation =
            activeCandidates.size === 1 ||
            Boolean(
                this.#runReconciliation.interruptedRunSplitCandidate(
                    sessionKey,
                    activeCandidates
                )
            );
        if (isContinuation) {
            this.clearSettledRequestBoundariesWithinRun(
                sessionKey,
                Math.min(...activeCandidates.values().map((run) => firstSequence(run)))
            );
        }
        return isContinuation;
    }

    captureRequestBoundary(sessionKey?: string, requestId?: string): number {
        this.#requireSequenceHydrated();
        const sequence = this.#currentSequence();
        if (sessionKey) {
            if (!this.#replaySessions.ensureEquivalentSessionsLoaded(sessionKey)) {
                throw new Error("Chat send boundary session could not be hydrated");
            }
            const storageSessionKey = normalizedSessionKey(sessionKey);
            const boundarySessionKeys = this.#runsBySession
                .entries()
                .filter(
                    ([candidateSessionKey, runs]) =>
                        isSameSessionKey(candidateSessionKey, storageSessionKey) &&
                        hasActiveConversationRun(runs)
                )
                .map(([candidateSessionKey]) => candidateSessionKey)
                .toArray();
            if (
                boundarySessionKeys.some(
                    (boundarySessionKey) =>
                        !this.#requestBoundaries.canCapture(boundarySessionKey, requestId)
                )
            ) {
                throw new Error("Too many pending chat requests for one session");
            }
            for (const boundarySessionKey of boundarySessionKeys) {
                this.#requestBoundaries.capture(boundarySessionKey, requestId, sequence);
            }
            let didPersistAll = true;
            for (const boundarySessionKey of boundarySessionKeys) {
                if (!this.#persistence.flushSession(boundarySessionKey)) {
                    didPersistAll = false;
                }
            }
            if (!didPersistAll) {
                this.#settleRequestBoundary(storageSessionKey, requestId, sequence, true);
                throw new Error("Chat send boundary could not be persisted");
            }
        }
        return sequence;
    }

    clearSession(sessionKey: string): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const sessionKeys = new Set([storageSessionKey]);
        for (const candidateSessionKey of this.#runsBySession.keys()) {
            if (isSameSessionKey(candidateSessionKey, storageSessionKey)) {
                sessionKeys.add(candidateSessionKey);
            }
        }
        for (const candidateSessionKey of this.#persistence.pendingSessionKeys()) {
            if (isSameSessionKey(candidateSessionKey, storageSessionKey)) {
                sessionKeys.add(candidateSessionKey);
            }
        }
        this.#requestBoundaries.forget(storageSessionKey);
        this.#persistence.beginSessionClear(storageSessionKey);
        const storedSessionKeys = this.#persistence.storedSessionKeys();
        if (storedSessionKeys) {
            for (const candidateSessionKey of storedSessionKeys) {
                if (isSameSessionKey(candidateSessionKey, storageSessionKey)) {
                    sessionKeys.add(candidateSessionKey);
                }
            }
        }
        for (const matchingSessionKey of sessionKeys) {
            this.#replaySessions.evictSessionFromMemory(matchingSessionKey);
        }
        if (!this.#persistence.enabled) return;

        let didClearAll = storedSessionKeys !== undefined;
        for (const matchingSessionKey of sessionKeys) {
            if (!this.#persistence.deleteSession(matchingSessionKey)) didClearAll = false;
        }
        this.#persistence.finishSessionClear(storageSessionKey, didClearAll);
    }

    handleSuccessfulRequest(
        method: string,
        parameters: Record<string, unknown>,
        payload: unknown,
        requestBoundary?: number
    ): OpenClawRuntimeEnvelope | undefined {
        if (method === "chat.abort") {
            const sessionKey = stringField(parameters, "sessionKey");
            if (sessionKey) this.clearSession(sessionKey);
            return;
        }
        if (method === "sessions.delete") {
            const sessionKey = stringField(parameters, "key");
            if (sessionKey) this.clearSession(sessionKey);
            return;
        }
        if (method !== "chat.send") return;

        const sessionKey = stringField(parameters, "sessionKey");
        const message = stringField(parameters, "message");
        if (sessionKey && message && /^\/(?:new|reset)(?:\s|$)/i.test(message)) {
            this.clearSession(sessionKey);
            return;
        }
        const runId = stringField(asRecord(payload), "runId");
        const provisionalRunId = stringField(parameters, "idempotencyKey");
        if (!sessionKey) return;
        if (!this.#replaySessions.ensureEquivalentSessionsLoaded(sessionKey)) {
            // The provider accepted the send. Keep its durable pending boundary
            // until a matching user echo can hydrate and settle it.
            return;
        }
        const continuesExistingRun = this.#requestContinuesExistingRun(
            sessionKey,
            runId,
            requestBoundary
        );
        const pendingRequestBoundary = this.#requestBoundaries.pending(
            sessionKey,
            provisionalRunId,
            requestBoundary
        );
        if (
            !continuesExistingRun &&
            pendingRequestBoundary !== undefined &&
            (!runId || isProvisionalRunId(runId))
        ) {
            const changedSessionKeys = this.#requestBoundaries.acknowledge(
                sessionKey,
                provisionalRunId,
                requestBoundary
            );
            for (const changedSessionKey of changedSessionKeys) {
                if (this.#runsBySession.has(changedSessionKey)) {
                    this.#persistence.flushSession(changedSessionKey);
                }
            }
            const repaired =
                this.#runReconciliation.repairInterruptedRunForSession(sessionKey);
            return repaired
                ? this.#runtimeIdentityEnvelope(sessionKey, repaired)
                : undefined;
        }
        let acknowledgedRunId =
            runId || (continuesExistingRun ? undefined : provisionalRunId);
        if (acknowledgedRunId) {
            this.#runReconciliation.promoteProvisionalRun(
                sessionKey,
                acknowledgedRunId,
                provisionalRunId,
                requestBoundary
            );
        }
        this.#settleRequestBoundary(
            sessionKey,
            provisionalRunId,
            requestBoundary,
            continuesExistingRun
        );
        let repaired: RepairedInterruptedRun | undefined;
        if (!acknowledgedRunId && continuesExistingRun) {
            repaired = this.#runReconciliation.repairInterruptedRunForSession(sessionKey);
            acknowledgedRunId = repaired?.providerRunId;
        }
        this.#replaySessions.clearCompletedRuns(sessionKey, acknowledgedRunId);
        if (acknowledgedRunId) {
            this.#identity.rememberRunSession(acknowledgedRunId, sessionKey);
        }
        return repaired ? this.#runtimeIdentityEnvelope(sessionKey, repaired) : undefined;
    }

    handleFailedRequest(
        method: string,
        parameters: Record<string, unknown>,
        requestBoundary?: number
    ): void {
        if (method !== "chat.send") return;
        const sessionKey = stringField(parameters, "sessionKey");
        if (!sessionKey) return;
        this.#replaySessions.ensureEquivalentSessionsLoaded(sessionKey);
        this.#settleRequestBoundary(
            sessionKey,
            stringField(parameters, "idempotencyKey"),
            requestBoundary,
            true
        );
    }

    settleRequestEvent(
        event: unknown,
        enrichedPayload: unknown
    ): RepairedInterruptedRun | undefined {
        const sessionKey = stringField(asRecord(enrichedPayload), "sessionKey");
        const requestId = sessionMessageRequestId(event, enrichedPayload);
        if (!sessionKey || !requestId) return;
        const requestBoundary = this.#requestBoundaries.pending(sessionKey, requestId);
        if (requestBoundary === undefined) return;
        const runId = stringField(runtimePayloadView(enrichedPayload), "runId");
        const repair =
            this.#runReconciliation.repairAcknowledgedProvisionalContinuationForSession(
                sessionKey,
                runId,
                requestId,
                requestBoundary
            );
        const isContinuation =
            this.#requestContinuesExistingRun(sessionKey, runId, requestBoundary) ||
            Boolean(repair);
        this.#settleRequestBoundary(
            sessionKey,
            requestId,
            requestBoundary,
            isContinuation
        );
        return repair;
    }
}
