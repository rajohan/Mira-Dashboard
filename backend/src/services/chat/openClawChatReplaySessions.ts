import type {
    OpenClawRuntimeEnvelope,
    OpenClawRuntimeSnapshot,
} from "../../../../contracts/chat/transport.ts";
import type { OpenClawChatCompactionSettlements } from "./openClawChatCompactionSettlements.ts";
import {
    isAgentSessionKey,
    isExactSessionKey,
    isSameSessionKey,
    normalizedSessionKey,
    OpenClawChatIdentityRegistry,
} from "./openClawChatIdentity.ts";
import type { OpenClawChatRuntimeMetricsRecorder } from "./openClawChatMetrics.ts";
import {
    MAX_CHAT_RUNTIME_SESSIONS,
    type OpenClawChatPersistenceCoordinator,
} from "./openClawChatPersistence.ts";
import type {
    OpenClawChatRequestBoundaries,
    OpenClawChatRequestBoundaryMetadata,
} from "./openClawChatRequestBoundaries.ts";
import {
    ACTIVE_RUN_TTL_MS,
    oldestEvictableSessionKey,
    oldestReplayBudgetSessionKey,
    replayBytes,
    snapshotFromRetainedRuns,
    type RetainedRun,
} from "./openClawChatRetention.ts";
import type { OpenClawChatRunReconciliation } from "./openClawChatRunReconciliation.ts";
import { OpenClawChatSessionPromotion } from "./openClawChatSessionPromotion.ts";

interface OpenClawChatReplaySessionsOptions {
    advanceSequence: (sequence: number) => void;
    compactionSettlements: OpenClawChatCompactionSettlements;
    currentSequence: () => number;
    identity: OpenClawChatIdentityRegistry;
    maxReplayBytes: number;
    metrics: OpenClawChatRuntimeMetricsRecorder;
    now: () => number;
    persistence: OpenClawChatPersistenceCoordinator;
    requestBoundaries: OpenClawChatRequestBoundaries;
    retain: (envelope: OpenClawRuntimeEnvelope, shouldPersist: boolean) => string[];
    runReconciliation: OpenClawChatRunReconciliation;
    runsBySession: Map<string, Map<string, RetainedRun>>;
}

/** Owns replay hydration, alias promotion, and in-memory session budgets. */
export class OpenClawChatReplaySessions {
    readonly #advanceSequence: (sequence: number) => void;
    readonly #compactionSettlements: OpenClawChatCompactionSettlements;
    readonly #currentSequence: () => number;
    readonly #identity: OpenClawChatIdentityRegistry;
    readonly #maxReplayBytes: number;
    readonly #metrics: OpenClawChatRuntimeMetricsRecorder;
    readonly #now: () => number;
    readonly #persistence: OpenClawChatPersistenceCoordinator;
    readonly #requestBoundaries: OpenClawChatRequestBoundaries;
    readonly #retain: (
        envelope: OpenClawRuntimeEnvelope,
        shouldPersist: boolean
    ) => string[];
    readonly #runReconciliation: OpenClawChatRunReconciliation;
    readonly #runsBySession: Map<string, Map<string, RetainedRun>>;
    readonly #sessionPromotion: OpenClawChatSessionPromotion;
    #enforcingReplayMemoryLimit = false;
    #replayMemoryLimitDeferrals = 0;
    #sessionLimitDeferrals = 0;
    #totalReplayBytes = 0;

    constructor(options: OpenClawChatReplaySessionsOptions) {
        this.#advanceSequence = options.advanceSequence;
        this.#compactionSettlements = options.compactionSettlements;
        this.#currentSequence = options.currentSequence;
        this.#identity = options.identity;
        this.#maxReplayBytes = options.maxReplayBytes;
        this.#metrics = options.metrics;
        this.#now = options.now;
        this.#persistence = options.persistence;
        this.#requestBoundaries = options.requestBoundaries;
        this.#retain = options.retain;
        this.#runReconciliation = options.runReconciliation;
        this.#runsBySession = options.runsBySession;
        this.#sessionPromotion = new OpenClawChatSessionPromotion({
            compactionSettlements: this.#compactionSettlements,
            currentSequence: this.#currentSequence,
            enforceReplayMemoryLimit: (protectedSessionKey) =>
                this.enforceReplayMemoryLimit(protectedSessionKey),
            enforceSessionLimit: (protectedSessionKey) =>
                this.enforceSessionLimit(protectedSessionKey),
            ensureCanonicalDestinationLoaded: (canonicalSessionKey) =>
                this.#ensureCanonicalDestinationLoaded(canonicalSessionKey),
            identity: this.#identity,
            persistence: this.#persistence,
            requestBoundaries: this.#requestBoundaries,
            runReconciliation: this.#runReconciliation,
            runsBySession: this.#runsBySession,
        });
    }

    get currentReplayBytes(): number {
        return this.#totalReplayBytes;
    }

    get maxReplayBytes(): number {
        return this.#maxReplayBytes;
    }

    #withDeferredSessionLimit<T>(operation: () => T): T {
        this.#sessionLimitDeferrals += 1;
        try {
            return operation();
        } finally {
            this.#sessionLimitDeferrals -= 1;
        }
    }

    ensureSessionLoaded(sessionKey: string): boolean {
        if (!this.#persistence.enabled) {
            return true;
        }
        const storageSessionKey = normalizedSessionKey(sessionKey);
        if (!this.#persistence.prepareSession(storageSessionKey)) {
            return false;
        }
        if (this.#persistence.isHydratedLookup(storageSessionKey)) {
            return true;
        }
        const storedKeys = this.#persistence.storedSessionKeys();
        if (!storedKeys) {
            return false;
        }
        const exactKey = storedKeys.find((candidate) =>
            isExactSessionKey(candidate, storageSessionKey)
        );
        const matchingKeys = exactKey
            ? [exactKey]
            : storedKeys.filter((candidate) =>
                  isSameSessionKey(candidate, storageSessionKey)
              );
        if (matchingKeys.length === 0) {
            this.#persistence.markHydratedLookup(storageSessionKey);
            return true;
        }
        if (matchingKeys.length !== 1) {
            return false;
        }
        const storedKey = matchingKeys[0]!;
        const storedStorageKey = normalizedSessionKey(storedKey);
        if (this.#persistence.hasPendingDelete(storedKey)) {
            return (
                this.#persistence.prepareSession(storedKey) &&
                this.ensureSessionLoaded(sessionKey)
            );
        }
        this.#persistence.markHydratedLookup(storageSessionKey);
        if (this.#persistence.isLoaded(storedStorageKey)) {
            const requiresCanonicalPromotion =
                storedStorageKey !== storageSessionKey &&
                isAgentSessionKey(storageSessionKey);
            if (
                requiresCanonicalPromotion &&
                !this.promoteSessionEntry(
                    storedStorageKey,
                    storageSessionKey,
                    undefined,
                    storageSessionKey
                )
            ) {
                this.#persistence.forgetHydratedLookup(storageSessionKey);
                return false;
            }
            return true;
        }
        const loadResult = this.#persistence.load(storedKey);
        if (!loadResult.ok) {
            this.#persistence.forgetHydratedLookup(storageSessionKey);
            return false;
        }
        const { snapshot } = loadResult;
        if (!snapshot) {
            return true;
        }
        this.#advanceSequence(snapshot.throughSequence);
        this.#requestBoundaries.restore(storedStorageKey, snapshot);
        const sortedEvents = snapshot.events.toSorted(
            (left, right) => left.runtimeSequence - right.runtimeSequence
        );
        this.#withDeferredSessionLimit(() => {
            for (const envelope of sortedEvents) {
                this.#advanceSequence(envelope.runtimeSequence);
                this.#retain(envelope, false);
            }
        });
        const hydratedRuns = this.#runsBySession.get(storedStorageKey);
        const firstSequenceEntries = Object.entries(snapshot.firstSequenceByRun || {});
        for (const [runId, firstSequenceValue] of firstSequenceEntries) {
            const hydratedRun = hydratedRuns?.get(runId);
            if (hydratedRun) {
                hydratedRun.firstSequence = Math.min(
                    hydratedRun.firstSequence,
                    firstSequenceValue
                );
            }
        }
        const interruptedRunEntries = Object.entries(snapshot.interruptedAtByRun || {});
        for (const [runId, interruptedAt] of interruptedRunEntries) {
            const hydratedRun = hydratedRuns?.get(runId);
            if (!hydratedRun) {
                continue;
            }
            hydratedRun.interruptionEligible = true;
            hydratedRun.interruptedAt = interruptedAt;
            this.#compactionSettlements.clearTimer(storedStorageKey, runId);
        }
        const repairedRunIdentity = hydratedRuns
            ? this.#runReconciliation.repairInterruptedRunSplit(
                  storedStorageKey,
                  hydratedRuns
              )
            : undefined;
        if (repairedRunIdentity) {
            for (const interruptedRunId of repairedRunIdentity.interruptedRunIds) {
                this.#identity.forgetRunSession(interruptedRunId, storedStorageKey);
            }
            this.#identity.rememberRunSession(
                repairedRunIdentity.providerRunId,
                storedStorageKey
            );
            this.#compactionSettlements.rescheduleForSession(storedStorageKey);
        }
        const prunedStaleRun = this.pruneStaleActiveRuns(storedStorageKey);
        if (prunedStaleRun && !this.#runsBySession.has(storedStorageKey)) {
            const didPersist = this.#persistence.flushSession(storedStorageKey);
            if (!didPersist) {
                this.#persistence.forgetHydratedLookup(storageSessionKey);
            }
            this.enforceSessionLimit(storageSessionKey);
            return didPersist;
        }
        if (
            storedStorageKey !== storageSessionKey &&
            isAgentSessionKey(storageSessionKey)
        ) {
            if (
                !this.promoteSessionEntry(
                    storedStorageKey,
                    storageSessionKey,
                    undefined,
                    storageSessionKey
                )
            ) {
                this.#persistence.forgetHydratedLookup(storageSessionKey);
                this.enforceSessionLimit(storedStorageKey);
                return false;
            }
            return true;
        }
        this.enforceSessionLimit(storedStorageKey);
        if (
            (prunedStaleRun || repairedRunIdentity) &&
            !this.#persistence.flushSession(storedStorageKey)
        ) {
            this.#persistence.forgetHydratedLookup(storageSessionKey);
            return false;
        }
        return true;
    }

    ensureEquivalentSessionsLoaded(sessionKey: string): boolean {
        if (!this.ensureSessionLoaded(sessionKey)) {
            return false;
        }
        const storedKeys = this.#persistence.storedSessionKeys();
        return Boolean(
            storedKeys?.every(
                (candidateSessionKey) =>
                    !isSameSessionKey(candidateSessionKey, sessionKey) ||
                    this.ensureSessionLoaded(candidateSessionKey)
            )
        );
    }

    pruneStaleActiveRuns(sessionKey: string, now = this.#now()): boolean {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const runs = this.#runsBySession.get(storageSessionKey);
        if (!runs) {
            return false;
        }
        let hasChanged = false;
        for (const [runId, run] of runs) {
            // Completed replay is the durable "last run" view and is intentionally
            // retained until a successful new send replaces it. The TTL only
            // recovers abandoned active runs after a missing lifecycle end.
            const latestActivityAt = Math.max(
                run.updatedAt,
                run.interruptedAt ?? -Infinity
            );
            if (run.completed || now - latestActivityAt <= ACTIVE_RUN_TTL_MS) {
                continue;
            }
            this.#compactionSettlements.clearTimer(storageSessionKey, runId);
            runs.delete(runId);
            this.#identity.forgetRunSession(runId, sessionKey);
            hasChanged = true;
        }
        if (runs.size === 0) {
            this.#runsBySession.delete(storageSessionKey);
        }
        if (hasChanged) {
            this.refreshTotalReplayBytes();
        }
        return hasChanged;
    }

    #snapshotFromRuns(
        runs: ReadonlyMap<string, RetainedRun> | undefined,
        shouldIncludePersistenceMetadata = false,
        requestBoundaries: OpenClawChatRequestBoundaryMetadata = {}
    ): OpenClawRuntimeSnapshot {
        return snapshotFromRetainedRuns(
            runs,
            this.#currentSequence(),
            shouldIncludePersistenceMetadata,
            requestBoundaries
        );
    }

    snapshotFromMemory(
        sessionKey: string,
        shouldIncludePersistenceMetadata = false
    ): OpenClawRuntimeSnapshot {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        return this.#snapshotFromRuns(
            this.#runsBySession.get(storageSessionKey),
            shouldIncludePersistenceMetadata,
            shouldIncludePersistenceMetadata
                ? this.#requestBoundaries.metadata(storageSessionKey)
                : {}
        );
    }

    evictSessionFromMemory(sessionKey: string, reason?: "memory" | "session"): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const evictedBytes = replayBytes(
            this.#runsBySession.get(storageSessionKey)?.values() || []
        );
        this.#persistence.cancelPendingSession(storageSessionKey);
        this.#compactionSettlements.clearTimersForSession(storageSessionKey);
        this.#runsBySession.delete(storageSessionKey);
        this.#requestBoundaries.forgetExact(storageSessionKey);
        this.#totalReplayBytes = Math.max(0, this.#totalReplayBytes - evictedBytes);
        this.#identity.forgetSession(storageSessionKey);
        this.#persistence.forgetMemorySession(storageSessionKey);
        if (reason) {
            this.#metrics.recordEviction(reason);
        }
    }

    clearCompletedRuns(sessionKey: string, preservedRunId?: string): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const runs = this.#runsBySession.get(storageSessionKey);
        if (!runs) {
            return;
        }
        for (const [runId, run] of runs) {
            if (runId === preservedRunId || !run.completed) {
                continue;
            }
            this.#compactionSettlements.clearTimer(storageSessionKey, runId);
            runs.delete(runId);
            this.#identity.forgetRunSession(runId, storageSessionKey);
        }
        if (runs.size === 0) {
            this.#runsBySession.delete(storageSessionKey);
        }
        this.refreshTotalReplayBytes();
        this.#persistence.flushSession(storageSessionKey);
    }

    #ensureCanonicalDestinationLoaded(canonicalSessionKey: string): boolean {
        if (!this.#persistence.enabled) {
            return true;
        }
        const storageSessionKey = normalizedSessionKey(canonicalSessionKey);
        const storedKeys = this.#persistence.storedSessionKeys();
        if (!storedKeys) {
            return false;
        }
        const storedCanonicalKey = storedKeys.find((candidate) =>
            isExactSessionKey(candidate, storageSessionKey)
        );
        const storedCanonicalStorageKey = storedCanonicalKey
            ? normalizedSessionKey(storedCanonicalKey)
            : undefined;
        if (
            !storedCanonicalKey ||
            (storedCanonicalStorageKey &&
                this.#persistence.isLoaded(storedCanonicalStorageKey))
        ) {
            return true;
        }
        this.#withDeferredSessionLimit(() =>
            this.ensureSessionLoaded(storedCanonicalKey)
        );
        return Boolean(
            storedCanonicalStorageKey &&
            this.#persistence.isLoaded(storedCanonicalStorageKey)
        );
    }

    promoteSessionEntry(
        sourceSessionKey: string,
        canonicalSessionKey: string,
        preferredRunId?: string,
        protectedSessionKey?: string
    ): boolean {
        return this.#sessionPromotion.promoteSessionEntry(
            sourceSessionKey,
            canonicalSessionKey,
            preferredRunId,
            protectedSessionKey
        );
    }
    refreshTotalReplayBytes(): void {
        let totalBytes = 0;
        for (const runs of this.#runsBySession.values()) {
            totalBytes += replayBytes(runs.values());
        }
        this.#totalReplayBytes = totalBytes;
        this.#metrics.observeReplayBytes(totalBytes);
    }

    enforceReplayMemoryLimit(protectedSessionKey?: string): void {
        if (this.#enforcingReplayMemoryLimit || this.#replayMemoryLimitDeferrals > 0) {
            return;
        }
        const storageProtectedSessionKey = protectedSessionKey
            ? normalizedSessionKey(protectedSessionKey)
            : undefined;
        this.#enforcingReplayMemoryLimit = true;
        try {
            this.refreshTotalReplayBytes();
            while (this.#totalReplayBytes > this.#maxReplayBytes) {
                const oldestSessionKey =
                    oldestReplayBudgetSessionKey(
                        this.#runsBySession,
                        isSameSessionKey,
                        storageProtectedSessionKey
                    ) ??
                    oldestReplayBudgetSessionKey(this.#runsBySession, isSameSessionKey);
                if (!oldestSessionKey) {
                    break;
                }
                // Keep the freshest persisted copy before releasing process memory.
                // The hard memory ceiling still wins if SQLite is temporarily failing.
                this.#persistence.flushSession(oldestSessionKey);
                this.evictSessionFromMemory(oldestSessionKey, "memory");
            }
        } finally {
            this.#enforcingReplayMemoryLimit = false;
        }
    }

    enforceSessionLimit(protectedSessionKey?: string): void {
        if (this.#sessionLimitDeferrals > 0) {
            return;
        }
        const storageProtectedSessionKey = protectedSessionKey
            ? normalizedSessionKey(protectedSessionKey)
            : undefined;
        while (this.#runsBySession.size > MAX_CHAT_RUNTIME_SESSIONS) {
            const oldestSessionKey = oldestEvictableSessionKey(
                this.#runsBySession,
                isSameSessionKey,
                storageProtectedSessionKey
            );
            if (!oldestSessionKey) {
                break;
            }
            this.evictSessionFromMemory(oldestSessionKey, "session");
            this.#persistence.deleteSession(oldestSessionKey);
        }
    }

    clearMemory(): void {
        this.#runsBySession.clear();
        this.#totalReplayBytes = 0;
    }

    hydratePersistedSessions(): void {
        const storedKeys = this.#persistence.storedSessionKeys();
        if (!storedKeys) {
            return;
        }
        this.#withDeferredSessionLimit(() => {
            for (const sessionKey of storedKeys) {
                this.ensureSessionLoaded(sessionKey);
            }
        });
        this.enforceSessionLimit();
        this.enforceReplayMemoryLimit();
    }

    snapshot(sessionKey: string): OpenClawRuntimeSnapshot {
        this.#replayMemoryLimitDeferrals += 1;
        try {
            this.ensureSessionLoaded(sessionKey);
            if (this.pruneStaleActiveRuns(sessionKey)) {
                this.#persistence.queueSession(sessionKey);
            }
            return this.snapshotFromMemory(sessionKey);
        } finally {
            this.#replayMemoryLimitDeferrals -= 1;
            this.enforceReplayMemoryLimit(sessionKey);
        }
    }
}
